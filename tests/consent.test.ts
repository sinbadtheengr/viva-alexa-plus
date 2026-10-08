import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/auth/config.js";
import { Corpus } from "../src/exam/corpus.js";
import { silentLogger } from "../src/mcp/logging.js";
import { item } from "./fixtures.js";

/** GAP-016 · the consent form's default button must be Authorize. */

const PASSCODE = "consent-test-passcode";
const CLIENT_ID = "consent-client";
const REDIRECT_URI = "https://client.example/callback";
const HOSTILE_NAME = `<script>alert("x")</script> & 'Co'`;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function start(): Promise<string> {
  const auth = loadAuthConfig({
    VIVA_ISSUER_URL: "http://127.0.0.1:1",
    VIVA_RESOURCE_URL: "http://127.0.0.1:1/mcp",
    VIVA_DEMO_PASSCODE: PASSCODE,
    VIVA_OAUTH_CLIENTS: JSON.stringify([
      { client_id: CLIENT_ID, client_name: HOSTILE_NAME, redirect_uris: [REDIRECT_URI] },
    ]),
  } as NodeJS.ProcessEnv);
  const built = await createApp({ corpus: Corpus.fromItems([item()]), auth, logger: silentLogger });
  const server = built.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Starts an authorization request and returns its request id. */
async function pendingRid(origin: string): Promise<string> {
  const challenge = createHash("sha256").update(randomBytes(32)).digest("base64url");
  const url = new URL(`${origin}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: "http://127.0.0.1:1/mcp",
  }).toString();
  const res = await fetch(url, { redirect: "manual" });
  return new URL(res.headers.get("location")!, origin).searchParams.get("rid")!;
}

function post(origin: string, fields: Record<string, string>) {
  return fetch(`${origin}/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

describe("GAP-016 · consent screen default button", () => {
  it("renders Authorize as the first submit control, with Cancel still present", async () => {
    const origin = await start();
    const rid = await pendingRid(origin);
    const html = await fetch(`${origin}/consent?rid=${rid}`).then((r) => r.text());

    const buttons = [...html.matchAll(/<(?:button|input)\b[^>]*type="submit"[^>]*>/g)].map((m) => m[0]);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('value="approve"');
    expect(buttons[1]).toContain('value="deny"');
    expect(html).toContain(">Cancel</button>");
    expect(html).not.toMatch(/:hover/);
  });

  it("authorizes when the form is submitted with no button value (Enter in the field)", async () => {
    const origin = await start();
    const rid = await pendingRid(origin);

    // Browsers send the default button's name/value, i.e. action=approve.
    const html = await fetch(`${origin}/consent?rid=${rid}`).then((r) => r.text());
    const first = html.match(/<button[^>]*type="submit"[^>]*>/)![0];
    const action = first.match(/value="([^"]*)"/)![1]!;
    const viaDefaultButton = await post(origin, { rid, passcode: PASSCODE, action });
    const target = new URL(viaDefaultButton.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(REDIRECT_URI);
    expect(target.searchParams.get("code")).toBeTruthy();
    expect(target.searchParams.get("state")).toBe("st-1");

    // A submission carrying no action at all is not a denial either.
    const rid2 = await pendingRid(origin);
    const bare = await post(origin, { rid: rid2, passcode: PASSCODE });
    expect(new URL(bare.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("denies with access_denied to the redirect URI when Cancel is used", async () => {
    const origin = await start();
    const rid = await pendingRid(origin);

    const res = await post(origin, { rid, passcode: "", action: "deny" });

    const target = new URL(res.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(REDIRECT_URI);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("st-1");
    expect(target.searchParams.get("code")).toBeNull();
    // The request is spent.
    expect((await post(origin, { rid, passcode: PASSCODE, action: "approve" })).status).toBe(400);
  });

  it("re-renders with an error and issues no code on a wrong passcode", async () => {
    const origin = await start();
    const rid = await pendingRid(origin);

    const res = await post(origin, { rid, passcode: "wrong", action: "approve" });

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Incorrect passcode");
    expect(html).toMatch(/<button[^>]*value="approve"/);
    // Still usable with the right passcode afterwards.
    const ok = await post(origin, { rid, passcode: PASSCODE, action: "approve" });
    expect(new URL(ok.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("still escapes interpolated values", async () => {
    const origin = await start();
    const rid = await pendingRid(origin);

    const html = await fetch(`${origin}/consent?rid=${rid}`).then((r) => r.text());

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;");
  });
});

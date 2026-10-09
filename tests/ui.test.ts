import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig, type AuthConfig } from "../src/auth/config.js";
import { DEFAULT_LOCALE } from "../src/config.js";
import { Corpus } from "../src/exam/corpus.js";
import { silentLogger } from "../src/mcp/logging.js";
import { clientConfig, loadDemoConfig } from "../src/ui/demo.js";
// Plain browser module (no types): the same file the page loads.
import * as L from "../src/ui/public/lib.js";
import { item, unpreppedItem } from "./fixtures.js";

const PASSCODE = "open-sesame";
const CLIENT_ID = "viva-demo";

// --------------------------------------------------------------------------
// PKCE and OAuth request building
// --------------------------------------------------------------------------

describe("demo client · PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", async () => {
    const challenge = await L.codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("produces verifiers of 43+ unreserved characters, different each time", () => {
    const a = L.randomToken(32);
    const b = L.randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(a).not.toBe(b);
  });

  it("encodes base64url without padding or +/ characters", () => {
    expect(L.base64url(new Uint8Array([251, 255, 254]))).toBe("-__-");
    expect(L.base64url(new Uint8Array([1]))).toBe("AQ");
  });

  it("builds an authorize URL with S256, state and the RFC 8707 resource", () => {
    const url = new URL(
      L.buildAuthorizeUrl({
        authorizationEndpoint: "http://h/authorize",
        clientId: "c",
        redirectUri: "http://h/demo/",
        challenge: "ch",
        state: "st",
        resource: "http://h/mcp",
        scope: "exam progress",
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("resource")).toBe("http://h/mcp");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.has("code_verifier")).toBe(false);
  });

  it("puts the verifier and resource in the token request body", () => {
    const body = new URLSearchParams(
      L.buildTokenRequestBody({ code: "k", clientId: "c", redirectUri: "r", verifier: "v", resource: "http://h/mcp" }),
    );
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("v");
    expect(body.get("resource")).toBe("http://h/mcp");
  });

  it("accepts a code only when state matches", () => {
    expect(L.parseAuthorizationResponse("?code=abc&state=s", "s")).toEqual({ kind: "code", code: "abc" });
    expect(L.parseAuthorizationResponse("?code=abc&state=evil", "s")).toEqual({ kind: "error", error: "state_mismatch" });
    expect(L.parseAuthorizationResponse("?code=abc&state=s", null)).toEqual({ kind: "error", error: "state_mismatch" });
    expect(L.parseAuthorizationResponse("", "s")).toEqual({ kind: "none" });
    expect(L.parseAuthorizationResponse("?error=access_denied&state=s", "s")).toMatchObject({
      kind: "error",
      error: "access_denied",
    });
  });
});

// --------------------------------------------------------------------------
// JSON-RPC framing
// --------------------------------------------------------------------------

describe("demo client · JSON-RPC framing", () => {
  it("frames requests, notifications and tool calls", () => {
    expect(L.jsonRpcRequest(3, "x")).toEqual({ jsonrpc: "2.0", id: 3, method: "x" });
    expect(L.jsonRpcNotification("notifications/initialized")).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(L.toolCallRequest(4, "get_status", { sessionId: "s" })).toEqual({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_status", arguments: { sessionId: "s" } },
    });
    expect(L.initializeRequest(1, { name: "n", version: "1" }).params.protocolVersion).toBe("2025-11-25");
  });

  it("carries the bearer in the Authorization header and nowhere else", () => {
    const h = L.mcpHeaders({ token: "tok", sessionId: "sid" });
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(h["Mcp-Session-Id"]).toBe("sid");
    expect(h["MCP-Protocol-Version"]).toBe("2025-11-25");
    expect(h["Accept"]).toContain("text/event-stream");
    expect(L.mcpHeaders({})["Authorization"]).toBeUndefined();
  });

  it("parses a plain JSON body and a batch", () => {
    expect(L.parseResponseBody("application/json", '{"jsonrpc":"2.0","id":1,"result":{}}')).toHaveLength(1);
    expect(L.parseResponseBody("application/json", '[{"id":1,"result":{}},{"id":2,"result":{}}]')).toHaveLength(2);
    expect(L.parseResponseBody("application/json", "")).toEqual([]);
  });

  it("parses an SSE stream, including multi-line data and CRLF", () => {
    const sse = 'event: message\r\ndata: {"id":1,\r\ndata: "result":{"ok":true}}\r\n\r\nevent: message\r\ndata: {"id":2,"result":{}}\r\n\r\n';
    const messages = L.parseResponseBody("text/event-stream; charset=utf-8", sse);
    expect(messages).toEqual([{ id: 1, result: { ok: true } }, { id: 2, result: {} }]);
  });

  it("picks the response for an id and surfaces JSON-RPC errors", () => {
    expect(L.responseFor([{ id: 9, result: { a: 1 } }, { id: 2, result: { b: 2 } }], 2)).toEqual({ b: 2 });
    expect(() => L.responseFor([{ id: 2, error: { code: -32602, message: "bad" } }], 2)).toThrow("bad");
    expect(() => L.responseFor([], 2)).toThrow(/No JSON-RPC response/);
  });

  it("separates spoken text, structured data and the error flag", () => {
    const out = L.toolOutcome({
      content: [{ type: "text", text: "Hello" }, { type: "text", text: "World" }],
      structuredContent: { view: "clock" },
      isError: true,
    });
    expect(out).toEqual({ text: "Hello\nWorld", data: { view: "clock" }, isError: true });
    expect(L.toolOutcome({ content: [] })).toEqual({ text: "", data: {}, isError: false });
  });
});

// --------------------------------------------------------------------------
// Countdown arithmetic
// --------------------------------------------------------------------------

describe("demo client · countdown", () => {
  it("anchors a reading at the midpoint of the round trip", () => {
    expect(L.makeClockSync(60, 1000, 1100)).toEqual({ secondsRemaining: 60, anchoredAtMs: 1050 });
    expect(L.makeClockSync(null, 0, 1)).toBeNull();
  });

  it("counts down from the server reading and clamps at zero", () => {
    const sync = L.makeClockSync(10, 0, 0);
    expect(L.secondsLeft(sync, 0)).toBe(10);
    expect(L.secondsLeft(sync, 4000)).toBe(6);
    expect(L.secondsLeft(sync, 10_000)).toBe(0);
    expect(L.secondsLeft(sync, 25_000)).toBe(0);
    expect(L.secondsLeft(null, 0)).toBeNull();
  });

  it("reports seconds over once the clock runs out", () => {
    const sync = L.makeClockSync(10, 0, 0);
    expect(L.secondsOver(sync, 9_000)).toBe(0);
    expect(L.secondsOver(sync, 14_000)).toBe(4);
  });

  it("derives elapsed speaking time from the allowance", () => {
    const sync = L.makeClockSync(120, 0, 0);
    expect(L.elapsedSeconds(120, sync, 0)).toBe(0);
    expect(L.elapsedSeconds(120, sync, 30_000)).toBe(30);
    expect(L.elapsedSeconds(120, sync, 150_000)).toBe(150); // past the limit: keeps counting up
    expect(L.elapsedSeconds(120, null, 0)).toBeNull();
  });

  it("formats clocks: ceil for remaining, floor for elapsed", () => {
    expect(L.formatClock(65)).toBe("1:05");
    expect(L.formatClock(0.2)).toBe("0:01");
    expect(L.formatClock(0)).toBe("0:00");
    expect(L.formatClock(-5)).toBe("0:00");
    expect(L.formatElapsed(59.9)).toBe("0:59");
    expect(L.formatElapsed(125)).toBe("2:05");
  });

  it("resyncs sooner as the deadline approaches, never faster than 250ms", () => {
    const sync = L.makeClockSync(60, 0, 0);
    expect(L.nextSyncDelayMs(sync, 0)).toBe(5000);
    expect(L.nextSyncDelayMs(sync, 58_000)).toBe(2250);
    expect(L.nextSyncDelayMs(sync, 60_000)).toBe(250);
    expect(L.nextSyncDelayMs(null, 0)).toBe(5000);
  });

  it("honours pollAfterMs within sane bounds", () => {
    expect(L.pollDelayMs(1500)).toBe(1500);
    expect(L.pollDelayMs(5)).toBe(250);
    expect(L.pollDelayMs(999_999)).toBe(10_000);
    expect(L.pollDelayMs(undefined)).toBe(1500);
  });
});

describe("demo client · request log", () => {
  it("formats a latency line", () => {
    expect(L.formatLogLine({ tool: "get_status", ms: 12.4, ok: true, status: 200 })).toBe(
      "get_status  12 ms  HTTP 200  ok",
    );
  });

  it("summarises count, median and worst", () => {
    expect(L.summariseLatency([])).toEqual({ count: 0, medianMs: 0, maxMs: 0 });
    expect(L.summariseLatency([30, 10, 20])).toEqual({ count: 3, medianMs: 20, maxMs: 30 });
    expect(L.summariseLatency([10, 20, 30, 40])).toEqual({ count: 4, medianMs: 25, maxMs: 40 });
  });
});

// --------------------------------------------------------------------------
// Server side: config and static serving
// --------------------------------------------------------------------------

function authFor(origin: string, redirect = `${origin}/demo/`): AuthConfig {
  return loadAuthConfig({
    VIVA_ISSUER_URL: origin,
    VIVA_RESOURCE_URL: `${origin}/mcp`,
    VIVA_DEMO_PASSCODE: PASSCODE,
    VIVA_OAUTH_CLIENTS: JSON.stringify([
      { client_id: CLIENT_ID, client_name: "Viva Demo", redirect_uris: [redirect] },
    ]),
  } as NodeJS.ProcessEnv);
}

describe("demo client · server config", () => {
  const corpus = Corpus.fromItems([
    item(),
    unpreppedItem(),
    item({ id: "tcf.p2.travail.001", exam: "tcf", locale: "fr-FR", topic: "travail" }),
  ]);

  it("derives the redirect URI from the issuer and can be switched off", () => {
    const auth = authFor("http://127.0.0.1:8787");
    expect(loadDemoConfig(auth, {} as NodeJS.ProcessEnv)).toMatchObject({
      clientId: "viva-demo",
      redirectUri: "http://127.0.0.1:8787/demo/",
    });
    expect(loadDemoConfig(auth, { VIVA_DEMO_UI: "0" } as NodeJS.ProcessEnv)).toBeNull();
    expect(loadDemoConfig(auth, { VIVA_DEMO_CLIENT_ID: "x" } as NodeJS.ProcessEnv)?.clientId).toBe("x");
  });

  it("publishes the catalog from the corpus rather than hardcoding locales", () => {
    const auth = authFor("http://127.0.0.1:8787");
    const doc = clientConfig(loadDemoConfig(auth, {} as NodeJS.ProcessEnv)!, auth, corpus);
    const combos = doc.catalog.map((c) => `${c.exam}/${c.locale}`).sort();
    expect(combos).toEqual(["ielts/en-US", "tcf/fr-FR"]);
    const ielts = doc.catalog.find((c) => c.exam === "ielts")!;
    expect(Object.keys(ielts.parts).sort()).toEqual(["1", "2"]);
    expect(ielts.parts["2"]).toEqual(["work"]);
    expect(doc.resource).toBe("http://127.0.0.1:8787/mcp");
  });
});

// --------------------------------------------------------------------------
// The whole demo flow, against a live server, using the same lib the page uses
// --------------------------------------------------------------------------

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function startServer() {
  const corpus = Corpus.fromItems([item(), unpreppedItem()]);
  const probeApp = await createApp({ corpus, auth: authFor("http://127.0.0.1:1"), logger: silentLogger });
  const probe = probeApp.app.listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  await probeApp.close();

  const origin = `http://127.0.0.1:${port}`;
  const auth = authFor(origin);
  const demo = loadDemoConfig(auth, {} as NodeJS.ProcessEnv)!;
  const built = await createApp({ corpus, auth, logger: silentLogger, demo });
  const server = built.app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  servers.push(server);
  return { origin, auth, demo };
}

describe("demo client · live server", () => {
  it("serves the page, its modules and config.json same-origin", async () => {
    const { origin } = await startServer();

    const page = await fetch(`${origin}/demo/`);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("<title>Viva demo client</title>");
    expect(pageHtml).toContain(`<html lang="${DEFAULT_LOCALE}">`);
    expect(pageHtml).not.toContain("__VIVA_LANG__");

    for (const file of ["app.js", "lib.js", "style.css"]) {
      const res = await fetch(`${origin}/demo/${file}`);
      expect(res.status, file).toBe(200);
    }

    const cfg = (await (await fetch(`${origin}/demo/config.json`)).json()) as { clientId: string; authEnabled: boolean };
    expect(cfg).toMatchObject({ clientId: CLIENT_ID, authEnabled: true });

    // The demo does not widen the protected surface.
    expect((await fetch(`${origin}/mcp`, { method: "POST" })).status).toBe(401);
  });

  it("is absent unless enabled", async () => {
    const corpus = Corpus.fromItems([item()]);
    const built = await createApp({ corpus, auth: authFor("http://127.0.0.1:1"), logger: silentLogger });
    const server = built.app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    expect((await fetch(`http://127.0.0.1:${port}/demo/`)).status).toBe(404);
  });

  it("signs in with PKCE, then drives the exam tools with the lib's framing", async () => {
    const { origin, auth, demo } = await startServer();

    // --- OAuth, exactly as app.js does it ---
    const meta = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
    };
    const verifier = L.randomToken(32);
    const challenge = await L.codeChallengeS256(verifier);
    const state = L.randomToken(16);
    const authorize = await fetch(
      L.buildAuthorizeUrl({
        authorizationEndpoint: meta.authorization_endpoint,
        clientId: demo.clientId,
        redirectUri: demo.redirectUri,
        challenge,
        state,
        resource: auth.resourceUrl.href,
        scope: demo.scope,
      }),
      { redirect: "manual" },
    );
    expect(authorize.status).toBe(302);
    const rid = new URL(authorize.headers.get("location")!, origin).searchParams.get("rid")!;

    const consent = await fetch(`${origin}/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ rid, passcode: PASSCODE, action: "approve" }),
    });
    const back = new URL(consent.headers.get("location")!);
    expect(back.href.startsWith(demo.redirectUri)).toBe(true);
    const parsed = L.parseAuthorizationResponse(back.search, state);
    expect(parsed.kind).toBe("code");

    const tokenRes = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: L.buildTokenRequestBody({
        code: (parsed as { code: string }).code,
        clientId: demo.clientId,
        redirectUri: demo.redirectUri,
        verifier,
        resource: auth.resourceUrl.href,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const token = ((await tokenRes.json()) as { access_token: string }).access_token;

    // --- MCP, exactly as app.js does it ---
    let nextId = 1;
    let sessionId: string | null = null;
    const send = async (body: object, wantResponse = true) => {
      const res = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: L.mcpHeaders({ token, sessionId }),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { res, messages: wantResponse ? L.parseResponseBody(res.headers.get("content-type"), text) : [] };
    };
    const call = async (name: string, args: object = {}) => {
      const id = nextId++;
      const { messages } = await send(L.toolCallRequest(id, name, args));
      return L.toolOutcome(L.responseFor(messages, id));
    };

    const initId = nextId++;
    const init = await send(L.initializeRequest(initId, { name: "viva-demo-client", version: "0" }));
    L.responseFor(init.messages, initId);
    sessionId = init.res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect((await send(L.jsonRpcNotification("notifications/initialized"), false)).res.status).toBe(202);

    const started = await call("start_exam", { exam: "ielts", part: 2, locale: "en-US" });
    expect(started.data["view"]).toBe("cue_card");
    const sid = started.data["sessionId"] as string;

    const advanced = await call("advance_phase", { sessionId: sid });
    expect(advanced.data["phase"]).toBe("prep");

    // The clock comes from the server, and the lib interpolates it.
    const status = await call("get_status", { sessionId: sid });
    const sync = L.makeClockSync(status.data["secondsRemaining"] as number, 0, 0);
    expect(L.secondsLeft(sync, 0)).toBeGreaterThan(50);

    // A phase violation reaches the client as a tool error with the legal actions.
    const early = await call("submit_response", { sessionId: sid, transcript: "too early" });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/prep/);

    expect((await call("advance_phase", { sessionId: sid })).data["phase"]).toBe("speaking");
    const turn = await call("submit_response", { sessionId: sid, transcript: "I would like to talk about my teacher." });
    expect(turn.data["phase"]).toBe("followup");
    expect(typeof turn.text).toBe("string");

    expect((await call("score_session", { sessionId: sid })).data["status"]).toBe("pending");
    const results = await call("get_results", { sessionId: sid });
    // No grader is configured here: the honest answer is "unavailable", never a made-up band.
    expect(["pending", "unavailable"]).toContain(results.data["status"]);
    expect(JSON.stringify(results.data)).not.toMatch(/pronunciation":\s*\{/);

    const progress = await call("get_progress");
    expect(progress.data["view"]).toBe("progress");
  });
});

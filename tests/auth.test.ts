import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuthConfigError, loadAuthConfig, type AuthConfig } from "../src/auth/config.js";
import { VivaOAuthProvider } from "../src/auth/provider.js";
import { PASSCODE_SUBJECT } from "../src/auth/identity.js";
import { AuthStore, sha256 } from "../src/auth/store.js";
import { Corpus } from "../src/exam/corpus.js";
import { silentLogger } from "../src/mcp/logging.js";
import { fakeClock, item, unpreppedItem } from "./fixtures.js";

const PASSCODE = "open-sesame";
const CLIENT_ID = "alexa-plus-demo";
const REDIRECT_URI = "https://example.com/callback";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function configFor(origin: string): AuthConfig {
  return loadAuthConfig({
    VIVA_ISSUER_URL: origin,
    VIVA_RESOURCE_URL: `${origin}/mcp`,
    VIVA_DEMO_PASSCODE: PASSCODE,
    VIVA_OAUTH_CLIENTS: JSON.stringify([
      {
        client_id: CLIENT_ID,
        client_name: "Alexa+ Demo",
        redirect_uris: [REDIRECT_URI],
      },
    ]),
  } as NodeJS.ProcessEnv);
}

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

describe("F-9 · configuration fails closed", () => {
  it("refuses to start with auth enabled and no passcode", () => {
    expect(() => loadAuthConfig({} as NodeJS.ProcessEnv)).toThrow(AuthConfigError);
  });

  it("allows an explicitly disabled, passcode-less local setup", () => {
    const config = loadAuthConfig({ VIVA_AUTH_DISABLED: "1" } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
  });

  it("derives the resource identifier from the issuer by default", () => {
    const config = loadAuthConfig({
      VIVA_ISSUER_URL: "https://viva.example.com",
      VIVA_DEMO_PASSCODE: "x",
    } as NodeJS.ProcessEnv);
    expect(config.resourceUrl.href).toBe("https://viva.example.com/mcp");
  });

  it("rejects a malformed client list rather than starting with none", () => {
    expect(() =>
      loadAuthConfig({
        VIVA_DEMO_PASSCODE: "x",
        VIVA_OAUTH_CLIENTS: '[{"client_name":"no id"}]',
      } as NodeJS.ProcessEnv),
    ).toThrow(/client_id/);
  });
});

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

describe("F-9 · token store", () => {
  it("never holds a token in the clear", () => {
    const store = new AuthStore();
    const token = store.issueToken({ clientId: "c", subject: PASSCODE_SUBJECT, scopes: [], resource: undefined, kind: "access" }, 60);

    const dump = JSON.stringify(store, (_k, v) => (v instanceof Map ? [...v.entries()] : v));
    expect(dump).not.toContain(token);
    expect(store.readToken(token)).toBeTruthy();
  });

  it("hashes with sha256 so lookup is by digest", () => {
    expect(sha256("abc")).toHaveLength(64);
  });

  it("makes an authorization code single use", () => {
    const store = new AuthStore();
    const code = store.issueCode(
      {
        clientId: "c",
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "x",
        scopes: [],
        resource: undefined,
      },
      60,
    );

    expect(store.takeCode(code)).toBeTruthy();
    expect(store.takeCode(code)).toBeUndefined();
  });

  it("expires codes and tokens on the clock", () => {
    const clock = fakeClock();
    const store = new AuthStore(clock.now);
    const token = store.issueToken({ clientId: "c", subject: PASSCODE_SUBJECT, scopes: [], resource: undefined, kind: "access" }, 60);

    clock.advanceSeconds(61);

    expect(store.readToken(token)).toBeUndefined();
  });

  it("sweeps expired entries", () => {
    const clock = fakeClock();
    const store = new AuthStore(clock.now);
    store.issueToken({ clientId: "c", subject: PASSCODE_SUBJECT, scopes: [], resource: undefined, kind: "access" }, 60);
    store.issueCode(
      {
        clientId: "c",
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "x",
        scopes: [],
        resource: undefined,
      },
      60,
    );
    clock.advanceSeconds(61);

    expect(store.sweep()).toBe(2);
  });
});

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

describe("F-9 · provider", () => {
  const config = configFor("https://viva.example.com");
  const client = { client_id: CLIENT_ID, redirect_uris: [REDIRECT_URI] } as never;

  function provider(): VivaOAuthProvider {
    return new VivaOAuthProvider(config);
  }

  it("does not expose dynamic client registration (F-9)", () => {
    expect("registerClient" in provider().clientsStore).toBe(false);
  });

  it("sends the user to consent rather than auto-approving", async () => {
    const p = provider();
    let redirected = "";
    await p.authorize(
      client,
      { codeChallenge: "abc", redirectUri: REDIRECT_URI, resource: config.resourceUrl },
      { redirect: (url: string) => (redirected = url) } as never,
    );
    expect(redirected).toMatch(/^\/consent\?rid=/);
  });

  it("refuses to mint a token for a resource it does not serve (RFC 8707)", async () => {
    const p = provider();
    await expect(
      p.authorize(
        client,
        {
          codeChallenge: "abc",
          redirectUri: REDIRECT_URI,
          resource: new URL("https://somewhere-else.example.com/mcp"),
        },
        { redirect: () => {} } as never,
      ),
    ).rejects.toThrow(/only issues tokens for/);
  });

  it("rejects a code replayed after a successful exchange", async () => {
    const p = provider();
    const code = p.store.issueCode(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "abc",
        scopes: ["exam"],
        resource: config.resourceUrl.href,
      },
      60,
    );

    await p.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI, config.resourceUrl);
    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI, config.resourceUrl),
    ).rejects.toThrow(/invalid or expired/);
  });

  it("burns a code even when the exchange fails, so it cannot be retried", async () => {
    const p = provider();
    const code = p.store.issueCode(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "abc",
        scopes: [],
        resource: config.resourceUrl.href,
      },
      60,
    );

    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, "https://evil.example.com/cb", config.resourceUrl),
    ).rejects.toThrow(/redirect_uri/);
    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI, config.resourceUrl),
    ).rejects.toThrow(/invalid or expired/);
  });

  it("rejects a code issued to a different client", async () => {
    const p = provider();
    const code = p.store.issueCode(
      {
        clientId: "someone-else",
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "abc",
        scopes: [],
        resource: config.resourceUrl.href,
      },
      60,
    );
    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI, config.resourceUrl),
    ).rejects.toThrow(/invalid or expired/);
  });

  it("rejects a token-endpoint resource that differs from the authorization request", async () => {
    const p = provider();
    const code = p.store.issueCode(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "abc",
        scopes: [],
        resource: config.resourceUrl.href,
      },
      60,
    );
    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI, undefined),
    ).rejects.toThrow(/resource does not match/);
  });

  it("binds the audience into the access token it verifies", async () => {
    const p = provider();
    const code = p.store.issueCode(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "abc",
        scopes: ["exam"],
        resource: config.resourceUrl.href,
      },
      60,
    );
    const tokens = await p.exchangeAuthorizationCode(
      client,
      code,
      undefined,
      REDIRECT_URI,
      config.resourceUrl,
    );

    const info = await p.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(CLIENT_ID);
    expect(info.scopes).toEqual(["exam"]);
    expect(info.resource?.href).toBe(config.resourceUrl.href);
  });

  it("will not accept a refresh token as an access token", async () => {
    const p = provider();
    const code = p.store.issueCode(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "abc",
        scopes: [],
        resource: config.resourceUrl.href,
      },
      60,
    );
    const tokens = await p.exchangeAuthorizationCode(
      client,
      code,
      undefined,
      REDIRECT_URI,
      config.resourceUrl,
    );

    await expect(p.verifyAccessToken(tokens.refresh_token!)).rejects.toThrow(/invalid or expired/);
  });

  it("rotates refresh tokens and kills the presented one", async () => {
    const p = provider();
    const first = p.store.issueToken(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        scopes: ["exam"],
        resource: config.resourceUrl.href,
        kind: "refresh",
      },
      600,
    );

    const rotated = await p.exchangeRefreshToken(client, first);
    expect(rotated.refresh_token).not.toBe(first);
    await expect(p.exchangeRefreshToken(client, first)).rejects.toThrow(/invalid or expired/);
  });

  it("carries the grant subject onto the access token it verifies (F-7)", async () => {
    const p = provider();
    const code = p.store.issueCode(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "abc",
        scopes: ["exam"],
        resource: config.resourceUrl.href,
      },
      60,
    );
    const tokens = await p.exchangeAuthorizationCode(
      client,
      code,
      undefined,
      REDIRECT_URI,
      config.resourceUrl,
    );

    const info = await p.verifyAccessToken(tokens.access_token);
    expect(info.extra?.["subject"]).toBe(PASSCODE_SUBJECT);
  });

  it("keeps the subject across refresh rotation, so a history survives a refresh", async () => {
    const p = provider();
    const first = p.store.issueToken(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        scopes: ["exam"],
        resource: config.resourceUrl.href,
        kind: "refresh",
      },
      600,
    );

    const rotated = await p.exchangeRefreshToken(client, first);
    const info = await p.verifyAccessToken(rotated.access_token);

    // The token is new; the identity behind it is not. Progress keyed on the
    // subject therefore outlives every rotation.
    expect(rotated.access_token).not.toBe(first);
    expect(info.extra?.["subject"]).toBe(PASSCODE_SUBJECT);
  });

  it("refuses to widen scope on refresh", async () => {
    const p = provider();
    const refresh = p.store.issueToken(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        scopes: ["exam"],
        resource: config.resourceUrl.href,
        kind: "refresh",
      },
      600,
    );
    await expect(p.exchangeRefreshToken(client, refresh, ["exam", "admin"])).rejects.toThrow(
      /was not granted/,
    );
  });
});

// --------------------------------------------------------------------------
// The whole flow, against a real server
// --------------------------------------------------------------------------

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function startServer(): Promise<{
  origin: string;
  config: AuthConfig;
  provider: VivaOAuthProvider;
}> {
  const corpus = Corpus.fromItems([item(), unpreppedItem()]);
  // Bind first so the issuer and resource URLs carry the real port.
  const placeholder = await createApp({
    corpus,
    auth: configFor("http://127.0.0.1:1"),
    logger: silentLogger,
  });
  const probe = placeholder.app.listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  await placeholder.close();

  const origin = `http://127.0.0.1:${port}`;
  const config = configFor(origin);
  const built = await createApp({ corpus, auth: config, logger: silentLogger });
  const server = built.app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  servers.push(server);
  return { origin, config, provider: built.provider! };
}

describe("F-9 · end to end against a live server", () => {
  it("answers an unauthenticated /mcp with 401 and points at the metadata", async () => {
    const { origin } = await startServer();

    const res = await fetch(`${origin}/mcp`, { method: "POST" });

    expect(res.status).toBe(401);
    const header = res.headers.get("www-authenticate") ?? "";
    expect(header).toMatch(/^Bearer/);
    expect(header).toContain("resource_metadata=");
    expect(header).toContain("/.well-known/oauth-protected-resource");
  });

  it("advertises S256 and no dynamic registration in the metadata", async () => {
    const { origin } = await startServer();

    const meta = await fetch(`${origin}/.well-known/oauth-authorization-server`).then((r) => r.json());

    expect(meta.code_challenge_methods_supported).toContain("S256");
    expect(meta.response_types_supported).toContain("code");
    expect(meta.grant_types_supported).toContain("authorization_code");
    expect(meta.registration_endpoint).toBeUndefined();
  });

  it("publishes protected-resource metadata naming the authorization server", async () => {
    const { origin } = await startServer();

    const res = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    const meta = await res.json();

    expect(res.status).toBe(200);
    expect(meta.resource).toBe(`${origin}/mcp`);
    expect(meta.authorization_servers).toContain(origin + "/");
  });

  it("rejects a bearer token it never issued", async () => {
    const { origin } = await startServer();

    const res = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token" },
    });

    expect(res.status).toBe(401);
  });

  it("runs the whole authorization-code + PKCE flow and then calls a tool", async () => {
    const { origin, config } = await startServer();
    const { verifier, challenge } = pkce();

    // 1 · authorize → our consent screen
    const authorizeUrl = new URL(`${origin}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-123",
      resource: config.resourceUrl.href,
    }).toString();

    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorizeRes.status).toBe(302);
    const consentLocation = authorizeRes.headers.get("location") ?? "";
    expect(consentLocation).toMatch(/^\/consent\?rid=/);

    // 2 · the consent page renders
    const consentPage = await fetch(`${origin}${consentLocation}`);
    expect(consentPage.status).toBe(200);
    expect(await consentPage.text()).toContain("Alexa+ Demo");

    const rid = new URL(consentLocation, origin).searchParams.get("rid")!;

    // 3 · a wrong passcode does not produce a code
    const wrong = await fetch(`${origin}/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ rid, passcode: "wrong", action: "approve" }),
      redirect: "manual",
    });
    expect(wrong.status).toBe(401);

    // 4 · the right passcode redirects back with code and state
    const approved = await fetch(`${origin}/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ rid, passcode: PASSCODE, action: "approve" }),
      redirect: "manual",
    });
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("state-123");
    const code = callback.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // 5 · the wrong verifier must not be accepted
    const badExchange = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: randomBytes(32).toString("base64url"),
        redirect_uri: REDIRECT_URI,
        resource: config.resourceUrl.href,
      }),
    });
    expect(badExchange.status).toBe(400);

    // 6 · a fresh code, exchanged correctly
    const second = await fetch(`${origin}/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ rid, passcode: PASSCODE, action: "approve" }),
      redirect: "manual",
    });
    // The pending request was consumed by step 4, so this must fail.
    expect(second.status).toBe(400);

    const fresh = await freshCode(origin, config);
    const tokenRes = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: fresh.code,
        code_verifier: fresh.verifier,
        redirect_uri: REDIRECT_URI,
        resource: config.resourceUrl.href,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toBeTruthy();

    // 7 · the token actually opens /mcp, and a tool runs
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    });
    const client = new Client({ name: "auth-test", version: "0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(7);

    const result = (await client.callTool({
      name: "start_exam",
      arguments: { exam: "ielts", part: 2 },
    })) as { structuredContent?: Record<string, unknown> };
    expect(result.structuredContent?.["sessionId"]).toEqual(expect.any(String));

    await client.close();
  });

  it("carries the candidate's identity all the way into a tool call (F-7)", async () => {
    const { origin, config, provider } = await startServer();

    const first = await accessTokenFor(origin, config);
    const second = await accessTokenFor(origin, config);

    // Two separate authorizations by the same person — a second device, or a
    // re-pairing after a token lapsed. Both must resolve to the same subject,
    // or every re-pairing would orphan the history already earned.
    const a = await provider.verifyAccessToken(first);
    const b = await provider.verifyAccessToken(second);
    expect(a.extra?.["subject"]).toBe(PASSCODE_SUBJECT);
    expect(b.extra?.["subject"]).toBe(a.extra?.["subject"]);

    // And the subject survives the trip through requireBearerAuth and the
    // transport: the tool knows whose history it is being asked about.
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${first}` } },
    });
    const client = new Client({ name: "identity-test", version: "0" });
    await client.connect(transport);

    const result = (await client.callTool({ name: "get_progress", arguments: {} })) as {
      structuredContent?: Record<string, unknown>;
    };
    expect(result.structuredContent?.["status"]).toBe("ok");
    expect(result.structuredContent?.["sessionCount"]).toBe(0);

    await client.close();
  });
});

/** Runs the full flow and returns an access token. */
async function accessTokenFor(origin: string, config: AuthConfig): Promise<string> {
  const fresh = await freshCode(origin, config);
  const res = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: fresh.code,
      code_verifier: fresh.verifier,
      redirect_uri: REDIRECT_URI,
      resource: config.resourceUrl.href,
    }),
  });
  const tokens = (await res.json()) as { access_token: string };
  return tokens.access_token;
}

/** Walks authorize → consent again to get a usable code. */
async function freshCode(
  origin: string,
  config: AuthConfig,
): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const url = new URL(`${origin}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: config.resourceUrl.href,
  }).toString();

  const res = await fetch(url, { redirect: "manual" });
  const rid = new URL(res.headers.get("location")!, origin).searchParams.get("rid")!;

  const approved = await fetch(`${origin}/consent`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ rid, passcode: PASSCODE, action: "approve" }),
    redirect: "manual",
  });
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  return { code, verifier };
}

// --------------------------------------------------------------------------
// Authorization-code burning and replay revocation (QA S2)
// --------------------------------------------------------------------------

describe("F-9 · a failed or replayed code exchange kills the code", () => {
  async function exchange(
    origin: string,
    config: AuthConfig,
    code: string,
    verifier: string,
  ): Promise<Response> {
    return fetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        resource: config.resourceUrl.href,
      }),
    });
  }

  async function refresh(origin: string, config: AuthConfig, token: string): Promise<Response> {
    return fetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: token,
        resource: config.resourceUrl.href,
      }),
    });
  }

  it("a wrong verifier is invalid_grant and the code is then dead, even with the right verifier", async () => {
    const { origin, config } = await startServer();
    const { code, verifier } = await freshCode(origin, config);

    const bad = await exchange(origin, config, code, randomBytes(32).toString("base64url"));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");

    const good = await exchange(origin, config, code, verifier);
    expect(good.status).toBe(400);
    expect(((await good.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("still lets the correct flow through, with subject on the token and across refresh", async () => {
    const { origin, config, provider } = await startServer();
    const { code, verifier } = await freshCode(origin, config);

    const res = await exchange(origin, config, code, verifier);
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { access_token: string; refresh_token: string };
    expect((await provider.verifyAccessToken(tokens.access_token)).extra?.["subject"]).toBe(
      PASSCODE_SUBJECT,
    );

    const rotated = await refresh(origin, config, tokens.refresh_token);
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { access_token: string };
    const info = await provider.verifyAccessToken(next.access_token);
    expect(info.extra?.["subject"]).toBe(PASSCODE_SUBJECT);
    expect(info.resource?.href).toBe(config.resourceUrl.href);
  });

  it("replaying a redeemed code is invalid_grant and revokes the tokens it produced", async () => {
    const { origin, config, provider } = await startServer();
    const { code, verifier } = await freshCode(origin, config);

    const tokens = (await (await exchange(origin, config, code, verifier)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeTruthy();

    const replay = await exchange(origin, config, code, verifier);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");

    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/invalid or expired/);
    const refreshed = await refresh(origin, config, tokens.refresh_token);
    expect(refreshed.status).toBe(400);
  });

  it("replay also revokes tokens that descend from the code through a refresh", async () => {
    const { origin, config, provider } = await startServer();
    const { code, verifier } = await freshCode(origin, config);
    const first = (await (await exchange(origin, config, code, verifier)).json()) as {
      refresh_token: string;
    };
    const rotated = (await (await refresh(origin, config, first.refresh_token)).json()) as {
      access_token: string;
      refresh_token: string;
    };

    await exchange(origin, config, code, verifier);

    await expect(provider.verifyAccessToken(rotated.access_token)).rejects.toThrow(/invalid or expired/);
    expect((await refresh(origin, config, rotated.refresh_token)).status).toBe(400);
  });

  it("does not revoke other grants' tokens on a replay", async () => {
    const { origin, config, provider } = await startServer();
    const a = await freshCode(origin, config);
    const b = await freshCode(origin, config);
    await exchange(origin, config, a.code, a.verifier);
    const bt = (await (await exchange(origin, config, b.code, b.verifier)).json()) as {
      access_token: string;
    };

    await exchange(origin, config, a.code, a.verifier);

    await expect(provider.verifyAccessToken(bt.access_token)).resolves.toBeTruthy();
  });

  it("an unknown code is a plain invalid_grant and touches nothing", async () => {
    const { origin, config, provider } = await startServer();
    const { code, verifier } = await freshCode(origin, config);
    const tokens = (await (await exchange(origin, config, code, verifier)).json()) as {
      access_token: string;
    };

    const res = await exchange(origin, config, "not-a-real-code", verifier);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toBeTruthy();
  });

  it("an expired code is invalid_grant", async () => {
    const clock = fakeClock();
    const config = configFor("https://viva.example.com");
    const p = new VivaOAuthProvider(config, new AuthStore(clock.now));
    const client = { client_id: CLIENT_ID, redirect_uris: [REDIRECT_URI] } as never;
    const code = p.store.issueCode(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "abc",
        scopes: [],
        resource: config.resourceUrl.href,
      },
      60,
    );
    clock.advanceSeconds(61);

    await expect(p.challengeForAuthorizationCode(client, code)).rejects.toThrow(/invalid or expired/);
    await expect(
      p.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI, config.resourceUrl),
    ).rejects.toThrow(/invalid or expired/);
  });

  it("a challenge by the wrong client burns the code", async () => {
    const config = configFor("https://viva.example.com");
    const p = new VivaOAuthProvider(config);
    const good = { client_id: CLIENT_ID, redirect_uris: [REDIRECT_URI] } as never;
    const other = { client_id: "other", redirect_uris: [REDIRECT_URI] } as never;
    const code = p.store.issueCode(
      {
        clientId: CLIENT_ID,
        subject: PASSCODE_SUBJECT,
        redirectUri: REDIRECT_URI,
        codeChallenge: "abc",
        scopes: [],
        resource: config.resourceUrl.href,
      },
      60,
    );

    await expect(p.challengeForAuthorizationCode(other, code)).rejects.toThrow(/invalid or expired/);
    await expect(p.challengeForAuthorizationCode(good, code)).rejects.toThrow(/invalid or expired/);
  });
});

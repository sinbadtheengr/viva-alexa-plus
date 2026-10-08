import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type BuiltApp } from "../src/app.js";
import { loadAuthConfig } from "../src/auth/config.js";
import { Corpus } from "../src/exam/corpus.js";
import { silentLogger } from "../src/mcp/logging.js";
import { fakeClock, item, unpreppedItem } from "./fixtures.js";

/**
 * GAP-015 · One transport + McpServer per MCP session, with exam state shared.
 * These drive the real app over a loopback port, as a client would.
 */

const noAuth = loadAuthConfig({ VIVA_AUTH_DISABLED: "1" } as NodeJS.ProcessEnv);

const servers: Server[] = [];
const apps: BuiltApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function boot(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const corpus = Corpus.fromItems([item(), unpreppedItem()]);
  const built = await createApp({ corpus, auth: noAuth, logger: silentLogger, ...extra });
  apps.push(built);
  const server = built.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  servers.push(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { built, origin };
}

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/** Parses either a JSON body or the first `data:` event of an SSE body. */
function parse(text: string): any {
  const data = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(data ? data.slice(5).trim() : text);
}

async function rpc(origin: string, body: unknown, sessionId?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { ...HEADERS, ...(sessionId ? { "mcp-session-id": sessionId } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { res, text, json: text && res.headers.get("content-type") ? safe(text) : undefined };
}
function safe(text: string): any {
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

const initBody = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

async function connect(origin: string): Promise<string> {
  const { res } = await rpc(origin, initBody());
  expect(res.status).toBe(200);
  const id = res.headers.get("mcp-session-id");
  expect(id).toBeTruthy();
  await rpc(origin, { jsonrpc: "2.0", method: "notifications/initialized" }, id!);
  return id!;
}

const call = (origin: string, sid: string, name: string, args: Record<string, unknown>, id = 2) =>
  rpc(origin, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, sid);

describe("GAP-015 · multiple MCP sessions on one app", () => {
  it("lets two clients initialise concurrently with distinct session ids", async () => {
    const { origin } = await boot();
    const [a, b] = await Promise.all([rpc(origin, initBody()), rpc(origin, initBody())]);
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
    const ida = a.res.headers.get("mcp-session-id");
    const idb = b.res.headers.get("mcp-session-id");
    expect(ida && idb && ida !== idb).toBe(true);
  });

  it("accepts a reload-style second initialize, even carrying the stale session id", async () => {
    const { origin, built } = await boot();
    const first = await connect(origin);
    const again = await rpc(origin, initBody(), first);
    expect(again.res.status).toBe(200);
    expect(again.res.headers.get("mcp-session-id")).not.toBe(first);
    expect(built.mcpSessionCount()).toBe(2);
  });

  it("routes each request to the session named in its header", async () => {
    const { origin } = await boot();
    const a = await connect(origin);
    const b = await connect(origin);
    for (const sid of [a, b]) {
      const list = await rpc(origin, { jsonrpc: "2.0", id: 5, method: "tools/list" }, sid);
      expect(list.res.status).toBe(200);
      expect(list.json.result.tools.map((t: any) => t.name)).toContain("start_exam");
    }
  });

  it("answers an unknown session id with 404", async () => {
    const { origin } = await boot();
    const { res } = await rpc(origin, { jsonrpc: "2.0", id: 2, method: "tools/list" }, "no-such-session");
    expect(res.status).toBe(404);
  });

  it("answers a non-initialize request with no session id with 400", async () => {
    const { origin } = await boot();
    const { res } = await rpc(origin, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.status).toBe(400);
    const get = await fetch(`${origin}/mcp`, { headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(400);
  });

  it("rejects an unparseable body with 400 rather than crashing", async () => {
    const { origin } = await boot();
    const res = await fetch(`${origin}/mcp`, { method: "POST", headers: HEADERS, body: "{nope" });
    expect(res.status).toBe(400);
  });

  it("DELETE closes and removes the session; later use is 404", async () => {
    const { origin, built } = await boot();
    const sid = await connect(origin);
    const other = await connect(origin);
    expect(built.mcpSessionCount()).toBe(2);

    const del = await fetch(`${origin}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } });
    expect(del.status).toBe(200);
    expect(built.mcpSessionCount()).toBe(1);

    const after = await rpc(origin, { jsonrpc: "2.0", id: 9, method: "tools/list" }, sid);
    expect(after.res.status).toBe(404);
    const still = await rpc(origin, { jsonrpc: "2.0", id: 9, method: "tools/list" }, other);
    expect(still.res.status).toBe(200);
  });

  it("sweeps idle MCP sessions and keeps active ones", async () => {
    const clock = fakeClock();
    const { origin, built } = await boot({ now: clock.now, mcpSessionIdleMs: 60_000, mcpSessionSweepMs: 3_600_000 });
    const idle = await connect(origin);
    clock.advanceMs(50_000);
    const active = await connect(origin);
    clock.advanceMs(20_000); // idle: 70s since seen, active: 20s
    expect(await built.sweepMcpSessions()).toBe(1);
    expect(built.mcpSessionCount()).toBe(1);

    expect((await rpc(origin, { jsonrpc: "2.0", id: 3, method: "tools/list" }, idle)).res.status).toBe(404);
    expect((await rpc(origin, { jsonrpc: "2.0", id: 3, method: "tools/list" }, active)).res.status).toBe(200);
  });

  it("a request refreshes idleness", async () => {
    const clock = fakeClock();
    const { origin, built } = await boot({ now: clock.now, mcpSessionIdleMs: 60_000, mcpSessionSweepMs: 3_600_000 });
    const sid = await connect(origin);
    clock.advanceMs(50_000);
    await rpc(origin, { jsonrpc: "2.0", id: 3, method: "tools/list" }, sid);
    clock.advanceMs(50_000);
    expect(await built.sweepMcpSessions()).toBe(0);
  });

  it("evicts the least-recently-used connection at the cap", async () => {
    const clock = fakeClock();
    const { origin, built } = await boot({ now: clock.now, mcpSessionMax: 2, mcpSessionSweepMs: 3_600_000 });
    const a = await connect(origin);
    clock.advanceMs(1000);
    const b = await connect(origin);
    clock.advanceMs(1000);
    const c = await connect(origin);
    expect(built.mcpSessionCount()).toBe(2);
    expect((await rpc(origin, { jsonrpc: "2.0", id: 3, method: "tools/list" }, a)).res.status).toBe(404);
    expect((await rpc(origin, { jsonrpc: "2.0", id: 3, method: "tools/list" }, b)).res.status).toBe(200);
    expect((await rpc(origin, { jsonrpc: "2.0", id: 3, method: "tools/list" }, c)).res.status).toBe(200);
  });

  it("shares exam state across MCP sessions", async () => {
    const { origin } = await boot();
    const a = await connect(origin);
    const b = await connect(origin);

    const started = await call(origin, a, "start_exam", { exam: "ielts", part: 2 });
    const sessionId = started.json.result.structuredContent.sessionId as string;
    expect(sessionId).toBeTruthy();

    // Read it, and advance it, from a different MCP session.
    const status = await call(origin, b, "get_status", { sessionId }, 3);
    expect(status.json.result.isError).toBeFalsy();
    expect(status.json.result.structuredContent.phase).toBe("briefing");
    const advanced = await call(origin, b, "advance_phase", { sessionId }, 4);
    expect(advanced.json.result.isError).toBeFalsy();
    const back = await call(origin, a, "get_status", { sessionId }, 5);
    expect(back.json.result.structuredContent.phase).not.toBe("briefing");
  });
});

describe("GAP-015 · auth is unchanged in front of the session router", () => {
  it("still answers an unauthenticated /mcp with 401 (initialize or otherwise)", async () => {
    const auth = loadAuthConfig({
      VIVA_ISSUER_URL: "http://127.0.0.1:1",
      VIVA_DEMO_PASSCODE: "pw",
      VIVA_OAUTH_CLIENTS: JSON.stringify([{ client_id: "c", redirect_uris: ["http://127.0.0.1:1/cb"] }]),
    } as NodeJS.ProcessEnv);
    const { origin, built } = await boot({ auth });

    const init = await rpc(origin, initBody());
    expect(init.res.status).toBe(401);
    const noId = await rpc(origin, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(noId.res.status).toBe(401);
    const bad = await rpc(origin, initBody(), undefined, { authorization: "Bearer nope" });
    expect(bad.res.status).toBe(401);
    expect(built.mcpSessionCount()).toBe(0);
  });
});

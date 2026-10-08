// Pure logic for the Viva demo client. No DOM, no network, no globals beyond
// Web Crypto (present in browsers and Node 24), so vitest can drive it directly.
//
// The demo client plays the Alexa+ role (GAP-001/006: the real add-on toolchain
// is closed to hackathon participants). Everything here is protocol plumbing —
// PKCE, JSON-RPC framing, countdown arithmetic — kept apart from app.js so it
// can be tested without a browser.

export const MCP_PROTOCOL_VERSION = "2025-11-25";

// ---------------------------------------------------------------------------
// PKCE (RFC 7636, S256) and OAuth request building
// ---------------------------------------------------------------------------

/** base64url without padding (RFC 7636 appendix A). */
export function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A high-entropy random string of base64url characters. 32 bytes gives 43
 * characters, the RFC 7636 minimum verifier length.
 */
export function randomToken(byteLength = 32, getRandomValues = (a) => globalThis.crypto.getRandomValues(a)) {
  return base64url(getRandomValues(new Uint8Array(byteLength)));
}

/** S256 code challenge: BASE64URL(SHA-256(ASCII(verifier))). */
export async function codeChallengeS256(verifier, subtle = globalThis.crypto.subtle) {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Authorization request URL. `resource` is RFC 8707. */
export function buildAuthorizeUrl({ authorizationEndpoint, clientId, redirectUri, challenge, state, resource, scope }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (resource) url.searchParams.set("resource", resource);
  if (scope) url.searchParams.set("scope", scope);
  return url.href;
}

/** Form body for the token request. The verifier travels here, in a POST body. */
export function buildTokenRequestBody({ code, clientId, redirectUri, verifier, resource }) {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("client_id", clientId);
  body.set("redirect_uri", redirectUri);
  body.set("code_verifier", verifier);
  if (resource) body.set("resource", resource);
  return body.toString();
}

/**
 * Reads the authorization response from the redirect query string.
 * Returns { kind: "none" | "error" | "code", ... }. A state mismatch is an
 * error, never a code: accepting it would defeat the CSRF check.
 */
export function parseAuthorizationResponse(search, expectedState) {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  const code = params.get("code");
  if (!error && !code) return { kind: "none" };
  if (params.get("state") !== expectedState || expectedState == null) {
    return { kind: "error", error: "state_mismatch" };
  }
  if (error) return { kind: "error", error, description: params.get("error_description") ?? undefined };
  return { kind: "code", code };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 framing for MCP Streamable HTTP
// ---------------------------------------------------------------------------

export function jsonRpcRequest(id, method, params) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

export function jsonRpcNotification(method, params) {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

export function initializeRequest(id, clientInfo) {
  return jsonRpcRequest(id, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo,
  });
}

export function toolCallRequest(id, name, args = {}) {
  return jsonRpcRequest(id, "tools/call", { name, arguments: args });
}

/** Headers for a POST to the MCP endpoint. The bearer goes in the header only. */
export function mcpHeaders({ token, sessionId }) {
  const headers = {
    "Content-Type": "application/json",
    // The transport insists on both; it chooses which one to answer with.
    Accept: "application/json, text/event-stream",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
    headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
  }
  return headers;
}

/**
 * A POST response may be a single JSON document or a Server-Sent Events stream
 * of `message` events (the SDK transport answers with the latter). Both carry
 * the same JSON-RPC messages; this returns them as an array either way.
 */
export function parseResponseBody(contentType, text) {
  if (!text || text.trim() === "") return [];
  if ((contentType ?? "").toLowerCase().includes("text/event-stream")) return parseSse(text);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Minimal SSE parser: events separated by blank lines, `data:` lines joined by \n. */
export function parseSse(text) {
  const messages = [];
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length > 0) messages.push(JSON.parse(data.join("\n")));
  }
  return messages;
}

export class JsonRpcError extends Error {
  constructor(error) {
    super(error?.message ?? "JSON-RPC error");
    this.name = "JsonRpcError";
    this.code = error?.code;
    this.data = error?.data;
  }
}

/** The response matching `id`, or a thrown JsonRpcError / Error. */
export function responseFor(messages, id) {
  const match = messages.find((m) => m && m.id === id && ("result" in m || "error" in m));
  if (!match) throw new Error(`No JSON-RPC response for request ${id}.`);
  if (match.error) throw new JsonRpcError(match.error);
  return match.result;
}

/**
 * Normalises a tools/call result: the text Alexa+ would speak, the structured
 * payload the UI draws from, and whether the tool reported a domain error.
 */
export function toolOutcome(result) {
  const text = (result?.content ?? [])
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return {
    text,
    data: result?.structuredContent ?? {},
    isError: result?.isError === true,
  };
}

// ---------------------------------------------------------------------------
// Countdown arithmetic
//
// The deadline lives on the server. get_status returns whole seconds remaining;
// the client never invents a deadline, it only interpolates between syncs.
// ---------------------------------------------------------------------------

/**
 * Anchors a get_status reading to the local monotonic clock. The server computed
 * `secondsRemaining` somewhere between request and response, so the reading is
 * anchored at the midpoint of the round trip.
 */
export function makeClockSync(secondsRemaining, sentAtMs, receivedAtMs) {
  if (secondsRemaining === null || secondsRemaining === undefined) return null;
  return { secondsRemaining, anchoredAtMs: (sentAtMs + receivedAtMs) / 2 };
}

/** Seconds left at `nowMs`, clamped at zero. Null when the phase is untimed. */
export function secondsLeft(sync, nowMs) {
  if (!sync) return null;
  return Math.max(0, sync.secondsRemaining - (nowMs - sync.anchoredAtMs) / 1000);
}

/** Whole seconds past the limit at `nowMs` (0 until the clock has run out). */
export function secondsOver(sync, nowMs) {
  if (!sync) return 0;
  return Math.max(0, (nowMs - sync.anchoredAtMs) / 1000 - sync.secondsRemaining);
}

/** Elapsed speaking time given the phase's allowance and what remains. */
export function elapsedSeconds(allowanceSeconds, sync, nowMs) {
  if (!sync) return null;
  const left = sync.secondsRemaining - (nowMs - sync.anchoredAtMs) / 1000;
  return Math.max(0, allowanceSeconds - left);
}

/** "1:05" style clock. Rounds up so 0:00 only shows at the true deadline. */
export function formatClock(seconds) {
  const whole = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Same format, rounding down — for elapsed time, which counts up from 0:00. */
export function formatElapsed(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** When to next re-read get_status: every `intervalMs`, sooner once the clock is nearly out. */
export function nextSyncDelayMs(sync, nowMs, intervalMs = 5000) {
  const left = secondsLeft(sync, nowMs);
  if (left === null) return intervalMs;
  return Math.max(250, Math.min(intervalMs, Math.ceil(left * 1000) + 250));
}

// ---------------------------------------------------------------------------
// Results polling
// ---------------------------------------------------------------------------

/** Honours the server's pollAfterMs, but never spins faster than a sane floor. */
export function pollDelayMs(pollAfterMs, floorMs = 250, ceilingMs = 10000) {
  const asked = Number.isFinite(pollAfterMs) ? pollAfterMs : 1500;
  return Math.min(ceilingMs, Math.max(floorMs, asked));
}

// ---------------------------------------------------------------------------
// Request log
// ---------------------------------------------------------------------------

/** One latency line for the log panel. `ms` is the browser-side round trip. */
export function formatLogLine({ tool, ms, ok, status }) {
  const flag = ok ? "ok" : "error";
  return `${tool}  ${ms.toFixed(0)} ms  HTTP ${status}  ${flag}`;
}

/** Summary used in the panel header: count, median and worst round trip. */
export function summariseLatency(samples) {
  if (samples.length === 0) return { count: 0, medianMs: 0, maxMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { count: sorted.length, medianMs, maxMs: sorted[sorted.length - 1] };
}

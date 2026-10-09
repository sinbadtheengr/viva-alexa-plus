import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { DEFAULT_THROTTLE, type ThrottleConfig } from "./throttle.js";

/**
 * F-9 · Auth configuration.
 *
 * Fails closed: with auth enabled and no passcode configured, the server
 * refuses to start rather than coming up wide open.
 */

export interface AuthConfig {
  readonly enabled: boolean;
  /** Issuer identifier for this authorization server. */
  readonly issuerUrl: URL;
  /** RFC 8707 canonical resource identifier that tokens are bound to. */
  readonly resourceUrl: URL;
  /** Demo-grade user authentication. See GAP-011. */
  readonly passcode: string;
  /**
   * Pre-registered clients. Dynamic Client Registration is deliberately not
   * supported (F-9) — Alexa+ does not support it, so clients are configured here.
   */
  readonly clients: readonly OAuthClientInformationFull[];
  readonly accessTokenTtlSeconds: number;
  readonly authorizationCodeTtlSeconds: number;
  /** GAP-011 · Passcode guess throttling on the consent POST. */
  readonly throttle: ThrottleConfig;
  /**
   * Express `trust proxy` setting, or undefined to trust nothing (the default, and the
   * only safe choice when clients connect directly: X-Forwarded-For is then
   * attacker-controlled and rotating it would bypass the throttle).
   */
  readonly trustProxy: number | string | undefined;
}

export class AuthConfigError extends Error {
  override readonly name = "AuthConfigError";
}

function parseClients(raw: string | undefined): OAuthClientInformationFull[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new AuthConfigError(`VIVA_OAUTH_CLIENTS is not valid JSON: ${String(cause)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new AuthConfigError("VIVA_OAUTH_CLIENTS must be a JSON array of client objects.");
  }
  return parsed.map((entry, index) => {
    const client = entry as Partial<OAuthClientInformationFull>;
    if (typeof client.client_id !== "string" || client.client_id.length === 0) {
      throw new AuthConfigError(`VIVA_OAUTH_CLIENTS[${index}] has no client_id.`);
    }
    if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length === 0) {
      throw new AuthConfigError(`VIVA_OAUTH_CLIENTS[${index}] has no redirect_uris.`);
    }
    return client as OAuthClientInformationFull;
  });
}

function seconds(env: NodeJS.ProcessEnv, name: string, fallbackMs: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new AuthConfigError(`${name} must be a positive number of seconds.`);
  return Math.round(n * 1000);
}

function count(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new AuthConfigError(`${name} must be a positive integer.`);
  return n;
}

function parseTrustProxy(raw: string | undefined): number | string | undefined {
  if (raw === undefined || raw === "" || raw === "0" || raw === "false") return undefined;
  if (raw === "true") {
    throw new AuthConfigError(
      "VIVA_TRUST_PROXY=true trusts every hop, so any client could forge its address. " +
        "Give the number of proxies in front of the server (e.g. 1), or an Express subnet list.",
    );
  }
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const enabled = env["VIVA_AUTH_DISABLED"] !== "1";
  const issuer = env["VIVA_ISSUER_URL"] ?? "http://127.0.0.1:8787";
  const issuerUrl = new URL(issuer);
  const resourceUrl = new URL(env["VIVA_RESOURCE_URL"] ?? new URL("/mcp", issuerUrl).href);
  const passcode = env["VIVA_DEMO_PASSCODE"] ?? "";

  if (enabled && passcode.length === 0) {
    throw new AuthConfigError(
      "VIVA_DEMO_PASSCODE is required when auth is enabled. " +
        "Set it, or set VIVA_AUTH_DISABLED=1 for local development only.",
    );
  }

  return {
    enabled,
    issuerUrl,
    resourceUrl,
    passcode,
    clients: parseClients(env["VIVA_OAUTH_CLIENTS"]),
    accessTokenTtlSeconds: Number(env["VIVA_ACCESS_TOKEN_TTL"] ?? 3600),
    authorizationCodeTtlSeconds: Number(env["VIVA_AUTH_CODE_TTL"] ?? 60),
    throttle: {
      maxFailures: count(env, "VIVA_CONSENT_MAX_FAILURES", DEFAULT_THROTTLE.maxFailures),
      lockBaseMs: seconds(env, "VIVA_CONSENT_LOCK_SECONDS", DEFAULT_THROTTLE.lockBaseMs),
      lockMaxMs: seconds(env, "VIVA_CONSENT_LOCK_MAX_SECONDS", DEFAULT_THROTTLE.lockMaxMs),
      windowMs: seconds(env, "VIVA_CONSENT_WINDOW_SECONDS", DEFAULT_THROTTLE.windowMs),
      globalMaxFailures: count(env, "VIVA_CONSENT_GLOBAL_MAX_FAILURES", DEFAULT_THROTTLE.globalMaxFailures),
      globalWindowMs: seconds(env, "VIVA_CONSENT_GLOBAL_WINDOW_SECONDS", DEFAULT_THROTTLE.globalWindowMs),
      globalSlowMs: seconds(env, "VIVA_CONSENT_GLOBAL_SLOW_SECONDS", DEFAULT_THROTTLE.globalSlowMs),
      maxTrackedIps: count(env, "VIVA_CONSENT_MAX_TRACKED_IPS", DEFAULT_THROTTLE.maxTrackedIps),
    },
    trustProxy: parseTrustProxy(env["VIVA_TRUST_PROXY"]),
  };
}

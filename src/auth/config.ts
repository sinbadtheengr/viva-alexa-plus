import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

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
  };
}

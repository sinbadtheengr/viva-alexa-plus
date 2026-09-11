import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthConfig } from "./config.js";
import { AuthStore, StaticClientsStore } from "./store.js";

/**
 * F-9 · OAuth 2.1 authorization server for Viva.
 *
 * PKCE itself is verified by the SDK's token handler, which calls
 * `challengeForAuthorizationCode` and checks the verifier against it — and
 * requires `code_verifier` unconditionally, so the flow is PKCE-only. This
 * class owns everything else: single-use codes, redirect-URI binding, and
 * RFC 8707 audience binding so a token minted for Viva cannot be replayed
 * against another MCP server.
 *
 * Deliberately absent, per F-9: Dynamic Client Registration, OpenID Connect,
 * step-up authorization. Alexa+ supports none of them.
 */

export const CONSENT_PATH = "/consent";

export class VivaOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: StaticClientsStore;
  readonly store: AuthStore;
  readonly #config: AuthConfig;

  constructor(config: AuthConfig, store: AuthStore = new AuthStore()) {
    this.#config = config;
    this.store = store;
    this.clientsStore = new StaticClientsStore(config.clients);
  }

  /** The SDK verifies PKCE locally; we never see the verifier. */
  readonly skipLocalPkceValidation = false;

  /**
   * Hands off to our own consent screen rather than auto-approving. The user
   * must actively authorize before any code exists.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.#assertResource(params.resource);

    const pendingId = this.store.createPending(
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scopes: params.scopes ?? [],
        resource: params.resource?.href,
      },
      this.#config.authorizationCodeTtlSeconds * 10,
    );

    res.redirect(`${CONSENT_PATH}?rid=${encodeURIComponent(pendingId)}`);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.store.peekCode(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code is invalid or expired.");
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // Consumes the code whether or not the checks below pass: a code that has
    // been presented once must never be usable again, even after a failure.
    const entry = this.store.takeCode(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code is invalid or expired.");
    }
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    }
    // RFC 8707: the resource at the token endpoint must match the one the code
    // was issued for, or the token would be minted for a different audience.
    if ((resource?.href ?? undefined) !== entry.resource) {
      throw new InvalidTargetError("resource does not match the authorization request.");
    }
    this.#assertResource(resource);

    return this.#mint(entry.clientId, entry.scopes, entry.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.store.readToken(refreshToken);
    if (!entry || entry.kind !== "refresh" || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token is invalid or expired.");
    }
    if (resource !== undefined) this.#assertResource(resource);

    // Narrowing scope on refresh is allowed; widening it is not.
    const granted = new Set(entry.scopes);
    const requested = scopes ?? [...granted];
    for (const scope of requested) {
      if (!granted.has(scope)) {
        throw new InvalidRequestError(`Scope "${scope}" was not granted to this token.`);
      }
    }

    // Rotate: the presented refresh token is dead once it has been used.
    this.store.revokeToken(refreshToken);
    return this.#mint(entry.clientId, requested, entry.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.store.readToken(token);
    if (!entry || entry.kind !== "access") {
      // Must be InvalidTokenError, not InvalidGrantError: RFC 6750 requires a
      // protected resource to answer 401 with a WWW-Authenticate challenge so
      // the client knows to re-authenticate. A generic OAuth error maps to 400,
      // which tells the client nothing and breaks token refresh.
      throw new InvalidTokenError("Access token is invalid or expired.");
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: [...entry.scopes],
      expiresAt: Math.floor(entry.expiresAt / 1000),
      ...(entry.resource ? { resource: new URL(entry.resource) } : {}),
    };
  }

  #mint(clientId: string, scopes: readonly string[], resource: string | undefined): OAuthTokens {
    const accessToken = this.store.issueToken(
      { clientId, scopes, resource, kind: "access" },
      this.#config.accessTokenTtlSeconds,
    );
    const refreshToken = this.store.issueToken(
      { clientId, scopes, resource, kind: "refresh" },
      this.#config.accessTokenTtlSeconds * 24,
    );
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.#config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
    };
  }

  /**
   * A `resource` we do not serve must be refused outright. Issuing a token for
   * someone else's audience is the exact confused-deputy problem RFC 8707 exists
   * to prevent.
   */
  #assertResource(resource: URL | undefined): void {
    if (resource === undefined) return;
    const expected = this.#config.resourceUrl;
    const given = new URL(resource.href);
    given.hash = "";
    if (given.href.replace(/\/$/, "") !== expected.href.replace(/\/$/, "")) {
      throw new InvalidTargetError(
        `This server only issues tokens for ${expected.href}, not ${given.href}.`,
      );
    }
  }
}

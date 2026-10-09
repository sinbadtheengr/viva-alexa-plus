import { createHash, randomBytes } from "node:crypto";
import type {
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";

/**
 * F-9 · In-memory OAuth state.
 *
 * Tokens are stored as SHA-256 digests, never in the clear, so a heap dump or
 * an accidental log of this structure yields nothing usable. Authorization
 * codes are short-lived, bound to the client, the redirect URI and the RFC 8707
 * resource they were issued for, and burned the first time an exchange gets as
 * far as checking them: a failed PKCE check, a mismatched client, redirect URI
 * or resource all leave the code unusable. Presenting a code that was already
 * redeemed revokes every token descended from it (RFC 6749 section 4.1.2).
 */

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** An authorization request awaiting the user's approval. */
export interface PendingAuthorization {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | undefined;
  readonly scopes: readonly string[];
  readonly resource: string | undefined;
  readonly expiresAt: number;
}

export interface AuthorizationCode {
  readonly clientId: string;
  /** Who authenticated at the consent screen. Keys F-7 progress — see identity.ts. */
  readonly subject: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly resource: string | undefined;
  readonly expiresAt: number;
  /**
   * Set on codes handed back by `challengeCode` / `takeCode`: the lineage id
   * (digest of the code) that tokens minted from it are tagged with.
   */
  readonly grantId?: string;
}

export interface StoredToken {
  readonly clientId: string;
  /** Carried from the grant, and preserved across refresh rotation (F-7). */
  readonly subject: string;
  readonly scopes: readonly string[];
  /** RFC 8707 audience. A token is only valid for the resource it was issued for. */
  readonly resource: string | undefined;
  readonly expiresAt: number;
  readonly kind: "access" | "refresh";
  /** Digest of the authorization code this token descends from, kept across refresh. */
  readonly grantId?: string;
}

/**
 * Deliberately does NOT implement `registerClient`. The SDK only advertises and
 * mounts the Dynamic Client Registration endpoint when that method exists, so
 * omitting it is what keeps DCR off (F-9 — Alexa+ does not support it).
 */
export class StaticClientsStore implements OAuthRegisteredClientsStore {
  readonly #clients: ReadonlyMap<string, OAuthClientInformationFull>;

  constructor(clients: readonly OAuthClientInformationFull[]) {
    this.#clients = new Map(clients.map((c) => [c.client_id, c]));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.#clients.get(clientId);
  }

  get size(): number {
    return this.#clients.size;
  }
}

export class AuthStore {
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #codes = new Map<string, AuthorizationCode & { challenged: boolean }>();
  /** Spent codes (by digest) -> how long to remember them, so a replay can be recognised. */
  readonly #spent = new Map<string, number>();
  readonly #tokens = new Map<string, StoredToken>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  // --- pending authorizations -------------------------------------------------

  createPending(request: Omit<PendingAuthorization, "expiresAt">, ttlSeconds: number): string {
    const id = secret(16);
    this.#pending.set(id, { ...request, expiresAt: this.#now() + ttlSeconds * 1000 });
    return id;
  }

  takePending(id: string): PendingAuthorization | undefined {
    const entry = this.#pending.get(id);
    if (!entry) return undefined;
    this.#pending.delete(id);
    return entry.expiresAt < this.#now() ? undefined : entry;
  }

  peekPending(id: string): PendingAuthorization | undefined {
    const entry = this.#pending.get(id);
    if (!entry || entry.expiresAt < this.#now()) return undefined;
    return entry;
  }

  // --- authorization codes ----------------------------------------------------

  issueCode(code: Omit<AuthorizationCode, "expiresAt">, ttlSeconds: number): string {
    const value = secret(32);
    this.#codes.set(value, {
      ...code,
      expiresAt: this.#now() + ttlSeconds * 1000,
      challenged: false,
    });
    return value;
  }

  /** Read-only look; does not consume. Not used on the token-endpoint path. */
  peekCode(code: string): AuthorizationCode | undefined {
    const entry = this.#codes.get(code);
    if (!entry || entry.expiresAt < this.#now()) return undefined;
    return entry;
  }

  /**
   * First step of an exchange (the SDK calls this to fetch the PKCE challenge
   * before it compares the verifier). Marks the code as challenged. The SDK
   * goes straight on to `takeCode` when the verifier matches; when it does not,
   * `takeCode` is never reached, so a second `challengeCode` on the same code
   * finds it already challenged and burns it. A wrong verifier therefore costs
   * the caller the code: one attempt, not unlimited guesses.
   *
   * A code that was already redeemed revokes the tokens minted from it.
   */
  challengeCode(code: string): AuthorizationCode | undefined {
    const entry = this.#codes.get(code);
    if (!entry || entry.expiresAt < this.#now()) {
      this.#codes.delete(code);
      this.#revokeIfSpent(code);
      return undefined;
    }
    if (entry.challenged) {
      this.burnCode(code);
      return undefined;
    }
    entry.challenged = true;
    return { ...entry, grantId: sha256(code) };
  }

  /** Single use: reading a code consumes it, whether or not the exchange succeeds. */
  takeCode(code: string): AuthorizationCode | undefined {
    const entry = this.#codes.get(code);
    this.#codes.delete(code);
    if (!entry) {
      this.#revokeIfSpent(code);
      return undefined;
    }
    this.#markSpent(sha256(code), entry.expiresAt);
    if (entry.expiresAt < this.#now()) return undefined;
    return { ...entry, grantId: sha256(code) };
  }

  /** Destroys a code and remembers it as spent, so presenting it again revokes its tokens. */
  burnCode(code: string): void {
    const entry = this.#codes.get(code);
    this.#codes.delete(code);
    if (entry) this.#markSpent(sha256(code), entry.expiresAt);
  }

  #markSpent(grantId: string, until: number): void {
    this.#spent.set(grantId, Math.max(this.#spent.get(grantId) ?? 0, until));
  }

  #revokeIfSpent(code: string): void {
    const grantId = sha256(code);
    const until = this.#spent.get(grantId);
    if (until === undefined) return;
    if (until < this.#now()) {
      this.#spent.delete(grantId);
      return;
    }
    this.revokeGrant(grantId);
  }

  /** Revokes every access and refresh token descended from one authorization code. */
  revokeGrant(grantId: string): number {
    let removed = 0;
    for (const [key, entry] of this.#tokens) {
      if (entry.grantId === grantId) (this.#tokens.delete(key), removed++);
    }
    return removed;
  }

  // --- tokens -----------------------------------------------------------------

  issueToken(token: Omit<StoredToken, "expiresAt">, ttlSeconds: number): string {
    const value = secret(32);
    const expiresAt = this.#now() + ttlSeconds * 1000;
    this.#tokens.set(sha256(value), { ...token, expiresAt });
    // Remember the lineage for as long as its longest-lived token, so a replay
    // of the code can still find and revoke it.
    if (token.grantId) this.#markSpent(token.grantId, expiresAt);
    return value;
  }

  readToken(value: string): StoredToken | undefined {
    const entry = this.#tokens.get(sha256(value));
    if (!entry) return undefined;
    if (entry.expiresAt < this.#now()) {
      this.#tokens.delete(sha256(value));
      return undefined;
    }
    return entry;
  }

  revokeToken(value: string): void {
    this.#tokens.delete(sha256(value));
  }

  /** Drops everything expired. Returns how many entries were removed. */
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [key, entry] of this.#pending) {
      if (entry.expiresAt < now) (this.#pending.delete(key), removed++);
    }
    for (const [key, entry] of this.#codes) {
      if (entry.expiresAt < now) (this.#codes.delete(key), removed++);
    }
    for (const [key, entry] of this.#tokens) {
      if (entry.expiresAt < now) (this.#tokens.delete(key), removed++);
    }
    // Spent-code tombstones are bookkeeping, not entries: not counted.
    for (const [key, until] of this.#spent) {
      if (until < now) this.#spent.delete(key);
    }
    return removed;
  }
}

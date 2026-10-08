import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * F-7 · Whose progress record this is. *(Resolves GAP-007.)*
 *
 * Progress is keyed on the **OAuth grant subject**: an identifier fixed when the
 * user authenticates at the consent screen, carried on the authorization code,
 * copied onto every access and refresh token minted from that code, and
 * preserved across refresh rotation.
 *
 * Deliberately *not* keyed on:
 *
 * - the bearer token — it rotates hourly, and a history that dies on refresh is
 *   not a history;
 * - `clientId` — that identifies Alexa+, not the person speaking;
 * - any per-conversation identifier Alexa+ may pass — it resets every
 *   conversation, which is the one thing progress has to outlive.
 *
 * That last exclusion is what closes GAP-007 rather than waiting on it. We could
 * not confirm how Alexa+ identifies a user across turns, so nothing here depends
 * on the answer: the grant is ours, and it outlives the conversation either way.
 */

/**
 * The subject of a passcode-authenticated grant.
 *
 * One shared passcode means exactly one user (GAP-011), so this is a constant
 * rather than a per-grant random id — re-pairing a device must not orphan the
 * history it already earned. The `passcode:` scheme names the authentication
 * method, so subjects minted by a real IdP later cannot collide with these.
 */
export const PASSCODE_SUBJECT = "passcode:default";

/** Subject used when auth is off (`VIVA_AUTH_DISABLED=1`) — local development only. */
export const LOCAL_SUBJECT = "local:dev";

/**
 * Reads the grant subject off a verified access token, or null if it carries
 * none. Null is a real answer, not a failure: the caller must then decline to
 * key a record rather than inventing a bucket to put it in.
 */
export function subjectOf(authInfo: AuthInfo | undefined): string | null {
  const subject = authInfo?.extra?.["subject"];
  return typeof subject === "string" && subject.length > 0 ? subject : null;
}

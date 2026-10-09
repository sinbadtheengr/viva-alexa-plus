import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { AuthConfig } from "./config.js";
import { DEFAULT_LOCALE } from "../config.js";
import { PASSCODE_SUBJECT } from "./identity.js";
import { PasscodeThrottle, normalizeIp } from "./throttle.js";
import { CONSENT_PATH, type VivaOAuthProvider } from "./provider.js";

/**
 * F-9 · The consent screen.
 *
 * A code is only ever minted after the user actively approves. Nothing here
 * auto-approves, because an authorization server that grants without asking is
 * not an authorization server.
 */

const MAX_ATTEMPTS = 5;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Constant-time comparison, so a wrong passcode leaks nothing through timing. */
function passcodeMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so the mismatch costs the same either way.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function page(options: {
  rid: string;
  clientName: string;
  resource: string | undefined;
  error?: string;
}): string {
  const error = options.error
    ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>`
    : "";
  const resource = options.resource
    ? `<dt>Resource</dt><dd><code>${escapeHtml(options.resource)}</code></dd>`
    : "";
  return `<!doctype html>
<html lang="${escapeHtml(DEFAULT_LOCALE)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Viva</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { display:grid; place-items:center; min-height:100vh; margin:0; background:#f6f6f4; }
  @media (prefers-color-scheme: dark) { body { background:#16161a; color:#eee; } }
  main { max-width:26rem; padding:2rem; background:canvas; border-radius:12px;
         box-shadow:0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size:1.25rem; margin:0 0 .25rem; }
  p.lead { margin:0 0 1.25rem; color:#666; font-size:.9rem; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:.35rem .75rem; font-size:.85rem;
       margin:0 0 1.25rem; }
  dt { color:#666; } dd { margin:0; }
  code { font-size:.8rem; word-break:break-all; }
  label { display:block; font-size:.85rem; margin-bottom:.35rem; }
  input { width:100%; padding:.6rem; font-size:1rem; border:1px solid #ccc;
          border-radius:6px; box-sizing:border-box; background:canvas; color:inherit; }
  .row { display:flex; flex-direction:column; gap:.75rem; margin-top:1.25rem; }
  button { width:100%; min-height:3.5rem; padding:.75rem; font-size:1.25rem; font-weight:600;
           border-radius:8px; cursor:pointer; border:2px solid transparent; }
  button.primary { background:#0b57d0; color:#fff; }
  button.secondary { background:transparent; border-color:#555; color:inherit; }
  button:focus-visible, input:focus-visible { outline:4px solid #f5a623; outline-offset:2px; }
  .error { color:#c0392b; font-size:.85rem; margin:0 0 1rem; }
</style></head><body><main>
<h1>Authorize ${escapeHtml(options.clientName)}</h1>
<p class="lead">This will let it run speaking exams and read your practice history.</p>
${error}
<dl><dt>Application</dt><dd>${escapeHtml(options.clientName)}</dd>${resource}</dl>
<form method="post" action="${CONSENT_PATH}">
  <input type="hidden" name="rid" value="${escapeHtml(options.rid)}">
  <label for="passcode">Passcode</label>
  <input id="passcode" name="passcode" type="password" autocomplete="current-password"
         autofocus required>
  <!-- GAP-016: the first submit button is the form's default, so pressing Enter in the
       passcode field activates it. Authorize must stay first in DOM order; Cancel follows.
       Stacked, not reordered with CSS, so visual and tab order agree. -->
  <div class="row">
    <button class="primary" type="submit" name="action" value="approve">Authorize</button>
    <button class="secondary" type="submit" name="action" value="deny">Cancel</button>
  </div>
</form>
</main></body></html>`;
}

function redirectWithError(
  res: Response,
  redirectUri: string,
  error: string,
  state: string | undefined,
): void {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (state !== undefined) target.searchParams.set("state", state);
  res.redirect(target.href);
}

function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
  return `${Math.ceil(s / 60)} minutes`;
}

export function consentRouter(
  provider: VivaOAuthProvider,
  config: AuthConfig,
  clock: () => number = Date.now,
): Router {
  const router = express.Router();
  const throttle = new PasscodeThrottle(config.throttle, clock);
  const attempts = new Map<string, number>();

  router.get(CONSENT_PATH, (req: Request, res: Response) => {
    const rid = typeof req.query["rid"] === "string" ? req.query["rid"] : "";
    const pending = provider.store.peekPending(rid);
    if (!pending) {
      res.status(400).type("html").send(
        "<p>This authorization request has expired. Start again from the application.</p>",
      );
      return;
    }
    const client = provider.clientsStore.getClient(pending.clientId);
    res
      .type("html")
      .send(
        page({
          rid,
          clientName: client?.client_name ?? pending.clientId,
          resource: pending.resource,
        }),
      );
  });

  router.post(CONSENT_PATH, express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body as Record<string, unknown>;
    const rid = typeof body["rid"] === "string" ? body["rid"] : "";
    const pending = provider.store.peekPending(rid);
    if (!pending) {
      res.status(400).type("html").send("<p>This authorization request has expired.</p>");
      return;
    }

    if (body["action"] === "deny") {
      provider.store.takePending(rid);
      attempts.delete(rid);
      redirectWithError(res, pending.redirectUri, "access_denied", pending.state);
      return;
    }

    const client = provider.clientsStore.getClient(pending.clientId);
    const ip = normalizeIp(req.ip ?? req.socket.remoteAddress);
    const refuse = (retryAfterMs: number, scope: "ip" | "global"): void => {
      const retrySeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res
        .status(429)
        .set("Retry-After", String(retrySeconds))
        .type("html")
        .send(
          page({
            rid,
            clientName: client?.client_name ?? pending.clientId,
            resource: pending.resource,
            error:
              scope === "ip"
                ? `Too many incorrect passcodes. Try again in ${waitText(retryAfterMs)}.`
                : `Too many incorrect passcodes were entered across the service. Try again in ${waitText(retryAfterMs)}.`,
          }),
        );
    };
    // Checked before the passcode is compared: a locked caller learns nothing, not even
    // whether the right passcode would have worked.
    const gate = throttle.check(ip);
    if (!gate.allowed) {
      refuse(gate.retryAfterMs, gate.scope);
      return;
    }

    const given = typeof body["passcode"] === "string" ? body["passcode"] : "";
    if (!passcodeMatches(given, config.passcode)) {
      const strike = throttle.recordFailure(ip);
      if (!strike.allowed) {
        refuse(strike.retryAfterMs, strike.scope);
        return;
      }
      const count = (attempts.get(rid) ?? 0) + 1;
      if (count >= MAX_ATTEMPTS) {
        // Burn the request rather than allowing unlimited guesses against it.
        provider.store.takePending(rid);
        attempts.delete(rid);
        redirectWithError(res, pending.redirectUri, "access_denied", pending.state);
        return;
      }
      attempts.set(rid, count);
      res
        .status(401)
        .type("html")
        .send(
          page({
            rid,
            clientName: client?.client_name ?? pending.clientId,
            resource: pending.resource,
            error: `Incorrect passcode. ${MAX_ATTEMPTS - count} attempt${
              MAX_ATTEMPTS - count === 1 ? "" : "s"
            } remaining.`,
          }),
        );
      return;
    }

    throttle.recordSuccess(ip);
    provider.store.takePending(rid);
    attempts.delete(rid);

    const code = provider.store.issueCode(
      {
        clientId: pending.clientId,
        // The passcode has just been verified, so this is the moment the user is
        // authenticated — and therefore the moment the grant's subject is fixed.
        // Everything F-7 keys progress on flows from here.
        subject: PASSCODE_SUBJECT,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        scopes: pending.scopes,
        resource: pending.resource,
      },
      config.authorizationCodeTtlSeconds,
    );

    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", code);
    if (pending.state !== undefined) target.searchParams.set("state", pending.state);
    res.redirect(target.href);
  });

  return router;
}

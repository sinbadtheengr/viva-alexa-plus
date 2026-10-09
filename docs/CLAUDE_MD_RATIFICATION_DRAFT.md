# Draft ratification wording for CLAUDE.md

**Status: items 1, 2 and 3 (option 1) were applied to `CLAUDE.md` and `package.json`. Items 4 and 5 are not applied.** CLAUDE.md is the
spec, and its own rule is that a spec disagreement is raised, not decided ad hoc. Each item below
gives the current spec text, what the code actually does (checked against `src/app.ts`,
`package.json`, `FRICTION_LOG.md`), a recommendation, and replacement text in the same style as
the existing `*(Ratified from GAP-xxx.)*` notes. Apply, edit or reject each one.

Evidence for every claim is in the repo; nothing below depends on the real Alexa+ host.

---

## 1. F-1 · "No SSE transport" vs. what the Streamable HTTP SDK does

**Current text (F-1):**
> Serve MCP spec **2025-11-25** over Streamable HTTP (JSON-RPC 2.0). No SSE transport.
> Single endpoint `POST /mcp`.

**What the code does:** the app mounts `/mcp` for every method (`app.all("/mcp", ...)` in
`src/app.ts`). POST requests carry JSON-RPC and the SDK's Streamable HTTP transport answers them
as `text/event-stream`, even for one-shot calls (FRICTION-011). GET opens the optional
server-to-client stream and DELETE ends a session, both per the Streamable HTTP spec. Each MCP
session has its own transport (GAP-015, closed).

**The real disagreement:** "No SSE transport" almost certainly means the deprecated standalone
HTTP+SSE transport from spec 2024-11-05, which Viva does not implement. Streamable HTTP itself
may frame a response as an SSE stream, and the SDK does. As written, the sentence is false of the
shipped server.

**Recommendation:** keep the intent (no legacy two-endpoint transport), fix the wording, and say
what clients must handle.

**Replacement text:**
> Serve MCP spec **2025-11-25** over Streamable HTTP (JSON-RPC 2.0) on the single endpoint
> `/mcp`. The deprecated standalone HTTP+SSE transport (spec 2024-11-05, separate `/sse` and
> message endpoints) is **not** implemented. `POST /mcp` carries every JSON-RPC request; `GET` and
> `DELETE` on the same path serve the transport's optional server stream and session teardown,
> keyed by `Mcp-Session-Id`. The transport may answer a POST with either `application/json` or a
> `text/event-stream` body, as Streamable HTTP allows, so a client must accept both. Each MCP
> session gets its own transport and server; exam sessions, progress, scorer and probes are shared
> across them. *(Ratified from FRICTION-011 and GAP-015.)*

---

## 2. F-9 · The protected-resource metadata path (repeats Amazon's documentation error)

**Current text (F-9):**
> Host protected-resource metadata at `/.well-known/oauth-authorization-server`
> advertising `code_challenge_methods_supported: ["S256"]`.

**What the code does:** two different documents are served, as the RFCs require (FRICTION-006):

| Document | RFC | Path served |
|---|---|---|
| Authorization server metadata | RFC 8414 | `/.well-known/oauth-authorization-server` (advertises `code_challenge_methods_supported: ["S256"]`) |
| Protected resource metadata | RFC 9728 | `/.well-known/oauth-protected-resource/mcp`, and the bare `/.well-known/oauth-protected-resource` returns the same document |

The 401 challenge carries a `resource_metadata` parameter pointing at the `/mcp`-suffixed form.
The sentence in the spec conflates the two documents, and the path it names hosts the
authorization-server document, not protected-resource metadata. Following it literally would
mislead the next implementer exactly as the Amazon docs did.

**Recommendation:** correct the sentence. This does not change any behaviour.

**Replacement text:**
> Publish **authorization-server metadata** (RFC 8414) at
> `/.well-known/oauth-authorization-server`, advertising
> `code_challenge_methods_supported: ["S256"]`, and **protected-resource metadata** (RFC 9728) at
> `/.well-known/oauth-protected-resource/mcp` (the bare `/.well-known/oauth-protected-resource`
> path returns the same document). The 401 response from `/mcp` carries a `WWW-Authenticate`
> challenge whose `resource_metadata` names the protected-resource document. *(Ratified from
> FRICTION-006: Amazon's QuickStart names the authorization-server path for the resource
> metadata, which are two different documents.)*

---

## 3. Stack line · "Node 24" vs. `engines: ">=22"`

**Current text (header):** `**Stack:** TypeScript, Node 24, ...`

**What the repo does:** `package.json` declares `"engines": { "node": ">=22" }`. Everything was
built and tested on Node 24.3.0 (the QA audit says so explicitly). Node 22 was never run.

**The real disagreement:** the repo advertises a floor it has not tested.

**Options** (pick one; I recommend the first):
1. **Make the declaration match what was tested.** Set `"engines": { "node": ">=24" }` in
   `package.json`. Smallest and fully honest; costs nothing at a hackathon.
2. **Keep `>=22` and verify it.** Run `npm ci && npm run build && npm test` on Node 22, and only
   then amend the spec to say 22 is supported. More work, no judging benefit.

**Replacement text (option 1):**
> **Stack:** TypeScript, **Node 24** (the version it is built and tested on; `engines` requires
> `>=24`), ...

(If you choose option 2, say instead: "Node 24 (tested), Node 22 supported as of <date>".)

---

## 4. Optional additions (spec is silent; code now does these)

These are not disagreements. They are behaviours added after the spec was written that a future
implementer would need to know. Skip them if you prefer to keep the spec short.

**F-4 · additive structured fields.** The spec says every tool returns `content` plus
`structuredContent`. Add:
> `structuredContent` fields are additive: new fields may appear, existing ones are never removed
> or retyped. Currently added: `phaseDeadline`, `serverNow` and `phaseSeconds` on `start_exam`,
> `get_status` and `advance_phase` (the MCP Apps countdown is computed from the server's clock,
> never a client clock), and `followUpSource: "seed" | "generated"` on `submit_response`.

**F-9 · hardening beyond the base flow.** The spec lists the flow but not these safeguards:
> A failed PKCE verification burns the authorization code, and presenting an already-used code
> revokes every token minted from it (RFC 6749 4.1.2, RFC 9700). Consent-screen passcode attempts
> are throttled per client IP with exponential backoff and a global slow-down backstop; the client
> IP is the socket address unless `VIVA_TRUST_PROXY` is set (a bare `true` is refused).
> Authorization codes and token lineage are held in memory and do not survive a restart.

**F-7 · persistence.** The spec says "a JSON store behind an interface". Add:
> The store is selected by `VIVA_PROGRESS_FILE`: unset keeps history in memory; set, it is written
> atomically (temp file, fsync, rename). A corrupt file stops the server at startup rather than
> being overwritten. One server process per file; there is no cross-process lock.

---

## 5. Not spec changes (for your decision elsewhere)

These came up in the same audit but belong in `GAPS_AND_ISSUES.md` or the code, not in the spec:

- **`npm run dev` is broken.** The sources import `./app.js`-style paths, so running them directly
  with `node --experimental-strip-types` fails with `ERR_MODULE_NOT_FOUND`. The README says to use
  `npm run build && npm start`. Either fix the script or delete it from `package.json`.
- **GAP-004 wording.** It asks that the pronunciation limitation be stated "in the UI". The demo
  client shows "Pronunciation is not assessed" (`index.html`) and the MCP Apps results view carries
  a disclaimer; the A9 note that this was unverified is now answered for the demo client.
- **GAP-014 (probes are one turn stale) and GAP-017 (microphone permission for the level meter)**
  are still open and are product decisions, not spec wording.

---

## How to apply

1. Edit `CLAUDE.md` with the replacement text you accept.
2. Run `npm run build && npm test` (no code changes are implied by items 1 and 2; item 3 option 1
   changes one line in `package.json`).
3. Commit with a message like `Ratify F-1, F-9 and stack wording (FRICTION-006, -011, GAP-015)`.
4. Delete this draft file, or keep it under `docs/` as the record of what changed and why.

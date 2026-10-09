# GAPS_AND_ISSUES — Viva

Severity: **S1** blocks the submission · **S2** degrades a judging criterion · **S3** polish.
Status: `OPEN` · `MITIGATED` · `CLOSED`.

## Index (as of 2026-10-08)

| ID | Sev | Status | Title | Friction log |
|---|---|---|---|---|
| GAP-001 | S1 | OPEN | `alexa-ai` CLI provenance is unverified | FRICTION-001, 004, 010 |
| GAP-002 | S1 | MITIGATED | Exam corpus cannot be third-party content | |
| GAP-003 | S2 | OPEN | Alexa+ is US / en-US; French demo path is unsafe | |
| GAP-004 | S2 | OPEN | No audio access means no pronunciation scoring | FRICTION-002 |
| GAP-005 | S2 | MITIGATED | <500ms budget vs. an LLM grading call | FRICTION-003 |
| GAP-006 | S2 | OPEN | Add-on certification may not complete before the deadline | FRICTION-010 |
| GAP-007 | S3 | CLOSED | Session identity across turns | |
| GAP-008 | S2 | CLOSED | Nothing happens when the speaking clock runs out | |
| GAP-009 | S3 | CLOSED | `provenance` is in the schema but not the spec | |
| GAP-010 | S3 | OPEN | Token revocation is not implemented | |
| GAP-011 | S2 | OPEN | User authentication is demo-grade | |
| GAP-012 | S2 | CLOSED | F-6 specified a `temperature` the model rejects | |
| GAP-013 | S3 | CLOSED | F-6's named Bedrock SDK is the legacy path | |
| GAP-014 | S3 | OPEN | F-5's probe is one turn stale when asked | FRICTION-008 |
| GAP-015 | S2 | CLOSED | The server accepted one MCP session per process | FRICTION-011 |
| GAP-016 | S3 | CLOSED | Pressing Enter on the consent screen denied the request | |
| GAP-017 | S3 | OPEN | F-8 level indicator needs the microphone; hosts unverified | FRICTION-012 |

---

## GAP-001 · S1 · OPEN · `alexa-ai` CLI provenance is unverified

The Alexa+ docs instruct you to install and run an `alexa-ai` CLI but **do not state where
it comes from** — no npm package name, no download link, on either the quickstart or the
Add-on API reference page. The obvious guess is actively dangerous:

```
npm view alexa-ai  →  2.5.0
  description: "AI engine for the Alexa WhatsApp bot: DeepAI-powered chat…"
  repository:  github.com/AlexaInc/deepai   (third party, not Amazon)
```

`alexa-ai` on the public npm registry is an **unrelated third-party package** that has
taken the name Amazon's own docs tell developers to type. Scoped alternatives
(`@amazon/alexa-ai`, `@alexa/alexa-ai`, `@amzn/alexa-ai`) do not exist.

**Do not install `alexa-ai` from npm.**

*Action:* obtain the CLI only from the Amazon developer console / an amazon.com-hosted
link. Verify publisher before any global install. Ask in the hackathon Discord or office
hours on day 1. → also **FRICTION-001**, and a strong candidate for a feature request.

---

## GAP-002 · S1 · MITIGATED · Exam corpus cannot be third-party content

The hackathon requires a **public GitHub repo with an open-source license**. The 80 TCF
mock tests in `tcf_deduplicator` are almost certainly licensed or copyrighted material and
**must not be committed here**, and IELTS cue cards are Cambridge/IDP property.

*Action:* author an original corpus in the same *format* (Part 1 topic sets, Part 2 cue
cards, Part 3 discussion ladders). Format and rubric criteria are not copyrightable;
specific items are. Keep `corpus/` provably original and note its provenance in the README.

*Status 2026-10-08:* mitigated, not closed. Every corpus file must carry a `provenance`
string or the loader refuses to start (GAP-009), and both shipped files state that the items
were newly written for this project with AI assistance and not copied or adapted from
published exam material. That is the author's attestation; the repo cannot prove originality
beyond it, so the owner should still skim `corpus/` before submission.

---

## GAP-003 · S2 · OPEN · Alexa+ is US / en-US — French demo path is unsafe

Alexa+ add-ons are documented as available in the United States, and the CLI example passes
`--locale en-US`. Whether Alexa+ will conduct a sustained **French** conversation for TCF
Expression Orale is unverified and outside our control.

*Action:* build the exam engine language-parameterized from the start (locale is a
parameter of every corpus item and rubric, never hardcoded). Demo IELTS/en-US. Test French
in week 3; if it works, it is a closing beat in the video, not a dependency.

---

## GAP-004 · S2 · OPEN · No audio access means no pronunciation scoring

MCP tools receive the transcribed turn, not the raw audio. Pronunciation and accent —
one of IELTS's four criteria — are therefore not assessable.

*Action:* scope honestly to the three transcript-observable criteria (Fluency & Coherence,
Lexical Resource, Grammatical Range & Accuracy). State the limitation in the UI rather than
faking a fourth score. → **FRICTION-002** and a genuine feature request to Amazon.

---

## GAP-005 · S2 · MITIGATED · <500ms latency budget vs. an LLM grading call

The documented round-trip budget is **under 500ms**. A Bedrock rubric-scoring call will not
finish in that window.

*Action:* split the work. Turn-taking tools (`start_exam`, `submit_response`,
`advance_phase`) stay local and fast. Scoring is deferred: `score_session` kicks off async
work and returns immediately; results are collected on a follow-up turn while Alexa+ is
naturally saying "let me pull your results together." Design for this from day 1 — it is
not a late optimization.

*Latest evidence:* HTTP-level numbers over real OAuth and Streamable HTTP are in
[docs/latency.md](docs/latency.md) (client p95 under 1 ms on loopback, with fakes for the
model). The in-process figures below predate it.

*Measured 2026-09-11*, once F-2/F-3 landed — the turn-taking path is effectively free:

| Operation | Mean over 2,000 runs |
|---|---|
| `create` | 0.0010 ms |
| `get_status` | 0.0002 ms |
| `advance_phase` | 0.0014 ms |
| `submit_response` | 0.0003 ms |
| full 8-op exam walk-through | 0.071 ms |

The state machine consumes ~0.014% of the per-tool budget, so the entire 500ms is
available to HTTP and Alexa+ transport. The split was the right call: every millisecond
of risk now sits in the network and in Bedrock, and Bedrock is off the critical path.

---

## GAP-006 · S2 · OPEN · Add-on certification may not complete before the deadline

`alexa-ai submit` sends the add-on for **certification**, with no published timeline. A
review queue in mid-October could outlast the submission window.

*Action:* target the **development stage + web simulator** as the demo surface — the rules
require the technology be called in real code, not that the add-on be publicly certified.
Record the demo video against the simulator. Treat certification as upside.

---

## GAP-007 · S3 · CLOSED · Session identity across turns

The state machine needs a stable session key. How Alexa+ identifies the user to the MCP
server across turns (OAuth subject? per-conversation id?) needs confirming before the
progress-tracking feature (F-7) is built on it.

**Resolved 2026-09-18: key on the OAuth grant subject, and ignore whatever Alexa+ sends per
conversation.** Ratified into CLAUDE.md under F-7.

The question this gap asked could not be answered from the docs, and waiting for an answer
would have left F-7 unbuilt — so the resolution removes the dependency instead of satisfying
it. A subject is fixed when the user authenticates at the consent screen, rides the
authorization code onto every token minted from it, survives refresh rotation, and arrives at
the tools as `AuthInfo.extra.subject`. Whatever Alexa+ does per conversation, the grant is
ours and it outlives the conversation.

Rejected alternatives, each for a concrete reason: the bearer token rotates hourly, so a
history keyed on it would die on every refresh; `clientId` identifies Alexa+ rather than the
person; a per-conversation id resets exactly when progress is supposed to accumulate.

The paired invariant is that a record which cannot be attributed is not written. Keying an
unattributable session to a fallback constant would quietly merge two candidates' histories —
so `get_results` reports `progressRecorded: false` (while still reading the marks out), and
`get_progress` says it cannot tell whose history it is instead of reporting an empty one.
Tests drive two subjects through one shared store to prove the separation is real.

---

## GAP-008 · S2 · CLOSED · Nothing happens when the speaking clock runs out

F-3 specifies phase deadlines but not what enforces them. As built, when a candidate's
speaking time expires the deadline simply passes: `secondsRemaining` floors at 0 and the
session sits in `speaking` until it idles out. A real examiner stops you.

This is a **spec defect, not an implementation choice** — F-3 and F-4 between them never
say who notices the expiry. Nothing in MCP lets a server interrupt; only Alexa+ can speak
unprompted, and only if something tells it to.

*Candidate resolutions, to decide before F-4:*
1. `get_status` returns an `overrun: true` flag and Alexa+ is instructed, in the tool
   description, to cut the candidate off — puts the behavior in the model's hands.
2. `submit_response` accepts a late transcript but marks the turn `overrun`, and F-6
   reflects it in the Fluency & Coherence score — truthful, and needs no interruption.
3. Both.

**Resolved 2026-09-11: option 2**, ratified into CLAUDE.md under F-3 ("Overrun"), F-4 and
F-6. Deadlines are observed, never enforced by interruption: a late turn is accepted in
full and marked `overrun`, the session accumulates `overrunSeconds`, `get_status` exposes
it so a caller *may* prompt, and F-6 scores it as Fluency & Coherence evidence. Nothing in
the exam depends on Alexa+ choosing to interrupt, which is the property that made this the
only safe option.

---

## GAP-009 · S3 · CLOSED · `provenance` is in the corpus schema but not in the spec

F-2's `ExamItem` definition has no file-level fields. Implementation added a **required**
`provenance` string per corpus file, so that GAP-002 (no third-party exam content) is
enforced by the loader rather than by good intentions — an undocumented corpus file now
fails to load.

**Resolved 2026-09-11: kept and written into F-2.** Spec and code now agree.

---

## GAP-010 · S3 · OPEN · Token revocation is not implemented

F-9 lists what must be built (authorization code + PKCE, 401, metadata, `resource`) and what
must not (DCR, OIDC, step-up). Revocation appears in neither list, so it was left out rather
than decided ad hoc. The SDK mounts `/revoke` only when the provider implements `revokeToken`,
so it is currently absent from the metadata too - which is at least self-consistent.

The SDK's own interface calls omitting it "not recommended". It is perhaps fifteen lines:
`revokeToken(client, request)` plus `AuthStore.revokeToken`, which already exists.

*Action:* decide whether F-9 should require it. Low risk either way for a demo, but a
long-lived refresh token with no way to revoke it is a poor default for anything real.

---

## GAP-011 · S2 · OPEN · User authentication is demo-grade

The authorization server authenticates the *user* with a single shared passcode
(`VIVA_DEMO_PASSCODE`), compared in constant time. That is enough to demonstrate a correct
OAuth 2.1 + PKCE flow and to keep the server closed by default, and it is honest about what
it is - but it is not identity.

*Guess throttling (QA S1, 2026-10-08).* The original five-attempts-per-authorization-request
cap was not a limit at all, because `GET /authorize` mints new request ids for anyone (200
guesses in 162 ms were observed). The consent POST now also enforces, in `src/auth/throttle.ts`:
- a per-client-IP lockout (5 failures, then 60 s, doubling on each repeat up to 1 h, forgotten
  after 15 quiet minutes). A locked IP is refused even with the correct passcode; other IPs
  are unaffected. Refusals are `429` with `Retry-After` and an on-page message. IPv6 is
  keyed by /64.
- a global backstop: 50 failures across all IPs in 10 minutes puts the endpoint in slow mode
  (one attempt per 30 s from anyone) until the window rolls over. It slows, never disables,
  and recovers automatically.
- client IP is the socket address; `X-Forwarded-For` is honoured only when
  `VIVA_TRUST_PROXY` is set. Memory is bounded (10 000 tracked IPs, oldest evicted).

Still demo-grade: the throttle is in process memory (resets on restart, not shared across
instances). Slow mode means a determined attacker can keep the legitimate user waiting up to
a window by burning the global budget, though not locked out indefinitely. A short passcode
is still guessable in the long run at roughly 5 guesses per IP per minute, so use a long
random one on any public host. Behind a proxy that is not declared via `VIVA_TRUST_PROXY`,
all clients share one address and one lockout.

Consequences today:
- There is one credential, so there is one grant subject (`passcode:default`). F-7 keys
  progress on that subject through a real code path — the separation works, it is simply
  degenerate while every authorization authenticates the same person. *(Updated 2026-09-18:
  this no longer blocks F-7, which shipped keyed on the grant subject per GAP-007.)*
- There is no account recovery, no per-device revocation, no audit of who authorized what.

*Action:* for anything beyond the hackathon, delegate user authentication to a real IdP and
keep this server as a pure resource server - `mcpAuthMetadataRouter` exists for exactly that
shape. The swap is now confined to one place: whatever mints the subject at consent time.
Subjects carry a scheme prefix (`passcode:`) so IdP-minted ones cannot collide with these.

---

## GAP-012 · S2 · CLOSED · F-6 specified a `temperature` the model rejects

F-6 said to "retry once at temperature 0" on invalid rubric output. **Claude Opus 5 removed
sampling parameters**: sending `temperature`, `top_p` or `top_k` returns a 400. The spec was
written against an older API shape, so following it literally would have made every retry
fail - and the retry path only runs when something has already gone wrong, so this would
have stayed invisible until the first malformed response in production.

**Resolved 2026-09-11.** Two changes, both ratified into F-6:

1. The allowed band set is baked into a per-exam structured-output schema, so an
   out-of-scale level cannot be generated in the first place. Validation still runs
   independently - if the guarantee ever slips we drop the score rather than report it.
2. The retry raises `effort` from `high` to `max` and restates what was rejected. Effort is
   the current lever for "think harder and be stricter"; temperature no longer exists.

This is a forced correction rather than a judgement call - there is no configuration in
which the original instruction works - but it is recorded here because the spec changed.

---

## GAP-013 · S3 · CLOSED · F-6's named Bedrock SDK is the legacy path

F-6's stack line named `@aws-sdk/client-bedrock-runtime`, the InvokeModel path. Anthropic's
current guidance for Bedrock is the **Mantle client** (`@anthropic-ai/bedrock-sdk` ->
`AnthropicBedrockMantle`), which exposes the same `messages.*` surface as the first-party
SDK - so structured outputs, effort and the rest work without a second dialect, and the
grading code would port to the first-party API by swapping one constructor.

**Resolved 2026-09-11.** Swapped, and the stack line in CLAUDE.md updated.
`@aws-sdk/client-bedrock-runtime` removed from the dependency tree.


---

## GAP-014 · S3 · OPEN · F-5's probe is one turn stale when it is finally asked

F-5 fires the Bedrock call on each `submit_response` and says the probe replaces the seed
"on the next turn" if it has arrived. But the reply to turn N must return immediately
(hard rule 3), so the probe grounded in answer N can only be asked in reply to answer N+1.
By then the candidate has said something newer, and a question that quotes answer N may
sound like it ignored their last words.

Implemented literally (probe from turn N replaces the seed returned for turn N+1, discarded
if not arrived, never used two turns late). Options if it feels wrong in a live run:
(a) accept it; (b) have the prompt ground only in the earliest-stated theme, not details;
(c) feed the model the last two answers and ask it to bridge. All need a product call.

Also unspecified: the probe replaces seed *wording* only; the seed count still decides when
the exam ends (`exhausted`). Generated probes never extend an exam. Added
`followUpSource: "seed" | "generated"` to `submit_response` structuredContent (additive).

## GAP-015 · S2 · CLOSED · The server accepts one MCP session per process

**Resolution:** `createApp` now keeps a map of MCP connections keyed by `Mcp-Session-Id`, each a
`StreamableHTTPServerTransport` + `McpServer` pair. A lone `initialize` POST always creates a new
pair (a stale session id on it is ignored, so a reload works); other requests route by header;
unknown id -> 404, missing id -> 400, DELETE closes and removes. Exam sessions, progress, scorer and
probes are built once in `createApp` and shared by every pair, so an exam outlives the MCP connection
that started it. Auth guards run first and unchanged; `req.auth` reaches each tool call per request.
Connections are swept when idle (`VIVA_MCP_SESSION_IDLE_MS`, default 30 min; unref'd interval) and
capped (`VIVA_MCP_SESSION_MAX`, default 100, least-recently-used evicted). Tests: `tests/mcp-sessions.test.ts`.
Not done: a connection is not bound to the subject that opened it (a different valid token holding
a leaked session id could use it). Ids are random UUIDs and the bearer check still applies.

Related friction: FRICTION-011.

*Original report follows.*


Found while building the demo client (A2). `createApp` connects a single
`StreamableHTTPServerTransport` with a session-id generator, and that transport allows exactly
one `initialize` for its lifetime. Verified live: after one client initialises, any second
`initialize` (a page reload, a second browser tab, a reconnecting Alexa+) is answered
`400 Invalid Request: Server already initialized`, and the only cure is restarting the server.

This matters beyond the demo: Alexa+ will open a new MCP session per conversation or per
device, so the first conversation after deployment would work and the next would not.

*Mitigation in the demo client:* it remembers its `Mcp-Session-Id` in `sessionStorage`, so a
reload in the same tab reuses it, and it reports the 400 plainly when it cannot.
*Decision needed (not taken here; later taken, see the resolution above):* per-session transports (a transport and `McpServer`
per `initialize`, sharing the session/progress stores), or stateless mode. That changes
`src/app.ts` and the F-1 spec, so it is registered rather than decided.

---

## GAP-016 · S3 · CLOSED · Pressing Enter on the consent screen denied the request

`src/auth/consent.ts` rendered Cancel before Authorize inside one form, so the form's default
button was Cancel. Typing the passcode and pressing Enter submitted `action=deny` and
redirected to the client with `error=access_denied`.

*Closed:* Authorize is now first in DOM order, so it is the form's default submit button and
Enter authorizes. Cancel follows it. The buttons are stacked full width (Authorize on top)
rather than reordered with CSS, so tab order and visual order agree; they are 3.5rem tall
with 1.25rem type, a darker primary blue and a visible 4px focus outline, and nothing depends
on hover. Server behaviour is unchanged: only `action=deny` denies, the passcode is still
checked on every other submission, and the deny path still redirects to the validated
redirect URI with `access_denied`. Tests in `tests/consent.test.ts`. No product decision was
needed. Not checked: a real Echo Show or Alexa+ host.


---

## GAP-017 · S3 · OPEN · F-8 "minimal level indicator" needs the microphone, and Alexa+ hosts are unverified

F-8 asks the Speaking view for "a minimal level indicator". The server receives a
transcript, never audio (GAP-004), so the only honest level meter is one the *view* draws
from the device microphone, locally. Implemented that way: the speaking resource declares
`_meta.ui.permissions.microphone`, the view feature-detects `getUserMedia`, analyses the
signal on-device and shows nothing if access is refused. It never draws a fake or
time-driven meter, records nothing, and sends nothing. Nothing in the meter is scored.

Product calls this does not make for you:
(a) whether an Echo Show host will grant a page its microphone at all while Alexa+ is
listening on the same hardware (unknown; no host available here), and whether a permission
prompt mid-exam is acceptable; if not, drop the `permissions` declaration and the meter
disappears, leaving the elapsed-time bar as the only speaking indicator;
(b) whether the view should show anything when there is no meter (currently it shows none).

Also recorded, not decided: one tool can return two kinds of payload (`advance_phase` gives
a cue card during preparation and a speaking clock afterwards), but the standard links one
resource per tool. All three documents therefore share one script and pick the layout from
`structuredContent.view`, with the linked resource only supplying the default. Tool-to-view
links: `start_exam` and `advance_phase` -> cue card, `get_status` and `submit_response` ->
speaking, `get_results` -> results. `score_session` and `get_progress` have no view.

Additive `structuredContent` fields added for the clock: `phaseDeadline` (epoch ms or null),
`serverNow` and `phaseSeconds` on `start_exam`, `get_status` and `advance_phase`; and the
prompt, bullets, exam, part, locale, topic, `prepSeconds` and `speakSeconds` on
`advance_phase` so the cue card keeps its content. A view counts down from
`phaseDeadline - serverNow` minus its own elapsed time, never from its wall clock.

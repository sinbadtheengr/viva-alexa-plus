# GAPS_AND_ISSUES — Viva

Severity: **S1** blocks the submission · **S2** degrades a judging criterion · **S3** polish.
Status: `OPEN` · `MITIGATED` · `CLOSED`.

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

## GAP-002 · S1 · OPEN · Exam corpus cannot be third-party content

The hackathon requires a **public GitHub repo with an open-source license**. The 80 TCF
mock tests in `tcf_deduplicator` are almost certainly licensed or copyrighted material and
**must not be committed here**, and IELTS cue cards are Cambridge/IDP property.

*Action:* author an original corpus in the same *format* (Part 1 topic sets, Part 2 cue
cards, Part 3 discussion ladders). Format and rubric criteria are not copyrightable;
specific items are. Keep `corpus/` provably original and note its provenance in the README.

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
(`VIVA_DEMO_PASSCODE`), compared in constant time, with five attempts per authorization
request. That is enough to demonstrate a correct OAuth 2.1 + PKCE flow and to keep the
server closed by default, and it is honest about what it is - but it is not identity.

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

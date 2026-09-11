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

## GAP-007 · S3 · OPEN · Session identity across turns

The state machine needs a stable session key. How Alexa+ identifies the user to the MCP
server across turns (OAuth subject? per-conversation id?) needs confirming before the
progress-tracking feature (F-7) is built on it.

---

## GAP-008 · S2 · OPEN · Nothing happens when the speaking clock runs out

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

Option 2 is the one that survives an unreliable interrupt path, so it is the likely answer;
it needs ratifying in CLAUDE.md rather than being decided inside F-4.

---

## GAP-009 · S3 · OPEN · `provenance` is in the corpus schema but not in the spec

F-2's `ExamItem` definition has no file-level fields. Implementation added a **required**
`provenance` string per corpus file, so that GAP-002 (no third-party exam content) is
enforced by the loader rather than by good intentions — an undocumented corpus file now
fails to load.

This is an addition to the spec made during implementation. It should be written into
F-2 in CLAUDE.md so the spec and the code agree, or removed.

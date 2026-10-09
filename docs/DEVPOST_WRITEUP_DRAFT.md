# Devpost project write-up (draft)

Regenerated from the repo as of `main` at 2026-10-09: 273 tests across 14 files, 59 corpus
items (49 IELTS en-US, 10 TCF fr-FR), 17 gaps registered, 12 friction entries. Every claim below
can be checked against `README.md`, `GAPS_AND_ISSUES.md`, `FRICTION_LOG.md`, `docs/latency.md`
and the tests. Items in `<...>` are the owner's to settle, and the section headings are the ones
Devpost supplies. Update the numbers if the repo changes before you submit.

---

## Inspiration

A speaking exam is the one part of IELTS and TCF preparation you can't do by typing. It needs a
live examiner, a running clock, and follow-up questions that react to what you actually said.
Human practice partners are expensive and hard to schedule, and most apps just record you and
say nothing back. Alexa+ already sits in the kitchen, hands-free and always available, so it
felt like the right place for an examiner: you practise while you cook.

It is also a good test of what an MCP server is for. A conversational model can chat about an
exam, but it can't own a clock, enforce phases, or keep a rubric and a history that outlive a
single turn. That state belongs on a server.

## What it does

Viva is a self-hosted MCP server that turns Alexa+ into a timed, rubric-scored speaking
examiner.

- **Runs the exam.** IELTS Speaking Parts 1 to 3 in en-US, plus a smaller TCF set in fr-FR. The
  server computes every deadline from the exam item; the caller never supplies one.
- **Observes the clock, never cuts you off.** An MCP server can't interrupt a speaker, so a late
  answer is accepted and marked as an overrun. The grader weighs it under Fluency & Coherence,
  as a human examiner would.
- **Keeps turns fast.** Turn-taking tools never wait on a model. Follow-ups come from the exam
  bank immediately, and a Bedrock-generated probe grounded in your own words can replace one only
  if it has already arrived.
- **Scores on three criteria.** Fluency & Coherence, Lexical Resource, and Grammatical Range &
  Accuracy, each with a band (IELTS 1 to 9) or level (TCF A1 to C2), a sentence of evidence
  quoting you, and one concrete improvement.
- **Never scores pronunciation.** The server receives a transcript, not audio, and says so.
- **Remembers you.** Your weakest criterion across sessions, and the topics where it recurs,
  filed under your sign-in rather than anything that resets every conversation.
- **Degrades to voice.** Every tool returns spoken text. Three MCP Apps views (cue card with a
  live countdown, speaking, results) are an addition, not a dependency.

## How we built it

- **Stack.** TypeScript on Node 24, the official MCP TypeScript SDK, Express, and zod. The server
  speaks MCP spec 2025-11-25 over Streamable HTTP with seven tools: `start_exam`, `get_status`,
  `submit_response`, `advance_phase`, `score_session`, `get_results`, `get_progress`.
- **Spec-first.** I wrote decision-free feature specs (F-1 to F-9) and a gaps register before
  coding, so each implementation task needed no product judgment. When a spec forced a decision,
  it went into the register instead (17 entries so far, 9 closed or mitigated).
- **Server-owned exam.** A state machine (`idle → briefing → prep → speaking → followup →
  scoring → complete`) owns the phases and deadlines. An illegal call returns an error naming
  the current phase and the legal next actions, so the model can recover in conversation.
- **Honest scoring.** Scoring runs on Claude Opus via Amazon Bedrock, asynchronously: the call
  returns a pending handle and the client polls. The allowed band set is baked into a per-exam
  structured-output schema and validated again independently. On invalid output it retries once,
  then returns only the criteria that verified, with a note on how many were left out. A model or
  network failure is reported as "unavailable", never as a low band.
- **Auth.** OAuth 2.1 with PKCE (S256), RFC 8707 `resource` binding, hashed tokens, refresh
  rotation, and no Dynamic Client Registration. A failed PKCE check burns the authorization code,
  replaying a used code revokes the tokens issued from it, and passcode guessing on the consent
  screen is throttled per IP.
- **Original content.** The corpus holds only original practice items, and every corpus file
  must carry a `provenance` statement or the server refuses to start.
- **The demo surface.** The Alexa+ add-on toolchain isn't open to hackathon participants, so I
  built to the open MCP spec and wrote a small browser client that plays the Alexa+ role: OAuth
  sign-in, the seven tools, speech out and in. Everything in the demo goes through the same MCP
  tools.
- **How it was built.** I wrote the specs and made the design calls, and used Claude Code with
  parallel agents for implementation, review and documentation, merging each piece only after
  the build and tests passed. 273 tests. <OWNER: edit this disclosure to match the hackathon's AI
  rules.>

## Challenges we ran into

- **The toolchain was closed.** The `alexa-ai` CLI, Local Inspector, simulator and certification
  are partner-only, and the docs never say where to get the CLI; the obvious npm name belongs to
  an unrelated package. I built to the spec and made my own stand-in client, which cost about a
  day. Everything is verified against that stand-in, not a real Alexa+ host.
- **A 500 ms budget against an LLM grader.** Grading can't fit in a turn. Splitting it into
  start-and-poll kept every turn-taking tool fast, and the exam never blocks on a model.
- **Nobody can interrupt the speaker.** Deadlines are observed, not enforced. An overrun is
  scored as evidence instead of punished.
- **Who is the user?** Alexa+'s per-conversation identifiers reset every conversation, which is
  exactly what progress has to outlive. I keyed history on the OAuth grant subject instead, and a
  session that can't be attributed is not recorded at all, rather than filed under a shared key.
- **Spec and platform drift.** The original plan asked for `temperature: 0`, which Opus 5
  rejects, so I used the `effort` setting. Amazon's docs name the wrong well-known path for
  protected-resource metadata, and a wrong OAuth error type in the SDK silently broke token
  refresh until an end-to-end test caught it. All twelve friction entries are in the repo.
- **Single-session servers.** The first transport accepted one `initialize` per process, so a page
  reload failed. Caught by the demo client, fixed with per-session transports.

## Accomplishments that we're proud of

- **Honesty rules enforced by tests.** A criterion that can't be verified is dropped and
  reported, two attempts are never merged into one score, a partial result is never padded to
  three, and pronunciation is never scored.
- **Fast by measurement.** In a local benchmark over the real OAuth and HTTP path, every tool
  stays well inside its budget: client round trips are about 1 ms at p95, against budgets of 50
  to 150 ms, and the slowest single call in the run was under 5 ms. `score_session` returns while a
  3-second fake grader is still running, and a probe generator that never answers does not slow a
  turn. These are loopback numbers, not Alexa+ end-to-end latency.
- **Works with the model down.** Scoring is opt-in, follow-ups fall back to the exam bank, and
  the exam runs to completion without any LLM.
- **Security beyond the checklist.** A separate QA pass (run by another AI agent, not a human reviewer) found no blockers; I fixed its findings,
  including the code-burn, replay revocation and passcode throttle, and `npm audit` is clean.
- **A friction log worth reading.** Twelve entries, each with what I expected, what happened, the
  impact in minutes and a concrete fix, with three marked as upstream contribution candidates.

## What we learned

- A voice-first product should treat the screen as an accessory. The exam is speech under time
  pressure.
- With an assistant in the loop, tool errors are user experience. An error that names the phase
  and the legal next moves lets the model recover mid-conversation.
- Being honest about what a system can't measure builds more trust than a confident number. No
  audio means no pronunciation score.
- Keep identity anchored to something you control, like the OAuth grant, not an identifier the
  platform hands you per turn.
- An end-to-end test catches what unit tests can't. Both the wrong-OAuth-error bug and the
  single-session bug only showed up through a real client.

## What's next for Viva: Mock Speaking Exams by Voice

- **A real Alexa+ host.** Move from my stand-in client to the real add-on path once the toolchain
  opens to participants, and verify the MCP Apps views and microphone permission on a device.
- **Live Bedrock, measured.** <OWNER: if you have run it, replace this with what you observed.
  Otherwise:> Scoring and follow-up probes are implemented and tested with fakes. The first job
  is a real run against Bedrock to confirm the request shapes, including the `effort` setting on
  plain message calls.
- **Fresher follow-ups.** A generated probe is always one turn stale. Either accept that, or wait
  briefly for it at the cost of latency.
- **Real accounts.** Replace the single shared passcode with a proper identity provider and add a
  token revocation endpoint.
- **More content and languages.** A larger original question bank across all three parts, and
  French on Alexa+ once the platform supports it.
- **Audio-aware scoring.** If the platform ever offers opt-in prosody, pronunciation could be
  added without guessing. Until then, it stays out.

---

## Check before pasting

- **Live claims.** Nothing above claims a live Bedrock run, a real Alexa+ device, or speech
  recognition verified on hardware. If you do those before submitting, update the relevant bullets
  (and the "What's next" Bedrock line) instead of leaving them as "untested".
- **"Twelve friction entries" and "273 tests"** match the repo today. Re-count before you submit.
- **Scoring in the video.** If the video shows Bedrock scoring, the claims here are consistent;
  if it shows "unavailable", say so in the description.
- **AI disclosure.** Matches `docs/SUBMISSION_WINDOW_CHANGES_DRAFT.md`; keep the two consistent.

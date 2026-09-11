# PROJECT_OVERVIEW — Viva

## The problem

Speaking is the section candidates fail and the section they cannot practise alone.
IELTS alone tests ~4M candidates a year; TCF is the standard exam for francophone
immigration to Canada. Preparation options are a human tutor at $40–80/hour, or apps
that grade typed answers — which tests a different skill entirely.

What a candidate actually needs is repetition against a clock with an examiner who
reacts. That is a conversation, not a screen.

## Why Alexa+ specifically

| Property of a speaking exam | What Alexa+ provides |
|---|---|
| Must be spoken, not typed | Voice-first surface, no keyboard in the loop |
| Hands-free, ambient, repeatable daily | A device already in the kitchen |
| Examiner reacts to your answer | Reasoning engine invoking tools mid-conversation |
| Timed phases, strict structure | Server-side state machine via MCP tools |
| Cue card + score breakdown | MCP Apps interactive UI on Echo Show |

If any one of those were false, this would belong on the web. All five hold.

## Scope

**In scope for the submission**
- IELTS-style Speaking Parts 1, 2, 3 in en-US — the demo path
- Server-side session state machine with real timing (Part 2: 60s prep, 120s speak)
- Follow-up question generation grounded in the candidate's own transcript
- Rubric scoring on Amazon Bedrock across the three transcript-observable criteria
- MCP Apps UI: cue card, live countdown, score breakdown
- Progress tracking across sessions — recurring weak areas
- OAuth 2.1 + PKCE, public HTTPS deployment

**Explicit non-goals**
- Pronunciation scoring — the server receives transcript, not audio (see GAP-004)
- Shipping any third-party copyrighted exam content (see GAP-002)
- French / TCF as the demo path — built language-parameterized, demoed in en-US (GAP-003)

## Judging alignment

Four equally weighted criteria. What we lead with for each:

- **Tech Implementation** — a real MCP state machine with timing, not a stateless Q&A
  wrapper; MCP Apps UI; OAuth 2.1 + PKCE done properly; sub-500ms tool latency.
- **Design** — the interaction model *is* the exam's own interaction model. Nothing invented.
- **Potential Impact** — a named, large, motivated audience with a measurable outcome
  (a band score) and a daily-repetition habit loop.
- **Quality of Idea** — picks the one language-learning task that genuinely cannot be
  done on a screen, rather than porting a screen task to voice.

## Stacked prizes

- **Alexa+ track** — primary.
- **AWS Builder mini-challenge** — Bedrock is load-bearing in grading and follow-up
  generation, not decorative.
- **Open Source mini-challenge** — MIT repo plus one genuine upstream contribution.
- **Friction log** — up to 10% judging bonus; written continuously, not retrofitted.

## Six-week plan (today: 2026-09-10 → deadline 2026-10-23 12:00 PT)

| Week | Dates | Goal | Done means |
|---|---|---|---|
| 1 | Sep 10–16 | **Retire the platform risks** | `alexa-ai` obtained from a verified Amazon source; a hello-world MCP server reachable by Alexa+; add-on registration confirmed available |
| 2 | Sep 17–23 | Exam engine | State machine + corpus + tools pass local MCP inspector tests |
| 3 | Sep 24–30 | Intelligence | Bedrock follow-ups + rubric scoring, validated against sample answers |
| 4 | Oct 1–7 | Make it real | OAuth 2.1 + PKCE, public HTTPS, <500ms, end-to-end in the web simulator |
| 5 | Oct 8–14 | Surface | MCP Apps UI, progress tracking, polish |
| 6 | Oct 15–22 | Ship | Demo video, submission copy, friction log, OSS contribution, buffer |

**Submit by Oct 21**, two days early. Week 1 is deliberately risk-retirement: every
unknown that could invalidate the approach is front-loaded, because the fallback
(a simulated Alexa+ experience in a web app, which the rules permit) needs to be chosen
by end of Week 2 at the latest — not discovered in Week 5.

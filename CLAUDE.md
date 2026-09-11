# CLAUDE.md — implementation specs for Viva

Decision-free specs. Every design decision is already made here; implementing an F-x should
require no product judgment. If a spec forces a decision, that is a defect in the spec —
raise it in GAPS_AND_ISSUES.md rather than deciding ad hoc.

**Stack:** TypeScript, Node 24, `@modelcontextprotocol/sdk`, `@modelcontextprotocol/ext-apps`,
`@aws-sdk/client-bedrock-runtime`, `zod`, `vitest`. No database in v1 — sessions in memory,
progress in a JSON store behind an interface so it can be swapped.

**Hard rules**
1. `corpus/` contains **only original content**. Never commit third-party exam items (GAP-002).
2. Locale is a parameter everywhere. No hardcoded `"en-US"` outside config (GAP-003).
3. Turn-taking tools must not make network calls to an LLM. Only `score_session` may (GAP-005).
4. Never report a pronunciation score. Three criteria only (GAP-004).
5. `npm run build && npm test` must pass before any F-x is considered done.

---

## F-1 · MCP server over Streamable HTTP

Serve MCP spec **2025-11-25** over Streamable HTTP (JSON-RPC 2.0). No SSE transport.
Single endpoint `POST /mcp`. Health check at `GET /healthz` returning `{ok:true,version}`.
Structured request logging with per-tool duration in ms — needed to prove the 500ms budget.

## F-2 · Exam corpus schema

`corpus/<locale>/<exam>.json`, validated by a zod schema at load time; the server refuses to
start on an invalid corpus.

```
ExamItem {
  id: string              // stable, e.g. "ielts.p2.work.001"
  exam: "ielts" | "tcf"
  locale: string          // "en-US", "fr-FR"
  part: 1 | 2 | 3
  topic: string           // "work", "hometown"
  prompt: string          // spoken to the candidate
  bullets?: string[]      // Part 2 cue card sub-points
  prepSeconds: number
  speakSeconds: number
  followUpSeeds: string[] // fallback probes if Bedrock is unavailable
}
```

`followUpSeeds` is mandatory: the exam must run to completion with the LLM entirely down.

Each corpus **file** additionally carries a required `provenance` string describing where
its content came from. An undocumented corpus file fails to load, so hard rule 1 is
enforced by the loader rather than by good intentions. *(Ratified from GAP-009.)*

## F-3 · Session state machine

Phases: `idle → briefing → prep → speaking → followup → scoring → complete`.
Transitions are server-owned; a tool call that is illegal for the current phase returns an
MCP error naming the current phase and the legal next actions.

Each session stores: id, locale, exam, part, item id, phase, phase deadline (epoch ms),
turns (`{role, text, at, overrun}`), and a scoring handle. Phase deadlines are computed
server-side from the corpus item — never passed in by the caller.

Sessions expire after 30 minutes idle.

### Overrun — what happens when the clock runs out

*(Ratified from GAP-008, option 2.)* Deadlines are **observed, not enforced by
interruption**. An MCP server cannot interrupt a speaker, and a design that depends on
Alexa+ choosing to cut the candidate off would fail silently whenever it didn't.

So: a late `submit_response` is always accepted, and the turn is marked `overrun: true`
when it arrives after `phaseDeadline`. The session records `overrunSeconds` — how far past
the limit the candidate ran. `get_status` reports `overrun` so a caller *may* prompt, but
nothing depends on it doing so.

Overrun is then scored rather than punished: F-6 passes it to the rubric as evidence under
**Fluency & Coherence**, where running long without concluding is a real weakness that a
human examiner would mark. Never reject a turn, and never silently truncate one.

## F-4 · MCP tools

| Tool | Input | Returns | Budget |
|---|---|---|---|
| `start_exam` | exam, part, locale, topic? | item prompt, bullets, timing, session id | <100ms |
| `get_status` | session id | phase, seconds remaining, `overrun` | <50ms |
| `submit_response` | session id, transcript | next follow-up question, phase, `overrun` | <150ms |
| `advance_phase` | session id | new phase + what to say | <50ms |
| `score_session` | session id | `{status:"pending", pollAfterMs}` | <100ms |
| `get_results` | session id | scores, or `{status:"pending"}` | <100ms |
| `get_progress` | — | recurring weak criteria, session count | <100ms |

`submit_response` returns a follow-up from `followUpSeeds` immediately; a Bedrock-generated
probe replaces it on the next turn if it has arrived. Never block on the model.

Every tool returns both a human-readable `content` block — what Alexa+ speaks — and a
`structuredContent` payload for the MCP Apps UI (F-8). Tool descriptions are written for a
reasoning model deciding *when to call them*, not for a developer reading an API doc.

Domain errors map onto MCP tool errors as `isError: true` with the message intact:
a phase violation must tell the model what it can do instead, so it can recover in the
conversation rather than dead-ending.

## F-5 · Follow-up generation (Bedrock, async)

On each `submit_response`, fire a non-blocking Bedrock call for a probe grounded in the
candidate's actual words. Cache on the session. If it has not returned by the next turn,
the seed question is used and the result is discarded. Failure is silent by design.

## F-6 · Rubric scoring (Bedrock)

`score_session` starts an async job; `get_results` polls. Score the full transcript on:
**Fluency & Coherence**, **Lexical Resource**, **Grammatical Range & Accuracy**.

Output per criterion: band 1–9 (IELTS) or CEFR A1–C2 (TCF), one sentence of evidence
quoting the candidate, and one concrete improvement. Validate the model's output against
the allowed band/level set; on invalid output retry once at temperature 0, then return a
`partial` result rather than a fabricated score.

Prompt must state that audio was unavailable and pronunciation is not assessed (GAP-004).

Pass per-turn `overrun` and the session's `overrunSeconds` into the rubric prompt as
evidence under Fluency & Coherence (F-3, ratified from GAP-008). Running well past the
limit without reaching a conclusion is a genuine weakness; the model should weigh it, not
treat it as a rule violation.

## F-7 · Progress tracking

Append one record per completed session: date, exam, part, topic, per-criterion score.
`get_progress` returns the criterion with the lowest trailing-3 mean and the topics where
it recurs. Blocked on GAP-007 (session identity) — build the store first, key it later.

## F-8 · MCP Apps UI

Per the MCP Apps standard, three views:
1. **Cue card** — prompt, bullets, and a live countdown driven by the phase deadline.
2. **Speaking** — elapsed time, a minimal level indicator, nothing distracting.
3. **Results** — three criteria with bands, evidence quotes, and one action each.

Legible across the room on an Echo Show: large type, high contrast, no hover states.
Must degrade to voice-only — every view's content is also returned as tool text.

## F-9 · OAuth 2.1 + PKCE

Authorization code flow with PKCE (S256). Unauthenticated requests to `/mcp` return
**401**. Host protected-resource metadata at `/.well-known/oauth-authorization-server`
advertising `code_challenge_methods_supported: ["S256"]`. Bearer tokens in the
`Authorization` header only, never query strings. Support the `resource` parameter on
authorization and token requests. Do not implement Dynamic Client Registration, OIDC, or
step-up authorization — Alexa+ does not support them yet.

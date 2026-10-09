# Viva — an oral-exam examiner that lives in your kitchen

**Alexa+ track submission for [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/).**

A speaking exam is the one part of language certification you cannot practise by typing.
It needs a live interlocutor, a running clock, and follow-up questions that react to what
you actually said. Viva is that interlocutor — a self-hosted MCP server that turns Alexa+
into a timed, rubric-scored speaking examiner you can practise with hands-free.

> *"Alexa, start an IELTS speaking test."*
> — cue card appears on the Echo Show, one minute to prepare, two minutes to speak,
> then follow-up questions drawn from your own answer, then a scored breakdown.

## Why voice, honestly

Most voice submissions are a screen app with a microphone bolted on. This one inverts that:
the exam **is** speech under time pressure, the screen is the accessory. You practise while
cooking, and the thing on the other end interrupts and probes like an examiner does.

## Architecture

```
Alexa+  ──Streamable HTTP (MCP 2025-11-25)──▶  Viva MCP server
                                                 ├── exam/      session state machine (phases, clocks)
                                                 ├── corpus/    original cue cards + task prompts
                                                 ├── grading/   CEFR / band rubric on Amazon Bedrock
                                                 ├── auth/      OAuth 2.1 + PKCE (S256)
                                                 └── ui/        MCP Apps — cue card, countdown, scores
```

The exam state machine lives **server-side**. Alexa+ calls tools; the server owns phase
transitions and timing, which is what a plain conversational model cannot do on its own.

## Docs

| Document | What it covers |
|---|---|
| [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | Vision, scope, judging alignment, 6-week plan |
| [CLAUDE.md](CLAUDE.md) | Implementation specs (F-x), decision-free |
| [GAPS_AND_ISSUES.md](GAPS_AND_ISSUES.md) | Severity-ranked register (GAP-xxx) |
| [FRICTION_LOG.md](FRICTION_LOG.md) | Builder friction — worth up to 10% judging bonus |

## Status

**F-1 to F-7 and F-9 are done; F-8 is built and checked in a stand-in host (see below)** - 211 tests green, build clean.

Rubric scoring runs on Claude Opus 5 via Amazon Bedrock (the Mantle client), with the
allowed band set baked into a per-exam structured-output schema so an out-of-scale level
cannot be generated. Scoring is asynchronous - `score_session` returns inside the tool
budget and `get_results` polls - and it is opt-in: with no `VIVA_BEDROCK_REGION` the server
runs an honest stand-in that says no grader is connected, and never loads the AWS client.

The honesty rule is enforced by tests: a criterion that cannot be verified is dropped and
reported as missing, two attempts are never merged into one score, a partial result is never
padded up to three, and a model or network failure surfaces as unavailable rather than as a
low band. Pronunciation is never scored - this server receives a transcript, not audio.

Auth is OAuth 2.1 + PKCE (S256), mounted from the MCP SDK's own authorization router.
Verified live: `/mcp` answers 401 with a `WWW-Authenticate` challenge naming the
protected-resource metadata, `S256` is the only challenge method advertised, and no
registration endpoint exists (Dynamic Client Registration is off, per F-9). Authorization
codes are single use and burned on failure, tokens are stored only as SHA-256 digests,
refresh tokens rotate, and every token is audience-bound to its RFC 8707 `resource`.

Progress is keyed on the OAuth grant subject - fixed when the user authenticates at the
consent screen, carried onto every token minted from that grant, and preserved across refresh
rotation, so a history outlives both the token and the conversation. Deliberately not keyed on
anything Alexa+ sends per conversation, which is what let F-7 ship without waiting on GAP-007.
A session that cannot be attributed to a subject is not recorded at all: the marks are still
read out, but nothing is filed under a shared fallback key where it would mix two candidates'
histories together.

Follow-up probes (F-5) are generated on Bedrock after each answer and used on the next turn
only if they have already arrived and validate as one short question; otherwise the corpus
seed is asked and the late result is dropped. Failures are silent to the caller. Opt-in via
the same `VIVA_BEDROCK_REGION` (`VIVA_PROBES_DISABLED=1` turns just probes off). Untested
against real Bedrock - the tests use fakes only. See GAP-014.

F-8 (MCP Apps UI): three self-contained views (cue card, speaking, results) are served as
`ui://viva/*.html` resources with mime type `text/html;profile=mcp-app` and linked from the tools
through `_meta.ui.resourceUri` (and the legacy `ui/resourceUri`): `start_exam` and
`advance_phase` -> cue card, `get_status` and `submit_response` -> speaking, `get_results` ->
results. Every view's content is also in the tool text, so voice-only still works. Countdowns
run from the server's `phaseDeadline`/`serverNow` (additive structuredContent fields), never a
client clock. Results render pending, partial (with the server's "left out" note), unavailable
and complete exactly as returned and never show pronunciation. Verified: resources list/read
over MCP, tool metadata, no external URLs, no `innerHTML`, countdown maths, results payloads
(`tests/mcp-apps.test.ts`), and a manual render in a browser at 1024x600 and 375x812, light and
dark, driven by a stand-in host that answers the `ui/initialize` handshake. **Not verified:** any
real MCP Apps host (Claude, an Echo Show or Alexa+), how a host sizes or sandboxes the iframe,
and whether the microphone level meter is ever granted (it hides itself when refused; see
GAP-017). No host was available, so treat on-device rendering as untested.

Progress history is persisted when `VIVA_PROGRESS_FILE` is set to a file path (for example
`data/progress.json`, which is git-ignored); unset, history lives in memory and a restart
clears it. The file is written atomically (temp file, fsync, rename), holds only per-subject
session records and never tokens, and a missing file simply starts an empty history. A file
that exists but is corrupt is never overwritten: the server refuses to start and names the
file, so you can repair it or move it aside. Appends are serialized within a process; run one
server process per file (there is no cross-process lock).

```bash
npm install
npm run build && npm test
```

```bash
export VIVA_DEMO_PASSCODE='pick-something'
export VIVA_OAUTH_CLIENTS='[{"client_id":"alexa-plus","client_name":"Alexa+","redirect_uris":["https://example.com/cb"]}]'
export VIVA_BEDROCK_REGION='us-east-1'   # omit to run without a grader
export VIVA_PROGRESS_FILE='data/progress.json'   # omit to keep progress in memory only
npm start
```

The server refuses to start with auth enabled and no passcode. `VIVA_AUTH_DISABLED=1`
turns auth off for local development only.

## Demo client (the Alexa+ stand-in)

The Alexa+ add-on toolchain is closed to participants (GAP-001/006), so a browser app plays
the Alexa+ role for the demo. It signs in with OAuth 2.1 + PKCE (S256, RFC 8707 `resource`),
calls the seven tools over Streamable HTTP, reads each tool's text aloud with
`speechSynthesis`, listens with the Web Speech API (a typed box appears where it is
unsupported or the mic is blocked), and logs the browser-side round trip of every call.
Countdowns come from `get_status`; the client never supplies a deadline.

```bash
export VIVA_DEMO_PASSCODE='pick-something'
export VIVA_OAUTH_CLIENTS='[{"client_id":"viva-demo","client_name":"Viva Demo","redirect_uris":["http://127.0.0.1:8787/demo/"]}]'
npm run build && npm start
# open http://127.0.0.1:8787/demo/  (use the issuer's host, so the redirect stays same-origin)
```

Use Chrome or Edge for speech recognition. Override with `VIVA_DEMO_CLIENT_ID`,
`VIVA_DEMO_REDIRECT_URI`, `VIVA_DEMO_SCOPE`; `VIVA_DEMO_UI=0` turns it off. The server
supports many concurrent MCP sessions (GAP-015, closed): a reload or a second client simply
initialises its own. Idle MCP sessions are reaped after `VIVA_MCP_SESSION_IDLE_MS` (default 30 min,
cap `VIVA_MCP_SESSION_MAX` = 100); exam state and progress are shared across them.

## License

MIT — see [LICENSE](LICENSE).

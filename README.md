# Viva — an oral-exam examiner that lives in your kitchen

**Alexa+ track submission for [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/).**

Viva is a self-hosted [MCP](https://modelcontextprotocol.io) server that turns Alexa+ into a
timed, rubric-scored IELTS / TCF speaking examiner. The server owns the exam: a session state
machine with real clocks (prepare, speak, follow-up), an original exam corpus, follow-up
questions that react to what the candidate said, and a three-criterion score at the end. Alexa+
only has to call seven tools. Speaking is the one part of language certification you cannot
practise by typing, and the one a conversational model cannot run on its own, because it needs
state, timing and a rubric that outlive any single turn.

> *"Alexa, start an IELTS speaking test."*
> Cue card, one minute to prepare, two minutes to speak, follow-up questions, then a scored
> breakdown.

## What it does

- **Runs the exam.** IELTS Speaking Parts 1-3 (en-US) and a smaller TCF set (fr-FR). The server
  computes every deadline from the corpus item; callers never supply one.
- **Observes the clock, never cuts you off.** A late answer is accepted and marked `overrun`
  (CLAUDE.md F-3); the rubric weighs it under Fluency & Coherence.
- **Keeps turns fast.** Turn-taking tools never call an LLM. Follow-ups come from the corpus
  immediately; a Bedrock-generated probe replaces a seed only if it has already arrived.
- **Scores honestly.** Fluency & Coherence, Lexical Resource, Grammatical Range & Accuracy, on
  Claude via Amazon Bedrock. No pronunciation score, ever: the server receives a transcript, not
  audio (GAP-004). A criterion that cannot be verified is dropped and reported, never padded.
- **Remembers you.** Per-person progress keyed on the OAuth grant subject; `get_progress` names
  the weakest criterion and where it recurs.
- **Authenticates properly.** OAuth 2.1 + PKCE (S256), RFC 8707 `resource` binding, no Dynamic
  Client Registration (Alexa+ does not support it).
- **Degrades to voice.** Every tool returns spoken text; the MCP Apps views (cue card, speaking
  clock, results) are an addition, not a dependency.

## Quick start

Requires Node 22+ (developed on Node 24).

```bash
npm install
npm run build && npm test          # 232 tests
```

Run the server with the browser demo client (the Alexa+ stand-in, see below):

```bash
export VIVA_DEMO_PASSCODE='REPLACE-ME-with-a-long-random-passcode'
export VIVA_OAUTH_CLIENTS='[{"client_id":"viva-demo","client_name":"Viva Demo","redirect_uris":["http://127.0.0.1:8787/demo/"]}]'
npm start                           # serves dist/, so `npm run build` must have run
# open http://127.0.0.1:8787/demo/   (Chrome or Edge for speech recognition)
```

Sanity checks (these were run against a fresh clone):

```bash
curl http://127.0.0.1:8787/healthz                      # {"ok":true,"version":"0.1.0","authenticated":true}
curl -i -X POST http://127.0.0.1:8787/mcp               # 401 with a WWW-Authenticate challenge
```

Optional switches:

```bash
export VIVA_BEDROCK_REGION='us-east-1'           # enables rubric scoring and follow-up probes (needs AWS credentials)
export VIVA_PROGRESS_FILE='data/progress.json'   # persist progress; unset = in memory, lost on restart
```

On any publicly reachable host use a long random passcode (for example
`openssl rand -base64 24`): the passcode is the only credential, and the guess throttle slows
an attacker down but does not make a weak passcode safe.

The server refuses to start with auth enabled and no passcode. `VIVA_AUTH_DISABLED=1` turns auth
off for local development only. Note: `npm run dev` is currently broken (see
[Known issues](#known-issues)); use `npm run build && npm start`.

With no `VIVA_BEDROCK_REGION` the exam still runs end to end, but scoring answers that no grader
is connected and the AWS client is never loaded.

## Architecture

```
 Alexa+ (not available to us)            Browser demo client  src/ui  (stand-in for Alexa+)
          \                                  /   OAuth 2.1 + PKCE, speechSynthesis, Web Speech API
           \_____ Streamable HTTP, MCP 2025-11-25, POST /mcp (Bearer) _____/
                                   |
                         Viva server  (Express, src/app.ts)
   ┌───────────────┬───────────────┼────────────────┬───────────────────┬──────────────┐
   auth/           mcp/            exam/            grading/            mcp-apps/
   OAuth 2.1+PKCE  7 tools,        state machine,   rubric scorer,      3 ui:// views
   consent screen, per-tool        corpus loader,   Bedrock (opt-in),   (cue card, speaking,
   grant subject   timing logs     deadlines        progress stores     results)
                                      |             (memory | JSON file)
                                   corpus/          probes/  Bedrock follow-up generator (opt-in)
                                   en-US, fr-FR     bench/   latency harness -> docs/latency.md
```

The exam state machine lives server-side. Alexa+ calls tools; the server owns phase transitions
and timing, which a plain conversational model cannot do on its own. Scoring is asynchronous:
`score_session` returns at once and `get_results` polls, so the model never sits on the
turn-taking path.

## Tools

Each tool returns spoken `content` plus `structuredContent` for the MCP Apps views. Budgets are
from CLAUDE.md F-4.

| Tool | Returns | Budget |
|---|---|---|
| `start_exam` | the prompt, cue-card bullets, timings and a session id | 100 ms |
| `get_status` | phase, seconds remaining, `overrun` | 50 ms |
| `submit_response` | the next follow-up question, the new phase, `overrun` | 150 ms |
| `advance_phase` | the new phase and what to say | 50 ms |
| `score_session` | `{status:"pending", pollAfterMs}` and starts the async scoring job | 100 ms |
| `get_results` | three criteria with band or CEFR level, evidence quote and one improvement; or pending / partial / unavailable | 100 ms |
| `get_progress` | the recurring weak criterion, its topics and the session count | 100 ms |

## What is verified, and what is not

**Verified by code and tests** (`npm test`, 232 tests across 12 files):

- Session state machine, overrun handling, corpus validation (including mandatory `provenance`).
- Tool behaviour and error mapping; seed-first follow-ups; probes never block a turn.
- Scoring honesty rules against a fake grader: out-of-scale levels rejected, one retry at
  `effort: "max"`, partial results never padded, model failure reported as `unavailable`.
- OAuth 2.1 + PKCE, hashed tokens, refresh rotation, audience binding, 401 challenge, no DCR;
  consent screen behaviour. Authorization codes are single use: a wrong `code_verifier` (or wrong
  client, redirect URI or resource) burns the code, and presenting a code that was already
  redeemed revokes the access and refresh tokens minted from it, including rotated descendants
  (RFC 6749 section 4.1.2). Codes and token lineage are in memory only, so a restart forgets both.
- Progress keyed on grant subject; unattributable sessions not recorded; file store atomic write
  and refusal to overwrite a corrupt file.
- Multiple concurrent MCP sessions (GAP-015); MCP Apps resources and tool metadata.
- Server-side latency against every F-4 budget (`npm run bench`).

**Not verified:**

- **No real Alexa+ host.** The add-on toolchain is closed to participants (GAP-001, GAP-006). All
  end-to-end behaviour was exercised through the repo's own demo client.
- **No real Bedrock call.** Scoring and probes are tested with fakes only; no AWS credentials
  were available. The exact request shape (including `effort` on `messages.create`, FRICTION-009)
  is untested against the live service.
- **Speech on a real device.** The demo client's microphone and speech recognition were not
  verified on an Echo Show or any smart-speaker hardware. Browser speech support varies.
- **MCP Apps host rendering.** The views were rendered in a stand-in host in a desktop browser
  (1024x600 and 375x812, light and dark). No real MCP Apps host (Claude, Echo Show, Alexa+) was
  available, so sizing, sandboxing and the microphone level meter (GAP-017) are untested.
- **French on Alexa+** (GAP-003), **public HTTPS deployment**, and **end-to-end Alexa+
  latency** are not covered.

## Demo client (the Alexa+ stand-in)

A browser app plays the Alexa+ role. It signs in with OAuth 2.1 + PKCE (S256, RFC 8707
`resource`), calls the seven tools over Streamable HTTP, reads each tool's text aloud with
`speechSynthesis`, listens with the Web Speech API (a typed box appears where it is unsupported
or the mic is blocked), and logs the browser-side round trip of every call. Countdowns come from
`get_status`; the client never supplies a deadline. Served same-origin at `/demo/`, so no CORS is
opened. Use the issuer's host in the browser so the redirect stays same-origin.

## Latency

`npm run bench` boots the real app on a loopback port, signs in with the real OAuth flow, drives
full exams over Streamable HTTP and times every tool against its F-4 budget. It rewrites
[docs/latency.md](docs/latency.md) and exits non-zero if any p95 exceeds its budget. In the
committed run (200 exams per scenario, Node 24, Windows 11) every client-observed p95 is under
1 ms against budgets of 50-150 ms, and the worst single round trip is 4.5 ms. This uses fakes for
the model and has no network between client and server, so it shows server-side budget
compliance, **not** end-to-end Alexa+ latency. See the caveats in the report.

## Tests, benchmark and configuration

```bash
npm run build          # tsc
npm test               # vitest, 12 files
npm run typecheck
npm run bench          # writes bench-output/latency.md (untracked); BENCH_OUT=- prints only
npm run bench:report   # 200 iterations, refreshes the committed docs/latency.md
```

Benchmark tuning: `BENCH_ITERATIONS` (200), `BENCH_WARMUP` (10), `BENCH_TURNS` (5),
`BENCH_SCORER_DELAY_MS` (3000), `BENCH_OUT` (path, or `-` to skip the file; default `bench-output/latency.md`).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Listen address |
| `VIVA_DEMO_PASSCODE` | none | Shared passcode for the consent screen. Required unless auth is disabled (GAP-011) |
| `VIVA_AUTH_DISABLED` | unset | `1` disables auth. Local development only |
| `VIVA_OAUTH_CLIENTS` | `[]` | JSON array of pre-registered clients (`client_id`, `redirect_uris`, ...) |
| `VIVA_ISSUER_URL` | `http://127.0.0.1:8787` | OAuth issuer identifier |
| `VIVA_RESOURCE_URL` | `<issuer>/mcp` | RFC 8707 resource identifier tokens are bound to |
| `VIVA_ACCESS_TOKEN_TTL` | `3600` | Access token lifetime, seconds |
| `VIVA_AUTH_CODE_TTL` | `60` | Authorization code lifetime, seconds |
| `VIVA_TRUST_PROXY` | unset | Number of reverse proxies in front of the server (e.g. `1`), or an Express subnet list. Unset trusts no `X-Forwarded-For`, which is correct when clients connect directly. Set it behind a proxy, or every client shares the proxy's address in the passcode throttle. `true` is rejected |
| `VIVA_CONSENT_MAX_FAILURES` | `5` | Wrong passcodes from one IP before it is locked out |
| `VIVA_CONSENT_LOCK_SECONDS` | `60` | First lockout length; doubles on each repeat lockout |
| `VIVA_CONSENT_LOCK_MAX_SECONDS` | `3600` | Cap on the doubling lockout |
| `VIVA_CONSENT_WINDOW_SECONDS` | `900` | An IP's failures and backoff level are forgotten after this long without a new failure |
| `VIVA_CONSENT_GLOBAL_MAX_FAILURES` | `50` | Wrong passcodes across all IPs, per global window, before the service drops to slow mode |
| `VIVA_CONSENT_GLOBAL_WINDOW_SECONDS` | `600` | Global failure window; slow mode ends by itself when it rolls over |
| `VIVA_CONSENT_GLOBAL_SLOW_SECONDS` | `30` | In slow mode, one passcode attempt is admitted per this interval |
| `VIVA_CONSENT_MAX_TRACKED_IPS` | `10000` | Cap on remembered IPs (oldest evicted) |
| `VIVA_BEDROCK_REGION` (or `AWS_REGION`) | unset | Enables Bedrock scoring and probes; unset runs without a grader |
| `VIVA_BEDROCK_MODEL` | `anthropic.claude-opus-5` | Model id for scoring (and probes unless overridden) |
| `VIVA_BEDROCK_PROBE_MODEL` | `VIVA_BEDROCK_MODEL` | Model id for follow-up probes |
| `VIVA_SCORING_DISABLED` | unset | `1` forces the no-grader stand-in even with a region |
| `VIVA_PROBES_DISABLED` | unset | `1` turns off generated follow-ups only |
| `VIVA_PROGRESS_FILE` | unset | JSON file for progress history; unset = in memory |
| `VIVA_CORPUS_ROOT` | `corpus` | Corpus directory |
| `VIVA_DEFAULT_LOCALE`, `VIVA_DEFAULT_EXAM` | `en-US`, `ielts` | Defaults when a caller omits them |
| `VIVA_MCP_SESSION_IDLE_MS` | `1800000` | Idle MCP connections are reaped after this |
| `VIVA_MCP_SESSION_MAX` | `100` | Cap on concurrent MCP connections (LRU evicted) |
| `VIVA_MCP_SESSION_SWEEP_MS` | `60000` | Reaper interval |
| `VIVA_DEMO_UI` | on | `0` disables the demo client |
| `VIVA_DEMO_CLIENT_ID` | `viva-demo` | Demo client id (must be in `VIVA_OAUTH_CLIENTS`) |
| `VIVA_DEMO_REDIRECT_URI` | `<issuer>/demo/` | Demo client redirect URI (must be registered) |
| `VIVA_DEMO_SCOPE` | `exam progress` | Scope the demo requests |

The progress file is written atomically, holds only per-subject session records and never
tokens. A corrupt file is never overwritten: the server refuses to start and names it. Run one
server process per file; there is no cross-process lock.

## Status by feature

Specs are in [CLAUDE.md](CLAUDE.md).

| Feature | Status | Notes |
|---|---|---|
| F-1 MCP over Streamable HTTP | Built | `/mcp`, `/healthz`, per-tool duration logging. Many concurrent MCP sessions (GAP-015) |
| F-2 Corpus schema | Built | 49 en-US IELTS items, 10 fr-FR TCF items, original (GAP-002); invalid or undocumented corpus fails startup |
| F-3 Session state machine | Built | Server-owned deadlines; overrun observed, never enforced (GAP-008) |
| F-4 Tools | Built | Seven tools; budgets met in the loopback bench |
| F-5 Follow-up probes | Built, untested live | Fakes only. GAP-014 open (probe is one turn stale) |
| F-6 Rubric scoring | Built, untested live | Fakes only. Unavailable without `VIVA_BEDROCK_REGION` |
| F-7 Progress | Built | Keyed on grant subject (GAP-007); memory or JSON file |
| F-8 MCP Apps UI | Built, host unverified | Stand-in host only; GAP-017 open |
| F-9 OAuth 2.1 + PKCE | Built | Revocation not implemented (GAP-010); passcode auth is demo-grade (GAP-011) |

## Known issues

- `npm run dev` fails: it runs `node --experimental-strip-types src/index.ts`, but the sources
  import `./app.js`-style specifiers, which Node cannot resolve against `.ts` files. Use
  `npm run build && npm start`.
- Dependency audit (2026-10): `npm audit` was clean after in-range lockfile updates only
  (`npm audit fix`, no `--force`, `package.json` ranges unchanged): `@modelcontextprotocol/sdk`
  1.30.0 to 1.32.1 (GHSA-6qxp-vccf-f47h, an OAuth *client* flaw; Viva uses the server side),
  `@modelcontextprotocol/client` and `core` 2.0.0 to 2.3.1 (transitive via ext-apps), `proxy-addr`
  2.0.8, `fast-uri` 3.1.8, `ip-address` 10.7.3, `source-map-js` 1.2.2 (dev-only). Re-run
  `npm audit` before release; new advisories appear over time.
- Open gaps: see [GAPS_AND_ISSUES.md](GAPS_AND_ISSUES.md).

## Docs

| Document | What it covers |
|---|---|
| [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | Vision, scope, judging alignment, plan and current status |
| [CLAUDE.md](CLAUDE.md) | Implementation specs (F-x) |
| [GAPS_AND_ISSUES.md](GAPS_AND_ISSUES.md) | Severity-ranked register (GAP-xxx) |
| [FRICTION_LOG.md](FRICTION_LOG.md) | Builder friction log for the hackathon bonus |
| [docs/latency.md](docs/latency.md) | Benchmark report |
| [docs/SUBMISSION_NOTES.md](docs/SUBMISSION_NOTES.md) | Submission checklist and owner TODOs |

## License

MIT — see [LICENSE](LICENSE).

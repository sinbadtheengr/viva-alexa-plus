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

**F-1, F-2, F-3, F-4 and F-9 are done** - 92 tests green, build clean.

Auth is OAuth 2.1 + PKCE (S256), mounted from the MCP SDK's own authorization router so the
endpoint behaviour and metadata documents are its tested ones. Verified live: `/mcp` answers
401 with a `WWW-Authenticate` challenge naming the protected-resource metadata, `S256` is the
only challenge method advertised, and no registration endpoint exists (Dynamic Client
Registration is off, per F-9 - Alexa+ does not support it). Authorization codes are single
use and burned on failure, tokens are stored only as SHA-256 digests, refresh tokens rotate,
and every token is audience-bound to the RFC 8707 `resource` it was issued for.

Not started: F-5/F-6 (Bedrock follow-ups and rubric scoring - the `Scorer` seam exists and
reports honestly that no grader is connected), F-7 (progress keying, blocked on GAP-007 and
GAP-011), F-8 (MCP Apps UI).

```bash
npm install
npm run build && npm test
```

```bash
export VIVA_DEMO_PASSCODE='pick-something'
export VIVA_OAUTH_CLIENTS='[{"client_id":"alexa-plus","client_name":"Alexa+","redirect_uris":["https://example.com/cb"]}]'
npm start
```

The server refuses to start with auth enabled and no passcode. `VIVA_AUTH_DISABLED=1`
turns auth off for local development only.

## License

MIT — see [LICENSE](LICENSE).

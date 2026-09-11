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

**F-2 (corpus) and F-3 (session state machine) are done** — 45 tests green, build clean,
turn-taking measured at well under a microsecond per operation.

Not started: F-1 (transport), F-4 (tools), F-5/F-6 (Bedrock), F-7 (progress),
F-8 (MCP Apps UI), F-9 (OAuth). See [GAPS_AND_ISSUES.md](GAPS_AND_ISSUES.md) for what is
still unresolved — in particular GAP-001 (CLI provenance) and GAP-006 (certification timing).

```bash
npm install && npm run build && npm test
```

## License

MIT — see [LICENSE](LICENSE).

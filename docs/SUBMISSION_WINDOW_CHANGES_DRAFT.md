# Devpost: "changes made during the submission window" (draft)

Draft text for the form's explanation of changes made during the submission window. The
hackathon window opened on 2026-08-31. Facts below come from `git log` on `main`; the repository
has no history before 2026-09-10. Items in `<...>` are the owner's to confirm; the repo cannot
answer them.

## Full version

```
Viva is a new project started during the submission window. Its first commit is dated
2026-09-10, after the window opened on 2026-08-31, and the repository has no history before that.

What was built, in order (all from the repository's git history):

- 2026-09-10: Project scaffold, written specs (feature specs F-1 to F-9) and a gaps register
  for risks found up front.
- 2026-09-11: Exam corpus schema and session state machine (F-2, F-3); the MCP server over
  Streamable HTTP and the seven tools (F-1, F-4); OAuth 2.1 + PKCE (F-9); rubric scoring on
  Amazon Bedrock (F-6); the first original IELTS and TCF exam items.
- 2026-10-08: Progress tracking keyed on the OAuth grant subject, with a JSON-file store (F-7);
  asynchronous Bedrock follow-up probes with a seed fallback (F-5); the three MCP Apps views
  (F-8); a browser demo client that plays the Alexa+ role; a corpus of 59 original items;
  multi-session MCP transports; a latency benchmark; a security-hardening pass (PKCE code
  burn, token revocation on replay, passcode throttling, dependency audit); and the
  documentation, friction log and gaps register.

Nothing was carried over from a pre-hackathon version of this product. <OWNER: confirm this
sentence is true. If you reused code, libraries, prompts or content from any earlier project of
yours, list exactly what and where instead, e.g. "the OAuth consent page pattern comes from
<project>">

Exam content is original, authored for this project; no third-party exam items are included.
Development used AI assistance (Claude Code) for coding, review and documentation; design
decisions, specs and acceptance were the author's. <OWNER: keep or edit the disclosure to match
the hackathon's AI rules.>
```

## Short version (if the field is capped)

> New project. First commit 2026-09-10, after the window opened (2026-08-31); no earlier history
> in the repo. All of F-1 to F-9, the demo client, benchmarks and security hardening were built
> in the window. Exam content is original. Developed with AI assistance (Claude Code).
> <Confirm: no code reused from earlier projects.>

## Check before pasting

- **Reuse.** The repo cannot prove nothing was copied from your other projects. If any code,
  prompts or content came from earlier work, name it; do not leave the "nothing was carried
  over" sentence in unless it is true.
- **Author names.** Commits show two names: Sean Relleve (Sept 10 to 11) and `sinbadtheengr`
  (Oct 8). If a reviewer asks, both are the same person; say so.
- **Gap in dates.** There are no commits between 2026-09-11 and 2026-10-08. The text above does
  not imply continuous work in that period, and neither should the video or the form.
- **AI disclosure.** Keep it unless the hackathon rules say otherwise. The corpus provenance
  strings and the README already state AI authorship, so omitting it here would contradict the
  repo. The rules page returned 403 when this was drafted, so any AI-assistance policy has not
  been checked.
- **Keep the counts current.** "59 original items" and the F-numbers are accurate for `main`
  as of 2026-10-08; re-check if the corpus or specs change before you submit.

# Demo video description (draft)

Text for the YouTube or Vimeo description and any Devpost "video description" field. Placeholders
in `<...>` are the owner's to fill. Chapter timestamps follow `docs/DEMO_SCRIPT.md` and must be
adjusted to the final cut.

## Title (under 70 characters)

```
Viva: Mock IELTS Speaking Exams by Voice (MCP server for Alexa+)
```

## Description

```
Viva turns Alexa+ into a timed, rubric-scored IELTS speaking examiner. It is a self-hosted MCP
server (spec 2025-11-25, Streamable HTTP, OAuth 2.1 + PKCE) built for the Alexa+ track of
"Build, Ship, Shape: Amazon Developer Hackathon".

A speaking exam is the one part of language certification you can't practise by typing. You need
a live examiner, a running clock, and follow-up questions that react to what you actually said.

WHAT YOU SEE IN THE VIDEO
- OAuth 2.1 + PKCE sign-in, then an original Part 2 cue card with a server-owned countdown
- Prep and speaking phases (waits are cut and captioned "Edited for length")
- Follow-up questions that come back instantly, so turn-taking never waits on a model
- Scoring on Claude Opus via Amazon Bedrock: three criteria (Fluency & Coherence, Lexical
  Resource, Grammatical Range & Accuracy), each with a band, a quoted line of evidence and one
  concrete improvement
- Progress tracking: your weakest criterion across sessions, filed under your sign-in
- Latency: every tool beats its budget in local benchmarks

IMPORTANT, STATED PLAINLY
- This demo runs on our own browser client playing the Alexa+ role. The Alexa+ add-on toolchain
  is not available to hackathon participants, so no Echo device or Alexa+ host appears in this
  video. The server itself follows the open MCP spec.
- Viva never scores pronunciation. The server receives a transcript, not audio.
- Exam items are original practice content in the general style of the format. This is not an
  official IELTS product.
- Latency figures are server-side, on local loopback, not end-to-end Alexa+ latency.

CHAPTERS (adjust to your final cut)
0:00 The problem
0:15 What Viva is
0:35 Sign-in and cue card
0:55 Prep and speaking
1:30 Follow-up questions
1:50 Scored breakdown
2:20 Progress across sessions
2:30 Engineering and what's next

LINKS
Source (MIT licensed): <REPO URL>
Live demo: <DEMO URL, if deployed>
Friction log (what building on Alexa+ was really like): <REPO URL>/blob/main/FRICTION_LOG.md
Latency evidence: <REPO URL>/blob/main/docs/latency.md

Built with TypeScript, the MCP TypeScript SDK, Express, and Claude on Amazon Bedrock.
```

## Short version (if the field is capped)

```
Viva is an MCP server that turns Alexa+ into a timed IELTS speaking examiner: cue cards, live follow-ups, three-criterion scoring on Claude via Amazon Bedrock, and progress tracking. Demo runs on our own browser client playing the Alexa+ role; the Alexa+ toolchain is closed to participants. No pronunciation scoring. Source (MIT): <REPO URL>
```

## Check before you paste

- **Scoring line:** it assumes real Bedrock scoring was filmed. If the video shows "unavailable",
  change that bullet to say so.
- **Progress line:** keep it only if the account had an earlier session on camera.
- **Latency line:** it says "local benchmarks". Do not strengthen it to anything about Alexa+
  end-to-end speed.
- **Live demo link:** drop the line if the app isn't deployed over HTTPS. Never paste a
  localhost URL.
- **Chapters:** YouTube only builds chapters from timestamps that start at 0:00 and are at least
  10 seconds apart. Re-time them after editing.

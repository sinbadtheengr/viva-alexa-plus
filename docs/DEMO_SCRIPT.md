# Demo video script (target 2:45, hard limit 3:00)

Hackathon rule: public YouTube or Vimeo, English, **under 3 minutes**. Aim for 2:45 so a slow
start can't push it over.

**What is true and must stay true on screen:** the demo runs on our own browser client at
`/demo/`, which plays the Alexa+ role. The Alexa+ add-on toolchain is closed to participants, so
no Echo device and no Alexa+ host appear in this video. Say so in the first 30 seconds, plainly,
and do not imply otherwise anywhere (no Alexa logo or ring on screen, no "Alexa, ..." wake word
spoken to a real device).

---

## Before you record (preflight)

| # | Check | Why |
|---|---|---|
| 1 | Deployed over HTTPS (or `http://127.0.0.1:8787/demo/` locally) with a long random `VIVA_DEMO_PASSCODE` | Judges may watch the URL bar; use a throwaway passcode you don't mind appearing on screen, or blur the field |
| 2 | `VIVA_BEDROCK_REGION` set and one real scoring run already done | Without it, results show "unavailable" and the scoring beat below can't be filmed. Do not fake it |
| 3 | `VIVA_PROGRESS_FILE` set, **one earlier session already completed** for this account | The progress beat needs a history. Run a Part 1 first, off camera |
| 4 | Chrome or Edge, mic permission granted, speakers audible to the recording | Web Speech API; the Browser pane in dev tools blocks the mic |
| 5 | Server restarted fresh, `/healthz` ok, one throwaway sign-in done to warm up | Avoids a cold-start pause on camera |
| 6 | Window 1280x720, browser zoom 125%, notifications off, bookmarks bar hidden | Legible at YouTube 720p |
| 7 | Terminal ready with `npm run bench` output (or `docs/latency.md` open) | For the 10-second latency shot |
| 8 | Pick the exam item: `ielts.p2.work.001` ("a piece of work you were proud of") or another Part 2 item | Four bullets, 60s prep, 120s speak |

Record screen + microphone in one take per segment. Timing below assumes **you cut the prep and
speaking waits** (see "Honest edits").

---

## Shot list and voice-over

Read at a relaxed pace (about 150 words per minute). Voice-over total is about 390 words.

### 1. Hook (0:00 to 0:15)

**Screen:** title card, "Viva — mock speaking exams by voice", then the demo page.

**Voice-over:**
> A speaking exam is the one part of IELTS you can't practise by typing. You need a live
> examiner, a running clock, and questions that react to what you actually said. Viva is that
> examiner, built as an MCP server for Alexa+.

### 2. What it is, honestly (0:15 to 0:35)

**Screen:** the architecture diagram from the README (or a simple slide: client, MCP over
Streamable HTTP, server, Bedrock). Caption: **"Browser client playing the Alexa+ role"**.

**Voice-over:**
> Viva speaks MCP over Streamable HTTP with OAuth 2.1 and PKCE. The Alexa+ add-on toolchain
> isn't open to hackathon participants, so I built to the open spec and wrote a small browser
> client that plays the Alexa+ role. Everything you'll see goes through the same MCP tools.

### 3. Sign in and start (0:35 to 0:55)

**Screen:** click "Sign in with Viva"; the consent screen appears; type the passcode and press
**Enter** (this works now); back on the demo, choose IELTS, Part 2, en-US, press Start. The cue
card appears with the prompt and four bullets.

**Voice-over:**
> Sign-in is a real OAuth flow with a PKCE challenge. Then Viva picks an original cue card and
> reads it aloud. The clock you see counting down comes from the server, not the browser, so the
> exam can't be paused or cheated from the client.

**Caption:** "Deadlines are server-owned (F-3)".

### 4. Prep and speaking (0:55 to 1:30)

**Screen:** countdown on the cue card; **cut** to the speaking view; speak roughly 20 seconds of
a real answer into the mic (the live transcript fills in under the clock); then **cut** past
the rest of the two minutes.

**Voice-over (during the cut):**
> One minute to prepare, two minutes to speak. I'll skip ahead. While I talk, the speaking view
> stays minimal: elapsed time and my words appearing as I say them. If you run past the limit, Viva doesn't cut you
> off. It records the overrun and passes it to the grader as evidence for fluency, which is what
> a human examiner would mark.

**Caption when cutting:** "Edited for length (about 2 minutes skipped)".

### 5. Follow-up questions (1:30 to 1:50)

**Screen:** Viva reads a follow-up aloud; answer in one sentence; a second follow-up is read.
Point the cursor at the request log panel showing per-call milliseconds.

**Voice-over:**
> Then come follow-up questions. They come back instantly from the exam bank, and when Bedrock
> is connected, a probe grounded in my own words can replace the next one. Turn-taking never
> waits on a model. The log on the right shows each call returning in a few milliseconds.

**Only say "grounded in my own words" if you actually saw a generated probe in this take**
(the response's `followUpSource` field reads `generated`). If every follow-up was a seed, drop
that clause.

### 6. Scoring (1:50 to 2:20)

**Screen:** the exam ends; "Scoring..." appears; the results view loads: three criteria (Fluency
& Coherence, Lexical Resource, Grammatical Range & Accuracy) each with a band, a quoted line of
your answer, and one improvement. Pause 2 seconds on one criterion. Show the small "pronunciation
is not assessed" note.

**Voice-over:**
> Scoring runs on Claude Opus on Amazon Bedrock, asynchronously, so the call returns right away
> and the app polls. You get three criteria, a band for each, a sentence of evidence quoting what
> I said, and one concrete thing to fix. The allowed bands are baked into the output schema, so
> an out-of-scale score can't come back. And Viva never reports a pronunciation score, because
> the server only receives a transcript, not audio.

**Caption:** "Pronunciation is not assessed."

### 7. Progress (2:20 to 2:30)

**Screen:** click **Show my progress**; the weakest criterion and where it recurs appear as text.

**Voice-over:**
> Across sessions, Viva tracks my weakest criterion and the topics where it keeps showing up,
> filed under my sign-in rather than anything that resets each conversation.

### 8. Engineering and close (2:30 to 2:45)

**Screen:** `docs/latency.md` table (every tool's p95 well under its budget), then the repo page
with the MIT license and the friction log file.

**Voice-over:**
> Every tool beats its latency budget with room to spare, measured over real OAuth and HTTP,
> and the tests cover the honesty rules, like never padding a partial score. It's open source,
> and the friction log documents what building on Alexa+ was really like. Next: a real Alexa+
> host, once the toolchain opens, and more exam content. Thanks for watching.

**Caption (last 5 s):** repo URL, "MIT licensed".

---

## Honest edits (say what you cut)

- The prep and speaking waits are cut. Show the caption "Edited for length" whenever time is
  skipped. Never speed up the countdown so it looks like it ran in real time.
- Do not splice in a result from a different run. Film the scoring beat from the same session you
  just answered, or show a caption "different session" if you must reuse one.
- If Bedrock fails on camera, **keep the failure**: "unavailable" is an honest, designed result
  and worth a short mention. Re-record rather than fabricating a score.

## Claims to avoid

- The microphone level meter: it exists only in the MCP Apps views, which this demo does not
  show (they were checked in a stand-in host only, GAP-017). Don't mention it.
- "Works on Alexa+", "Echo Show", or any real-device claim. It does not, yet.
- "Official IELTS" or "IELTS-approved". These are original practice items in the general style
  of the format.
- Any pronunciation score or "accent" feedback.
- "Real-time" scoring. Scoring is asynchronous and takes seconds.
- Latency numbers presented as end-to-end Alexa+ latency. They are local loopback server numbers.

## Fallbacks

| Problem on camera | Do this |
|---|---|
| Mic blocked or noisy | Use the typed-answer box and say "typed here so the transcript is clear"; still show voice-over elsewhere |
| Speech synthesis silent | Say the prompt yourself over the cue card; mention the client normally reads it aloud |
| OAuth redirect mismatch | Use the issuer's host in the URL bar (README: "use the issuer's host so the redirect stays same-origin") |
| 400 on a second `initialize` | Fixed (GAP-015); if it recurs, restart the server and report it |

## Timing budget

| Segment | Start | Length |
|---|---|---|
| Hook | 0:00 | 15 s |
| What it is | 0:15 | 20 s |
| Sign in and start | 0:35 | 20 s |
| Prep and speaking | 0:55 | 35 s |
| Follow-ups | 1:30 | 20 s |
| Scoring | 1:50 | 30 s |
| Progress | 2:20 | 10 s |
| Close | 2:30 | 15 s |

Total 2:45, leaving 15 seconds of slack. If you run long, cut segment 7 (progress) first, then
shorten segment 8.

## Upload checklist

- Public visibility, English title and description, link to the repo.
- Add the video URL to the Devpost form and the README (`docs/SUBMISSION_NOTES.md`).
- Watch the uploaded video once end to end, with sound, before submitting.

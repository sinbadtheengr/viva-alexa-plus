# Devpost project name and pitch (draft)

Limits from the Devpost form: **name 60 characters, pitch 200 characters.** Character counts
below were measured, not estimated.

Hackathon: Build, Ship, Shape: Amazon Developer Hackathon (challenge 30992), Alexa+ track.

## Project name (max 60)

| Option | Text | Chars |
|---|---|---|
| **Recommended** | `Viva: your IELTS & TCF speaking examiner, on Alexa+` | 51 |
| Alternative | `Viva – Voice Speaking Exam Coach for Alexa+` | 43 |
| Alternative | `Viva: Mock Speaking Exams by Voice` | 34 |

Note: the write-up's last heading is "What's next for Viva: Mock Speaking Exams by Voice", so the
third option matches the name the Devpost form was already using. If you keep that heading
unchanged, use the third option so the name and heading agree.

## Pitch (max 200)

**Primary**
```
Viva is an MCP server that turns Alexa+ into an IELTS/TCF speaking examiner: timed cue cards, live follow-ups, three-criterion band scoring, and progress tracking across sessions.
```
(179 characters)

**Alternative (more emotional)**
```
Practice IELTS and TCF speaking out loud, anytime. Viva makes Alexa+ a timed examiner that asks live follow-ups, scores fluency, vocabulary and grammar, and tracks your weak spots.
```
(180 characters)

## Check before pasting

- **"TCF".** The corpus has 10 French TCF items against 49 IELTS items, and the demo path is
  IELTS in en-US (French on Alexa+ is an open limitation, GAP-003). The name and pitch mention
  TCF because the server supports it. If you'd rather not imply a French demo, use the third name
  and drop "TCF" from the pitch.
- **"Alexa+".** The demo runs on our own browser client playing the Alexa+ role, not on an Alexa+
  device. The write-up and video say so; keep the pitch to what the server is ("an MCP server
  that turns Alexa+ into...") and do not add "works on Echo".
- **"Scores fluency, vocabulary and grammar".** Matches the three criteria. Do not add
  "pronunciation": the server never scores it.
- **"Live follow-ups".** Follow-ups come back instantly from the exam bank; Bedrock-generated
  probes are optional and arrive one turn late (GAP-014). "Live" is fair for the first; do not
  promise the second.

# Submission notes — Build, Ship, Shape: Amazon Developer Hackathon

Deadline: **2026-10-23 12:00 PM PT** (plan: submit by 2026-10-21). Track: **Alexa+**.
Judging: Tech Implementation, Design, Potential Impact, Quality of Idea, weighted equally;
friction log worth up to a 10% bonus.

Legend: **Done** = the repo shows it. **TODO-for-owner** = needs the owner, an account, a
credential or a recording; nothing in the repo can satisfy it.

## Requirements checklist

| Requirement | Status | Where / what remains |
|---|---|---|
| Public GitHub repo | TODO-for-owner | Confirm the repository visibility is public and the default branch has the final docs |
| Open-source license | Done | MIT, [LICENSE](../LICENSE); `package.json` declares `"license": "MIT"` |
| Working project built with the required technology | Partly done | MCP server, OAuth 2.1 + PKCE, MCP Apps views and Bedrock integration code exist and `npm run build && npm test` passes (232 tests). It has **not** run against a real Alexa+ host or a real Bedrock endpoint; see [README](../README.md#what-is-verified-and-what-is-not) |
| Track selection: Alexa+ | Done in repo, TODO-for-owner on Devpost | Stated in the README and [PROJECT_OVERVIEW.md](../PROJECT_OVERVIEW.md); select it on the Devpost form |
| Mini-challenge selection (AWS Builder, Open Source) | TODO-for-owner | [PROJECT_OVERVIEW.md](../PROJECT_OVERVIEW.md) lists the intent. AWS Builder: Bedrock code exists (`src/grading`, `src/probes`) but is untested live, so decide whether to claim it. Open Source: MIT repo exists; no upstream contribution is recorded in the repo yet |
| Demo video, under 3 minutes | TODO-for-owner | Not in the repo. The demo path is the browser client at `/demo/` ([README](../README.md#demo-client-the-alexa-stand-in)); the video must be recorded against it (or a real Alexa+ simulator if access is obtained) and must not imply real Alexa+ hardware was used |
| Product feedback on tools and APIs used | Done | [FRICTION_LOG.md](../FRICTION_LOG.md): 12 entries, each with expected / happened / impact / suggested fix, plus a ranked summary. Tools covered: Alexa+ add-on docs and CLI, MCP TypeScript SDK, MCP ext-apps, Bedrock Mantle client. Owner should paste or link it into the Devpost feedback field |
| Friction log (bonus) | Done | Same file. Entries are factual to what was recorded while building; the owner should read it once before submitting |
| Explanation of changes made during the submission window | Done in repo, TODO-for-owner on Devpost | History is in `git log`; milestones and what shipped are in [PROJECT_OVERVIEW.md](../PROJECT_OVERVIEW.md#six-week-plan-started-2026-09-10--deadline-2026-10-23-1200-pt). Whether any of this code predates the window is not shown by the repo, so the owner must state it on the form |
| Third-party content rights | Mitigated | Corpus files carry a mandatory `provenance` statement enforced at load time ([GAPS_AND_ISSUES.md](../GAPS_AND_ISSUES.md), GAP-002, GAP-009). Skim `corpus/` once before submitting |
| Public, reachable deployment | TODO-for-owner | Not done. OAuth issuer/resource URLs (`VIVA_ISSUER_URL`, `VIVA_RESOURCE_URL`) need a public HTTPS host. Needs hosting, a real passcode and `VIVA_OAUTH_CLIENTS` for the target client |
| AWS / Bedrock credentials and model access | TODO-for-owner | Needed to run scoring and probes live (`VIVA_BEDROCK_REGION`, AWS credentials, model access for `anthropic.claude-opus-5`). Until then, README must keep saying these paths are untested live |
| Devpost form, text description and screenshots | TODO-for-owner | Not in the repo |
| Alexa+ add-on registration / certification | TODO-for-owner, probably blocked | The toolchain is closed to participants (GAP-001, GAP-006, FRICTION-010) |

## Suggested order of owner work

1. Obtain AWS credentials, run the server with `VIVA_BEDROCK_REGION` set, and do one real scored
   exam. Record the outcome in the README's verified section, and in FRICTION-009 if `effort`
   on `messages.create` misbehaves.
2. Deploy to public HTTPS and re-run the sanity checks in the README against that URL.
3. Record the sub-3-minute video (cue card, speaking, follow-up, scored breakdown, progress).
4. Fill in the Devpost form, selecting the track and mini-challenges, and paste the friction log.
5. Re-run `npm run build && npm test` and `npm run bench` on the final commit.

## Claims to avoid, because the repo cannot back them

- "Works on Alexa+" or "runs on Echo Show": no real Alexa+ host or device was available.
- "Scored by Claude on Bedrock" as a demonstrated result: only fakes were exercised.
- "Pronunciation" of any kind: the server never receives audio.
- "Sub-500 ms end to end": only server-side loopback latency is measured ([latency.md](latency.md)).
- "French exam on Alexa+": TCF content exists (10 fr-FR items) but Alexa+ French behaviour is
  unverified (GAP-003).
- A certified or published add-on.

# FRICTION_LOG — building on Alexa+

Kept continuously while building, per the hackathon's friction-log bonus (up to 10%).
Each entry: what I tried, what happened, what it cost, what would have helped.

Format is deliberately blunt — a friction log is only useful if it is honest.

---

## FRICTION-001 · The docs tell you to run a command they never tell you how to install

**Severity: high — this one has a security dimension.**

The MCP QuickStart's prerequisites say to have "the Alexa AI CLI installed and
authenticated via `alexa-ai configure`." Neither the quickstart nor the Add-on API
reference states **how to install it** — no npm package, no pip package, no download link.
The linked CLI reference page (`/en-US/docs/alexa/add-ons/alexa-ai-cli-reference.html`)
returned **404**.

A developer following these docs will reasonably try `npm install -g alexa-ai`. That
resolves to a **live third-party package** (v2.5.0, published 2026-09-07) — an unrelated
WhatsApp bot engine from `github.com/AlexaInc/deepai`. Amazon's documentation is currently
directing developers toward a name it does not control on the public registry.

*Cost:* ~25 minutes, and a near-miss global install.
*What would have helped:* one line — `npm install -g @amazon/alexa-ai` or a console
download link — in the Prerequisites block. And Amazon claiming the npm name.

---

## FRICTION-002 · Tools receive transcript, not audio — undiscoverable from the docs

Whether an MCP tool can access the user's raw utterance audio determines whether an entire
category of application (pronunciation coaching, accent work, speech therapy, singing,
anything prosodic) is buildable on Alexa+ at all. I could not find this stated either way.

*Cost:* a design decision made on inference rather than documentation.
*What would have helped:* an explicit "what your tool receives" section in the toolkit
overview, listing exactly what is and is not in the tool payload.
*Feature request:* opt-in audio (or prosodic features — pace, pauses, filler-word counts)
in the tool payload, with user consent. It would open Alexa+ to language learning,
accessibility, and clinical speech use cases that are currently impossible.

---

## FRICTION-003 · The 500ms budget and "AI-native" pull in opposite directions

Add-ons are pitched as AI-native, but the documented round-trip budget is **under 500ms** —
shorter than a single small-model inference call. Any add-on whose value comes from
reasoning over the user's input has to invent its own deferred-work pattern, and nothing in
the docs acknowledges this or suggests a sanctioned approach.

*Cost:* an architectural workaround (GAP-005) designed before writing any code.
*What would have helped:* a documented long-running-tool pattern — a progress/polling
convention, or guidance on what Alexa+ says to the user while a tool is still thinking.

---

## FRICTION-004 · Doc 404s encountered

- `/docs/alexaplus/add-ons/set-up-development-environment.html` — 404, though the
  quickstart's first prerequisite points at "Set Up Your Development Environment."
- `/en-US/docs/alexa/add-ons/alexa-ai-cli-reference.html` — 404, linked from the
  Add-on API reference as the source for installation details.

Both 404s sit directly on the critical path of a developer's first hour.

---

## FRICTION-005 · The MCP TypeScript SDK does not typecheck against its own interface

`StreamableHTTPServerTransport` is not assignable to the `Transport` interface it
implements, under TypeScript's `exactOptionalPropertyTypes`:

```
error TS2379: Argument of type 'StreamableHTTPServerTransport' is not assignable to
parameter of type 'Transport' with 'exactOptionalPropertyTypes: true'.
  Types of property 'onclose' are incompatible.
    Type '(() => void) | undefined' is not assignable to type '() => void'.
```

The class exposes `onclose` / `onerror` / `onmessage` as accessor pairs typed
`(() => void) | undefined`, while `Transport` declares them as optional properties.
Under this flag the two spellings are not the same type, so `server.connect(transport)`
fails against the SDK's own transport. Same for `CallToolResult`: a handler returning a
plain object needs an index signature the docs never mention.

*Cost:* ~20 minutes, and a cast in production code
([src/index.ts](src/index.ts)) rather than relaxing the flag for our own modules.
*What would have helped:* declaring the optional members in `Transport` as
`onclose?: (() => void) | undefined`, which is a one-line change per member and makes the
interface exact-optional-safe without affecting anyone else.
*Status:* upstream fix candidate — this is the intended **Open Source mini-challenge**
contribution. Small, self-contained, and verifiable with a single `tsc` run.

---

## FRICTION-006 · The Alexa+ docs name the wrong well-known endpoint

The MCP QuickStart's OAuth requirements say:

> Host Protected Resource Metadata at `/.well-known/oauth-authorization-server`

These are two different documents from two different RFCs, and they are not interchangeable:

| Document | RFC | Well-known path | Who hosts it |
|---|---|---|---|
| Protected Resource Metadata | RFC 9728 | `/.well-known/oauth-protected-resource` | the **resource server** |
| Authorization Server Metadata | RFC 8414 | `/.well-known/oauth-authorization-server` | the **authorization server** |

A developer following the instruction literally would publish resource metadata at the
authorization-server path, and a spec-compliant client looking for
`/.well-known/oauth-protected-resource` would find nothing - which is also what the
`WWW-Authenticate: ... resource_metadata=` header points at.

*Cost:* ~20 minutes deciding whether Amazon meant something unusual or the doc was wrong.
*Resolution:* served both documents at their correct RFC paths, which satisfies either reading.
*What would have helped:* naming both documents and their correct paths, and saying whether
Alexa+ expects the add-on to be its own authorization server or to delegate to one.

---

## FRICTION-007 · Returning the wrong OAuth error silently breaks token refresh

`OAuthServerProvider.verifyAccessToken` is typed `Promise<AuthInfo>` and its doc comment
says only "Verifies an access token." Nothing states which error to throw on failure - but
the choice decides the HTTP status a client sees:

- `InvalidTokenError` -> **401** + `WWW-Authenticate` challenge (correct, per RFC 6750)
- any other `OAuthError` -> **400** with no challenge

I first threw `InvalidGrantError`, which is the right error at the *token* endpoint and the
wrong one at a *resource* server. Everything still appeared to work - tokens were rejected -
but a real client would never learn it should re-authenticate, so expiry would surface as an
unexplained 400 instead of a refresh. Our own end-to-end test caught it; a unit test of the
provider alone would not have.

*Cost:* ~15 minutes, and it would have been a production bug that only appeared an hour
after any successful login, when the first access token expired.
*What would have helped:* one line on `verifyAccessToken` - "throw `InvalidTokenError` if the
token is invalid or expired" - or narrowing the throws in the interface's documentation.
*Status:* second upstream contribution candidate, alongside FRICTION-005.

---

## FRICTION-008 · "Non-blocking, replaces on the next turn" does not say what it replaces

F-5 reads cleanly until you try to write the turn-taking test: a probe fired by answer N can
only be asked in reply to answer N+1 (the reply to N already returned a seed), so the probe is
always about the previous answer. Nothing in the spec says whether that is intended, whether a
probe may extend the exam past its seeds, or how a caller can tell a generated question from a
seed. Chose the literal reading and logged GAP-014 rather than deciding.

*Cost:* ~15 minutes of design thought; no code churn.
*What would have helped:* one sentence on staleness, and on whether seeds or probes own the
exam length.

## FRICTION-009 · `output_config.effort` on a plain `messages.create` is unverified

The rubric adapter uses `effort` with `messages.parse`; the probe adapter uses it with plain
`messages.create` at `"low"`, assuming the Mantle surface accepts it there too. No credentials
were available to try it, so this is the first line to check on a live run.



---

## FRICTION-010 · No Alexa+ client to demo against, so the demo needs its own

With the add-on toolchain closed to participants (GAP-001, GAP-006) there is nothing that
plays Alexa+ for a demo video. I built a browser client (`/demo`) that performs the OAuth 2.1
+ PKCE flow and calls the seven tools over Streamable HTTP, speaking `content` with
`speechSynthesis` and listening with `SpeechRecognition`. It is also the only way I have to
measure the 500ms round trip from the caller's side.

*Cost:* roughly a day that would have gone into the actual product. *Observed:* tool round
trips of 3-16 ms on loopback, so the budget is dominated by whatever sits between Alexa+ and
the server, not by the tools.
*What would have helped:* a documented local test harness or simulator for Alexa+ MCP add-ons.

---

## FRICTION-011 · The SDK's Streamable HTTP transport answers in SSE, and only initialises once

Two surprises when writing an MCP *client* against our own server:

1. POST responses come back as `text/event-stream` even for one-shot calls, so a client that
   assumes `application/json` fails on the first call. The spec allows either; a client must
   parse both.
2. A stateful transport accepts a single `initialize` for its whole life (see GAP-015). The
   error is accurate but surfaces only on the second client, which is the one you meet after
   a page reload.

*Cost:* ~30 minutes, mostly the second. *What would have helped:* a note in the SDK server
docs that one transport instance serves one session, with the per-session pattern shown.

# FRICTION_LOG — building on Alexa+

Kept continuously while building, per the hackathon's friction-log bonus (up to 10%).
Every entry has the same shape: **Expected**, **Happened**, **Impact**, **Suggested fix**.
Wording is deliberately blunt; a friction log is only useful if it is honest. Entries are
numbered in the order they were hit. Ratings are the author's.

## Summary, ranked by importance

| Rank | Entry | One line | Who can fix it |
|---|---|---|---|
| 1 | FRICTION-001 | The docs say to run `alexa-ai` but never say where to get it; the obvious `npm` name is an unrelated third-party package | Amazon docs / package owner |
| 2 | FRICTION-010 | The add-on toolchain is closed to participants and there is no simulator, so a demo needs its own Alexa+ stand-in (about a day) | Amazon Alexa+ team |
| 3 | FRICTION-006 | The docs name the wrong well-known path for Protected Resource Metadata | Amazon docs |
| 4 | FRICTION-003 | The 500 ms budget conflicts with "AI-native"; no sanctioned long-running-tool pattern | Amazon docs / platform |
| 5 | FRICTION-002 | Not stated whether tools receive audio; blocks a whole category of apps (pronunciation) | Amazon docs / platform |
| 6 | FRICTION-004 | Two 404s on the first-hour critical path | Amazon docs |
| 7 | FRICTION-007 | Throwing the wrong OAuth error silently breaks token refresh | MCP TypeScript SDK |
| 8 | FRICTION-005 | MCP SDK's transport does not typecheck against its own `Transport` interface | MCP TypeScript SDK |
| 9 | FRICTION-012 | `registerAppResource` does not typecheck against its matching SDK; no no-bundler path | MCP ext-apps |
| 10 | FRICTION-011 | Streamable HTTP transport answers in SSE and initialises once per instance | MCP TypeScript SDK docs |
| 11 | FRICTION-008 | F-5's "replaces on the next turn" leaves staleness unspecified | This project's spec |
| 12 | FRICTION-009 | `effort` on plain `messages.create` via Bedrock Mantle is unverified (no credentials) | Anthropic / AWS docs |

Upstream contribution candidates (Open Source mini-challenge): FRICTION-005, 007, 012.

---

## FRICTION-001 · The docs tell you to run a command they never tell you how to install

**Severity: high. This one has a security dimension.**

**Expected:** the MCP QuickStart's prerequisites ("the Alexa AI CLI installed and authenticated
via `alexa-ai configure`") to say how to install the CLI.

**Happened:** neither the quickstart nor the Add-on API reference says: no npm package, no pip
package, no download link. The linked CLI reference page
(`/en-US/docs/alexa/add-ons/alexa-ai-cli-reference.html`) returned **404**. A developer will
reasonably try `npm install -g alexa-ai`, which resolves to a **live third-party package**
(v2.5.0, published 2026-09-07): an unrelated WhatsApp bot engine from
`github.com/AlexaInc/deepai`. Amazon's documentation is directing developers toward a name it
does not control on the public registry.

**Impact:** about 25 minutes, and a near-miss global install of unknown code. Tracked as GAP-001.

**Suggested fix:** one line in the Prerequisites block (`npm install -g @amazon/alexa-ai` or a
console download link), and Amazon claiming the npm name or documenting the exact package.

---

## FRICTION-002 · Tools receive transcript, not audio, and the docs never say

**Expected:** a "what your tool receives" section in the toolkit overview.

**Happened:** I could not find it stated either way whether an MCP tool can access the user's
raw utterance audio. That answer decides whether pronunciation coaching, accent work, speech
therapy, singing and anything prosodic is buildable on Alexa+ at all.

**Impact:** a design decision made on inference rather than documentation (Viva scores three
transcript-observable criteria and never pronunciation; GAP-004).

**Suggested fix:** document exactly what is and is not in the tool payload. **Feature
request:** opt-in audio, or prosodic features (pace, pauses, filler-word counts), in the tool
payload, with user consent. It would open Alexa+ to language learning, accessibility and
clinical speech use cases that are currently impossible.

---

## FRICTION-003 · The 500 ms budget and "AI-native" pull in opposite directions

**Expected:** guidance for add-ons whose value comes from model reasoning.

**Happened:** add-ons are pitched as AI-native, but the documented round-trip budget is **under
500 ms**, shorter than a single small-model inference call. Nothing in the docs acknowledges
this or suggests a sanctioned deferred-work pattern, so every add-on invents its own.

**Impact:** an architectural workaround designed before writing any code (GAP-005): turn-taking
tools stay local and fast, `score_session` returns a pending handle and `get_results` polls.

**Suggested fix:** a documented long-running-tool pattern: a progress or polling convention, and
guidance on what Alexa+ says to the user while a tool is still working.

---

## FRICTION-004 · Doc 404s on the first-hour critical path

**Expected:** the links in the quickstart and API reference to resolve.

**Happened:**
- `/docs/alexaplus/add-ons/set-up-development-environment.html` returned 404, though the
  quickstart's first prerequisite points at "Set Up Your Development Environment."
- `/en-US/docs/alexa/add-ons/alexa-ai-cli-reference.html` returned 404, linked from the Add-on
  API reference as the source for installation details (see FRICTION-001).

**Impact:** both sit directly on a developer's first hour. The second removes the only
documented route to installing the CLI.

**Suggested fix:** restore or redirect both pages, and link-check the add-on docs.

---

## FRICTION-005 · The MCP TypeScript SDK does not typecheck against its own interface

**Expected:** `server.connect(new StreamableHTTPServerTransport(...))` to compile under strict
settings.

**Happened:** `StreamableHTTPServerTransport` is not assignable to the `Transport` interface it
implements, under TypeScript's `exactOptionalPropertyTypes`:

```
error TS2379: Argument of type 'StreamableHTTPServerTransport' is not assignable to
parameter of type 'Transport' with 'exactOptionalPropertyTypes: true'.
  Types of property 'onclose' are incompatible.
    Type '(() => void) | undefined' is not assignable to type '() => void'.
```

The class exposes `onclose` / `onerror` / `onmessage` as accessor pairs typed
`(() => void) | undefined`, while `Transport` declares them as optional properties. Under this
flag the two spellings are different types. The same flag affects `CallToolResult`: a handler
returning a plain object needs an index signature the docs never mention.

**Impact:** about 20 minutes, and a cast in production code ([src/index.ts](src/index.ts))
rather than relaxing the flag for our own modules.

**Suggested fix:** declare the optional members in `Transport` as
`onclose?: (() => void) | undefined`, a one-line change per member that makes the interface
exact-optional-safe without affecting anyone else. Upstream fix candidate for the **Open Source
mini-challenge**: small, self-contained, verifiable with a single `tsc` run.

---

## FRICTION-006 · The Alexa+ docs name the wrong well-known endpoint

**Expected:** the OAuth requirements to name the correct metadata document.

**Happened:** the MCP QuickStart says "Host Protected Resource Metadata at
`/.well-known/oauth-authorization-server`". These are two different documents from two RFCs:

| Document | RFC | Well-known path | Who hosts it |
|---|---|---|---|
| Protected Resource Metadata | RFC 9728 | `/.well-known/oauth-protected-resource` | the **resource server** |
| Authorization Server Metadata | RFC 8414 | `/.well-known/oauth-authorization-server` | the **authorization server** |

Followed literally, a developer would publish resource metadata at the authorization-server
path, and a spec-compliant client looking for `/.well-known/oauth-protected-resource` (which is
also what the `WWW-Authenticate: ... resource_metadata=` header points at) would find nothing.

**Impact:** about 20 minutes deciding whether Amazon meant something unusual or the doc was
wrong. Resolution: Viva serves both documents at their correct RFC paths, which satisfies either
reading.

**Suggested fix:** name both documents and their correct paths, and say whether Alexa+ expects
the add-on to be its own authorization server or to delegate to one.

---

## FRICTION-007 · Returning the wrong OAuth error silently breaks token refresh

**Expected:** the SDK docs to say which error `verifyAccessToken` throws on failure.

**Happened:** `OAuthServerProvider.verifyAccessToken` is typed `Promise<AuthInfo>` and its doc
comment says only "Verifies an access token." The error choice decides the HTTP status a client
sees:

- `InvalidTokenError` gives **401** plus a `WWW-Authenticate` challenge (correct, per RFC 6750).
- any other `OAuthError` gives **400** with no challenge.

I first threw `InvalidGrantError`, which is right at the *token* endpoint and wrong at a
*resource* server. Everything still appeared to work (tokens were rejected), but a real client
would never learn it should re-authenticate, so expiry would surface as an unexplained 400
instead of a refresh. Our own end-to-end test caught it; a unit test of the provider alone would
not have.

**Impact:** about 15 minutes, and a production bug that would only appear an hour after any
successful login, when the first access token expired.

**Suggested fix:** one line on `verifyAccessToken` ("throw `InvalidTokenError` if the token is
invalid or expired"), or narrowing the throws in the interface's documentation. Second upstream
contribution candidate, alongside FRICTION-005.

---

## FRICTION-008 · "Non-blocking, replaces on the next turn" does not say what it replaces

*(Friction in this project's own spec rather than Amazon's, kept because the same ambiguity
will hit anyone writing a turn-based add-on.)*

**Expected:** F-5 to determine what the probe is about.

**Happened:** a probe fired by answer N can only be asked in reply to answer N+1 (the reply to N
already returned a seed), so it is always about the previous answer. The spec does not say
whether that is intended, whether a probe may extend the exam past its seeds, or how a caller
can tell a generated question from a seed. I implemented the literal reading and logged GAP-014
rather than deciding.

**Impact:** about 15 minutes of design thought; no code churn.

**Suggested fix:** one sentence in the spec on staleness, and on whether seeds or probes own the
exam length.

---

## FRICTION-009 · `output_config.effort` on a plain `messages.create` is unverified

*(A recorded unknown, not an observed failure.)*

**Expected:** `effort` to be accepted on the Bedrock Mantle surface for plain
`messages.create`, as it is for `messages.parse`.

**Happened:** the rubric adapter uses `effort` with `messages.parse`; the probe adapter uses it
with `messages.create` at `"low"`, assuming the surface accepts it. No credentials were
available to try, so this has never run against the live service.

**Impact:** a possible silent failure of follow-up probes in a live run. Probes fail silent by
design (seeds are used), so it would not be visible without checking the logs. This is the
first line to check on a live run.

**Suggested fix:** a documented table of which request parameters the Mantle client accepts on
each `messages.*` method.

---

## FRICTION-010 · No Alexa+ client to demo against, so the demo needs its own

**Expected:** a way to run an add-on against Alexa+ during the hackathon: a simulator,
developer-stage access, or a documented local test harness.

**Happened:** the add-on toolchain is closed to participants (GAP-001, GAP-006), so nothing
plays Alexa+ for a demo video. I built a browser client (`/demo`) that performs the OAuth 2.1 +
PKCE flow and calls the seven tools over Streamable HTTP, speaking `content` with
`speechSynthesis` and listening with `SpeechRecognition`. It is also the only way I have to
measure round trips from the caller's side.

**Impact:** roughly a day that would have gone into the actual product. Observed tool round
trips of 3-16 ms on loopback in the browser, so the budget is dominated by whatever sits
between Alexa+ and the server, not by the tools. Everything verified in this repo is verified
against that stand-in, not against Alexa+.

**Suggested fix:** a documented local test harness or simulator for Alexa+ MCP add-ons, and
participant access to the development stage.

---

## FRICTION-011 · The SDK's Streamable HTTP transport answers in SSE, and only initialises once

**Expected:** a POST to `/mcp` to return JSON for a one-shot call, and a second client to be
able to connect.

**Happened:** two surprises when writing an MCP *client* against our own server.
1. POST responses come back as `text/event-stream` even for one-shot calls, so a client that
   assumes `application/json` fails on the first call. The spec allows either; a client must
   parse both.
2. A stateful transport accepts a single `initialize` for its whole life (GAP-015). The error
   (`400 Server already initialized`) is accurate but surfaces only on the second client, which
   is the one you meet after a page reload.

**Impact:** about 30 minutes, mostly the second. It also meant the first deployment would have
worked for one conversation and failed the next (fixed by per-session transports).

**Suggested fix:** a note in the SDK server docs that one transport instance serves one session,
with the per-session pattern shown.

---

## FRICTION-012 · `registerAppResource` does not type-check against the SDK it is built for

**Expected:** `@modelcontextprotocol/ext-apps` 2.0.0's `registerAppResource` to accept the SDK's
own documented resource metadata.

**Happened:** it takes `McpUiAppResourceConfig`, which extends the SDK's `ResourceMetadata`.
With `@modelcontextprotocol/sdk` 1.30.0 installed, passing the SDK's own documented `title` or
`description` is rejected with "does not exist in type" (two errors, each naming a field
`ResourceMetadata` plainly has). I called `server.registerResource` directly with the exported
`RESOURCE_MIME_TYPE`, which is all the helper adds. Separately, the package ships no way to get a
self-contained single-file view without a bundler (its `App` class needs bundling), so the views
speak the small host protocol (`ui/initialize`, `ui/notifications/tool-result`) by hand in about
30 lines.

**Impact:** about 20 minutes. The protocol types made the hand-rolled path easy; a no-bundler
note would have saved the detour.

**Suggested fix:** align the helper's types with the SDK's `ResourceMetadata` (upstream issue
candidate), and add a "no-bundler" section to the README showing the raw host handshake.

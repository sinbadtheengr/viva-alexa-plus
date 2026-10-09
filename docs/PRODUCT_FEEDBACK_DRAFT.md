# Devpost product feedback: draft

Draft text for the "product feedback on all tools, APIs and SDKs used" fields, plus optional
feature requests. Source of truth for every claim is `FRICTION_LOG.md` (entry ids in brackets).
The Devpost form's exact fields were not visible when this was drafted, so the text is organised
by product and each block is self-contained. Fill the `<...>` ratings yourself; they are your
opinion, and none of them was invented here.

**Honest scope, state this once up front in whatever field allows free text:**
> Viva was built against the Alexa+ MCP documentation only. We did not have access to the add-on
> toolchain (the `alexa-ai` CLI, Local Inspector, simulator, registration or certification), so we
> have no feedback on those beyond the fact that they were unreachable. Bedrock-backed scoring
> and follow-up generation are implemented and tested with fakes; we had no AWS credentials, so
> we did not run them against the live service.

---

## 1. Alexa+ MCP documentation and add-on programme

**Used:** the MCP QuickStart, the Add-on API reference, and the OAuth requirements. Not used (not
reachable): the CLI, Local Inspector, simulator, console registration and certification.

**Overall rating:** `<1-5>`

**What worked:** the requirements are concrete where they exist (spec version, Streamable HTTP,
OAuth 2.1 with PKCE S256, the `resource` parameter, the 500 ms budget). Because they are
standards, we could build and test the whole server without Amazon tooling.

**What did not (ranked by impact, with time lost):**
1. **No way to install the CLI** [FRICTION-001]. The prerequisites say to run `alexa-ai` but never
   say where to get it; the linked CLI reference returned 404. The obvious `npm install -g
   alexa-ai` resolves to an unrelated third-party package (a WhatsApp bot engine). About 25
   minutes lost, and a near-miss global install of unknown code. This is a security problem:
   the docs point developers at a registry name Amazon does not control.
2. **The toolchain is closed to participants, and there is no simulator** [FRICTION-010]. We had
   to build our own Alexa+ stand-in (about a day) and everything we verified is verified against
   that stand-in, not Alexa+.
3. **Wrong well-known path** [FRICTION-006]. The QuickStart says to host Protected Resource
   Metadata at `/.well-known/oauth-authorization-server`. That path belongs to Authorization
   Server Metadata (RFC 8414); Protected Resource Metadata (RFC 9728) lives at
   `/.well-known/oauth-protected-resource`. About 20 minutes deciding which was meant; we serve
   both at their correct paths. The docs also don't say whether Alexa+ expects the add-on to be
   its own authorization server or to delegate.
4. **The 500 ms budget vs. "AI-native"** [FRICTION-003]. Add-ons are pitched as AI-native, but the
   budget is shorter than one small-model call, and there is no sanctioned deferred-work pattern.
   We invented one (fast local turn-taking tools; `score_session` returns a pending handle and
   `get_results` polls).
5. **What a tool receives is undocumented** [FRICTION-002]. Nothing says whether a tool gets only
   the transcript or also audio. That decides whether pronunciation coaching and similar
   prosody-dependent apps are possible at all; we assumed transcript-only and never score
   pronunciation.
6. **Two 404s in the first hour** [FRICTION-004]: "Set Up Your Development Environment" and the CLI
   reference.

**Suggested fixes:** put the exact install command or download link in Prerequisites and claim
the npm name; open a simulator or developer-stage access to participants; correct the
well-known-path sentence and say whether delegation to an external authorization server is
supported; document a long-running-tool pattern; document the tool payload (transcript vs audio);
link-check the add-on docs.

---

## 2. MCP TypeScript SDK (`@modelcontextprotocol/sdk`)

**Used:** `McpServer`, `StreamableHTTPServerTransport`, and the server-side auth router
(`mcpAuthRouter`, bearer-auth middleware, `OAuthServerProvider`). Versions 1.30.0, then 1.32.1 after
an in-range security update.

**Overall rating:** `<1-5>`

**What worked:** the authorization router gave us `/authorize`, `/token` and both metadata
documents with S256-only PKCE and no Dynamic Client Registration (it omits that endpoint when the
clients store cannot register), which is exactly what the Alexa+ requirements ask for. The bump to
1.32.1 was drop-in: build, all tests and the benchmark passed unchanged.

**What did not:**
1. **Wrong OAuth error silently breaks refresh** [FRICTION-007]. `verifyAccessToken`'s docs say only
   "Verifies an access token". Throwing `InvalidTokenError` returns 401 with a `WWW-Authenticate`
   challenge; any other `OAuthError` returns 400 with none. We first threw `InvalidGrantError`,
   which is right at the token endpoint and wrong at a resource server. Tokens were still
   rejected, so it looked fine, but a real client would never learn to re-authenticate. Only an
   end-to-end test caught it. About 15 minutes.
   *Fix:* one line on the method ("throw `InvalidTokenError` if the token is invalid or expired").
2. **The transport does not typecheck against its own interface** [FRICTION-005].
   `StreamableHTTPServerTransport` is not assignable to `Transport` under
   `exactOptionalPropertyTypes` (TS2379 on `onclose`). The same flag makes `CallToolResult`
   handlers need an index signature the docs never mention. About 20 minutes, and a cast in
   production code. *Fix:* declare the members as `onclose?: (() => void) | undefined`.
3. **SSE responses and one `initialize` per transport** [FRICTION-011]. POSTs come back as
   `text/event-stream` even for one-shot calls, and a stateful transport accepts a single
   `initialize` for its life (a second client gets 400 until restart, which is what a page reload
   looks like). About 30 minutes. *Fix:* a note in the server docs that one transport serves one
   session, with the per-session pattern shown.

---

## 3. MCP Apps extension (`@modelcontextprotocol/ext-apps` 2.0.0)

**Used:** `RESOURCE_MIME_TYPE` and the host handshake types, for three `ui://` views linked from
tools through `_meta.ui.resourceUri`.

**Overall rating:** `<1-5>`

**What worked:** the protocol types (`ui/initialize`, `ui/notifications/tool-result`) made a
hand-rolled single-file view easy to write correctly, in about 30 lines.

**What did not** [FRICTION-012]:
- `registerAppResource` does not typecheck against the SDK it is built for. With SDK 1.30.0, the
  SDK's own documented `title` and `description` are rejected ("does not exist in type"). We
  called `server.registerResource` directly.
- There is no no-bundler path: `App` needs bundling, so a self-contained view has to speak the
  handshake by hand.
- We could not test on a real MCP Apps host, so sizing, sandboxing and microphone permission are
  unverified.

**Suggested fixes:** align the helper's types with `ResourceMetadata`; add a "no bundler" section
to the README with the raw handshake.

---

## 4. Amazon Bedrock (Mantle client) with Claude Opus 5

**Used:** `@anthropic-ai/bedrock-sdk` (Mantle client) for rubric scoring (`messages.parse` with a
structured-output schema) and follow-up probes (`messages.create`), model id
`anthropic.claude-opus-5`.

**Overall rating:** `<fill only after a live run, or leave blank>`

**What we can and cannot say:** we implemented and tested both calls with fakes but had no AWS
credentials, so nothing here was exercised against the live service. Do not report ratings for
behaviour we did not observe.

**Friction we can document:**
1. **Sampling parameters were removed** [GAP-012]. The original plan used `temperature: 0` for
   deterministic grading; Claude Opus 5 rejects it with a 400. We used `effort` instead.
2. **Which parameters work on which method is unclear** [FRICTION-009]. We use `effort` with
   `messages.parse` for scoring and assumed it works with plain `messages.create` for probes
   (`"low"`). Unverified; probes fail silent by design, so a rejection would not be visible
   without checking logs. *Fix:* a table of request parameters accepted per `messages.*` method on
   the Mantle surface.
3. **The named SDK path was legacy** [GAP-013]. The original spec named an older Bedrock SDK path;
   we moved to the Mantle client.

---

## Feature requests (optional)

Ranked by how much they would unlock:

1. **Opt-in audio or prosodic features in the tool payload** (pace, pauses, filler counts), with
   user consent. It would open Alexa+ to pronunciation coaching, language learning, accessibility
   and clinical speech use [FRICTION-002].
2. **A local simulator or test harness for Alexa+ MCP add-ons, and participant access to the
   development stage** [FRICTION-010]. Without it, every team builds a stand-in and nothing is
   verified on the real platform.
3. **A documented long-running-tool pattern**: a progress or polling convention, and guidance on
   what Alexa+ says while a tool is still working [FRICTION-003].
4. **A documented per-method parameter table for the Bedrock Mantle client** [FRICTION-009].
5. **A published, verified install path for the CLI**, and Amazon claiming its npm name
   [FRICTION-001].

---

## Friction log entries (optional, bonus)

Point to the repository file and submit the ranked list:

> `FRICTION_LOG.md` in the repository: 12 entries, each with expected / happened / impact /
> suggested fix, ranked by importance, with time lost. Three are marked as upstream contribution
> candidates (FRICTION-005, 007, 012).

---

## Checks before pasting

- Delete any block for a product you did not actually use, and never claim use of the Alexa+
  toolchain.
- The Bedrock block is written as "implemented, untested live". If you run a real scoring session
  first, replace it with what you observed and keep FRICTION-009 only if it still applies.
- Time-lost figures are the ones recorded in the friction log (the author's estimates).
- If a form field has a character limit, use the numbered items (the first sentence of each is the
  claim) and link to `FRICTION_LOG.md` for the rest.

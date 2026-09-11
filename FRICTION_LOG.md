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

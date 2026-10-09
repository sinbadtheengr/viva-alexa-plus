import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE } from "../src/config.js";
import { Corpus } from "../src/exam/corpus.js";
import { SessionStore } from "../src/exam/session.js";
import { InMemoryProgressStore } from "../src/grading/progress.js";
import type { ScoreOutcome, Scorer } from "../src/grading/types.js";
import { CLIENT_JS } from "../src/mcp-apps/client.js";
import { VIEWS, renderView, type ViewId } from "../src/mcp-apps/views.js";
import { silentLogger } from "../src/mcp/logging.js";
import { buildServer } from "../src/mcp/server.js";
import { fakeClock, item, unpreppedItem } from "./fixtures.js";

/**
 * F-8 · MCP Apps views. Everything is checked over the real MCP protocol with a
 * linked in-memory client, plus the view script's pure functions in a vm.
 * Rendering in an actual host is NOT covered here (see README).
 */

class ScriptedScorer implements Scorer {
  readonly name = "scripted";
  outcome: ScoreOutcome = { status: "pending", pollAfterMs: 1000 };
  start(): string {
    return "h";
  }
  poll(): ScoreOutcome {
    return this.outcome;
  }
}

async function connect() {
  const clock = fakeClock();
  const corpus = Corpus.fromItems([item(), unpreppedItem()]);
  const scorer = new ScriptedScorer();
  const { server } = buildServer({
    corpus,
    sessions: new SessionStore({ resolver: corpus, now: clock.now }),
    scorer,
    progress: new InMemoryProgressStore(),
    logger: silentLogger,
    now: clock.now,
    identify: () => "owner",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, scorer, clock };
}

type Call = { content: { text: string }[]; structuredContent?: Record<string, any>; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args })) as unknown as Call;

const IDS = Object.keys(VIEWS) as ViewId[];

describe("resources", () => {
  it("lists all three views with the MCP Apps mime type", async () => {
    const { client } = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual(IDS.map((i) => VIEWS[i].uri).sort());
    for (const r of resources) expect(r.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
  });

  it.each(IDS)("reads the %s view as self-contained html", async (id) => {
    const { client } = await connect();
    const res = await client.readResource({ uri: VIEWS[id].uri });
    const c = res.contents[0]!;
    expect(c.mimeType).toBe(RESOURCE_MIME_TYPE);
    const html = (c as { text: string }).text;
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(`data-default-view="${id}"`);
    // No external loads of any kind: no URLs, no src/href, no imports, no csp opened up.
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<(script|link|img|iframe|source|video|audio|object|embed)[^>]*\s(src|href)\s*=/i);
    expect(html).not.toMatch(/@import|url\(|fetch\(|XMLHttpRequest|WebSocket|importScripts/);
    expect(JSON.stringify(c._meta ?? {})).not.toContain("csp");
  });

  it("asks for the microphone only on the speaking view", async () => {
    const { client } = await connect();
    const speaking = (await client.readResource({ uri: VIEWS.speaking.uri })).contents[0]!;
    const cue = (await client.readResource({ uri: VIEWS.cue.uri })).contents[0]!;
    expect((speaking._meta as any).ui.permissions).toEqual({ microphone: {} });
    expect((cue._meta as any).ui.permissions).toBeUndefined();
  });

  it("tags the document language from the locale parameter, defaulting from config", () => {
    expect(renderView("cue")).toContain(`<html lang="${DEFAULT_LOCALE}"`);
    expect(renderView("cue", "fr-FR")).toContain('<html lang="fr-FR"');
    // A malformed locale never reaches the attribute.
    const hostile = renderView("cue", '"><script>x</script>');
    expect(hostile).not.toContain("<script>x");
    expect(hostile).toContain(`<html lang="${DEFAULT_LOCALE}"`);
    // At runtime the client follows the payload's own locale.
    expect(CLIENT_JS).toMatch(/setAttribute\("lang", p\.locale\)/);
  });

  it("writes to the DOM only through textContent and never mentions pronunciation scoring", () => {
    expect(CLIENT_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    const all = IDS.map((i) => renderView(i)).join("\n");
    expect(all).not.toMatch(/pronunciation\s*(score|band)/i);
    // The only pronunciation text is the explicit "not assessed" disclaimer.
    for (const m of all.matchAll(/pronunciation/gi)) {
      expect(all.slice(m.index!, m.index! + 40).toLowerCase()).toContain("pronunciation is not assessed");
    }
  });
});

describe("tool links", () => {
  it("links each tool to its view through both metadata keys", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const uri = (name: string) => {
      const meta = tools.find((t) => t.name === name)?._meta as any;
      expect(meta?.["ui/resourceUri"]).toBe(meta?.ui?.resourceUri);
      return meta?.ui?.resourceUri;
    };
    expect(uri("start_exam")).toBe(VIEWS.cue.uri);
    expect(uri("advance_phase")).toBe(VIEWS.cue.uri);
    expect(uri("get_status")).toBe(VIEWS.speaking.uri);
    expect(uri("submit_response")).toBe(VIEWS.speaking.uri);
    expect(uri("get_results")).toBe(VIEWS.results.uri);
    expect((tools.find((t) => t.name === "get_progress")?._meta as any)?.ui).toBeUndefined();
  });
});

describe("server-driven clock fields", () => {
  it("reports the server deadline, server time and phase length, and keeps the old fields", async () => {
    const { client, clock } = await connect();
    const start = await call(client, "start_exam", { exam: "ielts", part: 2 });
    const id = start.structuredContent!.sessionId as string;
    expect(start.structuredContent).toMatchObject({ view: "cue_card", phase: "briefing", phaseDeadline: null });

    const prep = await call(client, "advance_phase", { sessionId: id });
    const sc = prep.structuredContent!;
    expect(sc).toMatchObject({ view: "cue_card", phase: "prep", secondsRemaining: 60, phaseSeconds: 60 });
    expect(sc.phaseDeadline - sc.serverNow).toBe(60_000);
    expect(sc.prompt).toBe(item().prompt);
    expect(sc.bullets).toEqual(item().bullets);

    clock.advanceSeconds(20);
    const status = await call(client, "get_status", { sessionId: id });
    expect(status.structuredContent).toMatchObject({ phase: "prep", secondsRemaining: 40, phaseSeconds: 60 });
    expect(status.structuredContent!.phaseDeadline).toBe(sc.phaseDeadline); // same server deadline
    expect(status.structuredContent!.phaseDeadline - status.structuredContent!.serverNow).toBe(40_000);

    const speak = await call(client, "advance_phase", { sessionId: id });
    expect(speak.structuredContent).toMatchObject({ view: "speaking", phase: "speaking", phaseSeconds: 120 });
  });

  it("keeps the spoken text identical for voice-only callers", async () => {
    const { client } = await connect();
    const start = await call(client, "start_exam", { exam: "ielts", part: 2 });
    expect(start.content[0]!.text).toBe(
      ["Describe a piece of work you were proud of.", "— what it was", "— why it mattered"].join("\n"),
    );
  });
});

// ---- the view script's pure functions --------------------------------------

function core() {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(CLIENT_JS, sandbox);
  return sandbox.__VIVA__ as {
    remainingMs(p: unknown, receivedAt: number, now: number): number | null;
    formatClock(ms: number): string;
    viewFor(p: unknown, isError: boolean, fallback: string): string;
    progress(total: number | null, remaining: number | null): number | null;
  };
}

describe("view script", () => {
  const c = core();

  it("counts down from the server deadline, not the client clock", () => {
    const p = { phaseDeadline: 1_700_000_060_000, serverNow: 1_700_000_000_000 };
    expect(c.remainingMs(p, 5_000, 5_000)).toBe(60_000);
    expect(c.remainingMs(p, 5_000, 25_000)).toBe(40_000);
    // A client whose wall clock is wildly different gives the same answer: only
    // the local elapsed time since receipt matters.
    expect(c.remainingMs(p, 9e12, 9e12 + 20_000)).toBe(40_000);
    expect(c.remainingMs(p, 0, 70_000)).toBe(-10_000);
  });

  it("has no countdown without a server deadline", () => {
    expect(c.remainingMs({ phaseDeadline: null, serverNow: 1 }, 0, 0)).toBeNull();
    expect(c.remainingMs({ clientDeadline: 5 }, 0, 0)).toBeNull();
    expect(c.remainingMs(null, 0, 0)).toBeNull();
  });

  it("formats whole seconds, rounding up like the server", () => {
    expect(c.formatClock(60_000)).toBe("1:00");
    expect(c.formatClock(59_001)).toBe("1:00");
    expect(c.formatClock(9_000)).toBe("0:09");
    expect(c.formatClock(-12_000)).toBe("0:12");
    expect(c.formatClock(0)).toBe("0:00");
  });

  it("clamps progress and handles missing totals", () => {
    expect(c.progress(120, 120_000)).toBe(0);
    expect(c.progress(120, 60_000)).toBe(0.5);
    expect(c.progress(120, -5_000)).toBe(1);
    expect(c.progress(null, 1)).toBeNull();
    expect(c.progress(120, null)).toBeNull();
  });

  it("chooses a layout from the payload, falling back to the resource default", () => {
    expect(c.viewFor({ view: "cue_card" }, false, "speaking")).toBe("cue");
    expect(c.viewFor({ view: "clock" }, false, "cue")).toBe("speaking");
    expect(c.viewFor({ view: "speaking" }, false, "cue")).toBe("speaking");
    expect(c.viewFor({ view: "results" }, false, "cue")).toBe("results");
    expect(c.viewFor({ view: "scoring" }, false, "cue")).toBe("results");
    expect(c.viewFor({ error: "phase_violation" }, false, "cue")).toBe("error");
    expect(c.viewFor({ view: "results" }, true, "results")).toBe("error");
    expect(c.viewFor(null, false, "results")).toBe("results");
  });
});

// ---- results payloads, exactly as get_results returns them -----------------

describe("results payloads the view receives", () => {
  const scores = [
    { criterion: "fluency_coherence", band: "7", evidence: 'You said "well, um, I think".', improvement: "Pause less." },
    { criterion: "lexical_resource", band: "6", evidence: "Used 'nice' twice.", improvement: "Vary adjectives." },
    { criterion: "grammatical_range_accuracy", band: "7", evidence: "Good conditionals.", improvement: "Check tense." },
  ] as const;

  async function results(outcome: ScoreOutcome) {
    const h = await connect();
    const start = await call(h.client, "start_exam", { exam: "ielts", part: 1 });
    const id = start.structuredContent!.sessionId as string;
    await call(h.client, "advance_phase", { sessionId: id });
    await call(h.client, "submit_response", { sessionId: id, transcript: "I grew up by the sea." });
    await call(h.client, "score_session", { sessionId: id });
    h.scorer.outcome = outcome;
    return call(h.client, "get_results", { sessionId: id });
  }

  it("pending", async () => {
    const r = await results({ status: "pending", pollAfterMs: 900 });
    expect(r.structuredContent).toMatchObject({ view: "scoring", status: "pending", pollAfterMs: 900 });
    expect(r.content[0]!.text).toBe("Still working out the results.");
  });

  it("unavailable carries the reason in both text and structure", async () => {
    const r = await results({ status: "unavailable", reason: "No grader is connected." });
    expect(r.structuredContent).toMatchObject({ view: "results", status: "unavailable", reason: "No grader is connected." });
    expect(r.content[0]!.text).toBe("No grader is connected.");
  });

  it("complete has three labelled criteria and no pronunciation field", async () => {
    const r = await results({ status: "complete", scores });
    const sc = r.structuredContent!;
    expect(sc.scores).toHaveLength(3);
    expect(sc.scores[0]).toMatchObject({ label: "Fluency & Coherence", band: "7" });
    expect(JSON.stringify(sc)).not.toMatch(/pronunciation_|pronunciationScore|"pronunciation"/);
    expect(sc.pronunciationAssessed).toBe(false);
  });

  it("partial returns only verified criteria plus the note, unpadded", async () => {
    const r = await results({ status: "partial", scores: [scores[0]], note: "1 criterion was left out." });
    expect(r.structuredContent).toMatchObject({ status: "partial", note: "1 criterion was left out." });
    expect(r.structuredContent!.scores).toHaveLength(1);
    expect(r.content[0]!.text).toContain("1 criterion was left out.");
  });
});

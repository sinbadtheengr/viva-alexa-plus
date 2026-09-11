import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { Corpus } from "../src/exam/corpus.js";
import { SessionStore } from "../src/exam/session.js";
import { InMemoryProgressStore } from "../src/grading/progress.js";
import type { ScoreOutcome, ScoreRequest, Scorer } from "../src/grading/types.js";
import { silentLogger } from "../src/mcp/logging.js";
import { buildServer } from "../src/mcp/server.js";
import { fakeClock, item, unpreppedItem } from "./fixtures.js";

/**
 * F-1 + F-4 end to end: a real MCP client talking to the real server over the
 * SDK's linked transport pair. Nothing here reaches the filesystem or network.
 */

/** A scorer whose outcome the test controls, so nothing waits on a model. */
class ScriptedScorer implements Scorer {
  readonly name = "scripted";
  outcome: ScoreOutcome = { status: "pending", pollAfterMs: 1000 };
  lastRequest: ScoreRequest | null = null;

  start(request: ScoreRequest): string {
    this.lastRequest = request;
    return "handle-1";
  }

  poll(): ScoreOutcome {
    return this.outcome;
  }
}

interface Harness {
  client: Client;
  scorer: ScriptedScorer;
  progress: InMemoryProgressStore;
  clock: ReturnType<typeof fakeClock>;
}

async function connect(): Promise<Harness> {
  const clock = fakeClock();
  const corpus = Corpus.fromItems([item(), unpreppedItem()]);
  const scorer = new ScriptedScorer();
  const progress = new InMemoryProgressStore();

  const { server } = buildServer({
    corpus,
    sessions: new SessionStore({ resolver: corpus, now: clock.now }),
    scorer,
    progress,
    logger: silentLogger,
    now: clock.now,
    owner: () => "test-owner",
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, scorer, progress, clock };
}

interface CallResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as CallResult;
}

function text(result: CallResult): string {
  return result.content.map((c) => c.text ?? "").join(" ");
}

function structured(result: CallResult): Record<string, unknown> {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

let h: Harness;
beforeEach(async () => {
  h = await connect();
});

describe("F-1 · server wiring", () => {
  it("advertises exactly the seven tools F-4 specifies", async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "advance_phase",
      "get_progress",
      "get_results",
      "get_status",
      "score_session",
      "start_exam",
      "submit_response",
    ]);
  });

  it("describes every tool for a model deciding when to call it", async () => {
    const { tools } = await h.client.listTools();
    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(80);
    }
  });
});

describe("F-4 · start_exam", () => {
  it("returns the prompt, the cue card and the timings", async () => {
    const result = await call(h.client, "start_exam", { exam: "ielts", part: 2 });
    const s = structured(result);

    expect(result.isError).toBeFalsy();
    expect(s["sessionId"]).toEqual(expect.any(String));
    expect(s["prompt"]).toBe(item().prompt);
    expect(s["bullets"]).toEqual(item().bullets);
    expect(s["prepSeconds"]).toBe(60);
    expect(s["speakSeconds"]).toBe(120);
    expect(s["view"]).toBe("cue_card");
  });

  it("speaks the prompt and the bullets, so a voice-only device loses nothing", async () => {
    const result = await call(h.client, "start_exam", { exam: "ielts", part: 2 });
    expect(text(result)).toContain(item().prompt);
    for (const bullet of item().bullets ?? []) {
      expect(text(result)).toContain(bullet);
    }
  });

  it("reports a miss with the available locales rather than failing silently", async () => {
    const result = await call(h.client, "start_exam", {
      exam: "tcf",
      part: 1,
      locale: "de-DE",
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("de-DE");
    expect(text(result)).toContain("en-US");
  });

  it("rejects a part outside 1-3 at the schema boundary", async () => {
    const result = await call(h.client, "start_exam", { exam: "ielts", part: 7 });
    expect(result.isError).toBe(true);
  });
});

describe("F-4 · running an exam", () => {
  async function started(): Promise<string> {
    const result = await call(h.client, "start_exam", { exam: "ielts", part: 2 });
    return structured(result)["sessionId"] as string;
  }

  it("walks briefing to prep to speaking", async () => {
    const sessionId = await started();

    const prep = structured(await call(h.client, "advance_phase", { sessionId }));
    expect(prep["phase"]).toBe("prep");
    expect(prep["secondsRemaining"]).toBe(60);

    const speaking = structured(await call(h.client, "advance_phase", { sessionId }));
    expect(speaking["phase"]).toBe("speaking");
    expect(speaking["secondsRemaining"]).toBe(120);
  });

  it("returns follow-ups in order and reports exhaustion", async () => {
    const sessionId = await started();
    await call(h.client, "advance_phase", { sessionId });
    await call(h.client, "advance_phase", { sessionId });

    const first = structured(await call(h.client, "submit_response", { sessionId, transcript: "one" }));
    expect(first["followUp"]).toBe("Would you do it differently now?");
    expect(first["exhausted"]).toBe(false);

    await call(h.client, "submit_response", { sessionId, transcript: "two" });
    const third = structured(await call(h.client, "submit_response", { sessionId, transcript: "three" }));
    expect(third["exhausted"]).toBe(true);
  });

  it("reports the clock through get_status", async () => {
    const sessionId = await started();
    await call(h.client, "advance_phase", { sessionId });
    h.clock.advanceSeconds(20);

    const s = structured(await call(h.client, "get_status", { sessionId }));
    expect(s["phase"]).toBe("prep");
    expect(s["secondsRemaining"]).toBe(40);
    expect(s["overrun"]).toBe(false);
  });

  it("surfaces a phase violation with the legal actions, so the model can recover", async () => {
    const sessionId = await started();

    const result = await call(h.client, "submit_response", { sessionId, transcript: "too early" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("briefing");
    expect(text(result)).toContain("advance_phase");
    expect(structured(result)["legalActions"]).toContain("advance_phase");
  });

  it("reports an unknown session rather than throwing", async () => {
    const result = await call(h.client, "get_status", { sessionId: "nope" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("nope");
  });
});

describe("F-4 · overrun is recorded, never rejected (GAP-008)", () => {
  it("accepts a late answer in full and marks it", async () => {
    const start = structured(await call(h.client, "start_exam", { exam: "ielts", part: 1 }));
    const sessionId = start["sessionId"] as string;
    await call(h.client, "advance_phase", { sessionId });

    h.clock.advanceSeconds(60); // speakSeconds is 45

    const result = await call(h.client, "submit_response", {
      sessionId,
      transcript: "a long answer that ran past the limit",
    });
    const s = structured(result);

    expect(result.isError).toBeFalsy();
    expect(s["overrun"]).toBe(true);
    expect(s["overrunSeconds"]).toBe(15);
    expect(s["followUp"]).toBeTruthy();
  });

  it("flags overrun through get_status without ending the phase", async () => {
    const start = structured(await call(h.client, "start_exam", { exam: "ielts", part: 1 }));
    const sessionId = start["sessionId"] as string;
    await call(h.client, "advance_phase", { sessionId });
    h.clock.advanceSeconds(50);

    const s = structured(await call(h.client, "get_status", { sessionId }));
    expect(s["overrun"]).toBe(true);
    expect(s["phase"]).toBe("speaking");
  });

  it("passes accumulated overrun to the scorer as F-6 evidence", async () => {
    const start = structured(await call(h.client, "start_exam", { exam: "ielts", part: 1 }));
    const sessionId = start["sessionId"] as string;
    await call(h.client, "advance_phase", { sessionId });
    h.clock.advanceSeconds(60);
    await call(h.client, "submit_response", { sessionId, transcript: "late" });
    await call(h.client, "score_session", { sessionId });

    expect(h.scorer.lastRequest?.overrunSeconds).toBe(15);
    expect(h.scorer.lastRequest?.turns.some((t) => t.overrun)).toBe(true);
  });
});

describe("F-4 · scoring", () => {
  async function readyToScore(): Promise<string> {
    const start = structured(await call(h.client, "start_exam", { exam: "ielts", part: 1 }));
    const sessionId = start["sessionId"] as string;
    await call(h.client, "advance_phase", { sessionId });
    await call(h.client, "submit_response", { sessionId, transcript: "an answer" });
    return sessionId;
  }

  it("returns immediately with a poll hint rather than blocking", async () => {
    const sessionId = await readyToScore();
    const s = structured(await call(h.client, "score_session", { sessionId }));

    expect(s["status"]).toBe("pending");
    expect(s["pollAfterMs"]).toEqual(expect.any(Number));
  });

  it("keeps saying pending until the scorer is done", async () => {
    const sessionId = await readyToScore();
    await call(h.client, "score_session", { sessionId });

    const s = structured(await call(h.client, "get_results", { sessionId }));
    expect(s["status"]).toBe("pending");
  });

  it("reads back the three criteria and never claims a pronunciation score", async () => {
    const sessionId = await readyToScore();
    await call(h.client, "score_session", { sessionId });
    h.scorer.outcome = {
      status: "complete",
      scores: [
        {
          criterion: "fluency_coherence",
          band: "6",
          evidence: "You paused before each new point.",
          improvement: "Link ideas with a connective instead of stopping.",
        },
        {
          criterion: "lexical_resource",
          band: "7",
          evidence: "You used precise vocabulary for the topic.",
          improvement: "Vary your adjectives more.",
        },
        {
          criterion: "grammatical_range_accuracy",
          band: "5",
          evidence: "Past tenses slipped in two places.",
          improvement: "Practise the past perfect.",
        },
      ],
    };

    const result = await call(h.client, "get_results", { sessionId });
    const s = structured(result);

    expect(s["status"]).toBe("complete");
    expect(s["pronunciationAssessed"]).toBe(false);
    expect(text(result)).toContain("Fluency & Coherence");
    expect(text(result)).toContain("Grammatical Range & Accuracy");
    expect(text(result).toLowerCase()).not.toContain("pronunciation");
  });

  it("says so honestly when no grader is connected, instead of inventing bands", async () => {
    const sessionId = await readyToScore();
    await call(h.client, "score_session", { sessionId });
    h.scorer.outcome = { status: "unavailable", reason: "No grader configured." };

    const result = await call(h.client, "get_results", { sessionId });
    expect(structured(result)["status"]).toBe("unavailable");
    expect(text(result)).toContain("No grader configured.");
  });

  it("refuses get_results before scoring has started", async () => {
    const sessionId = await readyToScore();
    const result = await call(h.client, "get_results", { sessionId });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("score_session");
  });
});

describe("F-4 · progress", () => {
  it("starts empty and says so plainly", async () => {
    const result = await call(h.client, "get_progress");
    expect(structured(result)["sessionCount"]).toBe(0);
    expect(text(result)).toContain("No completed sessions yet");
  });

  it("records a completed session and names the weakest criterion", async () => {
    const start = structured(await call(h.client, "start_exam", { exam: "ielts", part: 1 }));
    const sessionId = start["sessionId"] as string;
    await call(h.client, "advance_phase", { sessionId });
    await call(h.client, "submit_response", { sessionId, transcript: "an answer" });
    await call(h.client, "score_session", { sessionId });
    h.scorer.outcome = {
      status: "complete",
      scores: [
        { criterion: "fluency_coherence", band: "8", evidence: "e", improvement: "i" },
        { criterion: "grammatical_range_accuracy", band: "4", evidence: "e", improvement: "i" },
      ],
    };
    await call(h.client, "get_results", { sessionId });

    const result = await call(h.client, "get_progress");
    const s = structured(result);

    expect(s["sessionCount"]).toBe(1);
    expect((s["weakest"] as { criterion: string }).criterion).toBe("grammatical_range_accuracy");
    expect(text(result)).toContain("Grammatical Range & Accuracy");
    expect(text(result)).toContain("hometown");
  });

  it("does not record progress when there were no scores to record", async () => {
    const start = structured(await call(h.client, "start_exam", { exam: "ielts", part: 1 }));
    const sessionId = start["sessionId"] as string;
    await call(h.client, "advance_phase", { sessionId });
    await call(h.client, "submit_response", { sessionId, transcript: "an answer" });
    await call(h.client, "score_session", { sessionId });
    h.scorer.outcome = { status: "unavailable", reason: "No grader." };
    await call(h.client, "get_results", { sessionId });

    expect(structured(await call(h.client, "get_progress"))["sessionCount"]).toBe(0);
  });
});

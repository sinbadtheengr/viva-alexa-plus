import { describe, expect, it } from "vitest";
import type { Exam } from "../src/exam/schema.js";
import { loadScorerConfig } from "../src/grading/config.js";
import type { RubricModel, RubricRequest } from "../src/grading/model.js";
import { buildSystemPrompt, buildUserPrompt } from "../src/grading/prompt.js";
import { bandsFor, rubricSchemaFor, validateScores } from "../src/grading/rubric.js";
import { RubricScorer } from "../src/grading/scorer.js";
import type { ScoreRequest } from "../src/grading/types.js";

function request(overrides: Partial<ScoreRequest> = {}): ScoreRequest {
  return {
    sessionId: "s1",
    exam: "ielts",
    locale: "en-US",
    part: 2,
    turns: [
      { role: "examiner", text: "Describe a piece of work you were proud of.", at: 1, overrun: false },
      { role: "candidate", text: "I built a small library for my team.", at: 2, overrun: false },
    ],
    overrunSeconds: 0,
    ...overrides,
  };
}

function goodScores(exam: Exam = "ielts") {
  const band = exam === "ielts" ? "7" : "B2";
  return {
    scores: [
      { criterion: "fluency_coherence", band, evidence: "You said 'I built a small library'.", improvement: "Link points with whereas." },
      { criterion: "lexical_resource", band, evidence: "You used 'library' precisely.", improvement: "Vary your verbs." },
      { criterion: "grammatical_range_accuracy", band, evidence: "Your past tense was consistent.", improvement: "Try a conditional." },
    ],
  };
}

/** A model whose replies the test scripts, per attempt. */
class ScriptedModel implements RubricModel {
  readonly name = "scripted";
  readonly calls: RubricRequest[] = [];
  constructor(private readonly replies: (unknown | null | Error)[]) {}

  async complete(request: RubricRequest): Promise<unknown | null> {
    this.calls.push(request);
    const reply = this.replies[this.calls.length - 1] ?? null;
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

async function runScorer(replies: (unknown | null | Error)[], req = request()) {
  const model = new ScriptedModel(replies);
  const scorer = new RubricScorer({ model, pollAfterMs: 10 });
  const handle = scorer.start(req);
  const immediate = scorer.poll(handle);
  await scorer.settled(handle);
  return { scorer, model, handle, immediate, outcome: scorer.poll(handle) };
}

// --------------------------------------------------------------------------

describe("F-6 · rubric schema and validation", () => {
  it("uses whole IELTS bands and CEFR levels", () => {
    expect(bandsFor("ielts")).toContain("9");
    expect(bandsFor("ielts")).not.toContain("6.5");
    expect(bandsFor("tcf")).toEqual(["A1", "A2", "B1", "B2", "C1", "C2"]);
  });

  it("bakes the exam's band set into the structured-output schema", () => {
    expect(rubricSchemaFor("ielts").safeParse(goodScores("ielts")).success).toBe(true);
    // A CEFR level is not a legal IELTS band, and the schema itself refuses it.
    expect(rubricSchemaFor("ielts").safeParse(goodScores("tcf")).success).toBe(false);
    expect(rubricSchemaFor("tcf").safeParse(goodScores("tcf")).success).toBe(true);
  });

  it("accepts a well-formed set of three", () => {
    const result = validateScores("ielts", goodScores());
    expect(result.problems).toEqual([]);
    expect(result.valid).toHaveLength(3);
  });

  it("rejects a band outside the exam's scale", () => {
    const bad = goodScores();
    bad.scores[0]!.band = "11";
    const result = validateScores("ielts", bad);
    expect(result.valid).toHaveLength(2);
    expect(result.problems.join(" ")).toContain('Band "11"');
  });

  it("rejects a criterion scored twice", () => {
    const bad = { scores: [goodScores().scores[0]!, goodScores().scores[0]!] };
    const result = validateScores("ielts", bad);
    expect(result.problems.join(" ")).toContain("more than once");
  });

  it("rejects empty evidence or improvement rather than reporting a bare band", () => {
    const bad = goodScores();
    bad.scores[1]!.evidence = "   ";
    const result = validateScores("ielts", bad);
    expect(result.valid.map((s) => s.criterion)).not.toContain("lexical_resource");
    expect(result.problems.join(" ")).toContain("no evidence");
  });

  it("names every criterion the model omitted", () => {
    const result = validateScores("ielts", { scores: [goodScores().scores[0]!] });
    expect(result.problems.filter((p) => p.includes("was not scored"))).toHaveLength(2);
  });

  it("survives junk instead of a scores array", () => {
    expect(validateScores("ielts", null).valid).toEqual([]);
    expect(validateScores("ielts", { scores: "nope" }).problems).toHaveLength(1);
  });
});

describe("F-6 · prompt", () => {
  it("states that audio was unavailable and pronunciation is not assessable (GAP-004)", () => {
    const prompt = buildSystemPrompt(request());
    expect(prompt).toMatch(/did NOT hear the audio/i);
    expect(prompt).toMatch(/Pronunciation[\s\S]*NOT\s*\n?\s*assessable/i);
  });

  it("names only the three criteria", () => {
    const prompt = buildSystemPrompt(request());
    expect(prompt).toContain("Fluency & Coherence");
    expect(prompt).toContain("Lexical Resource");
    expect(prompt).toContain("Grammatical Range & Accuracy");
  });

  it("gives the model the right scale per exam", () => {
    expect(buildSystemPrompt(request({ exam: "ielts" }))).toContain("IELTS band");
    expect(buildSystemPrompt(request({ exam: "tcf" }))).toContain("CEFR level");
  });

  it("frames overrun as evidence, not as a violation (GAP-008)", () => {
    const system = buildSystemPrompt(request());
    expect(system).toMatch(/not a rule\s*\n?\s*violation/i);

    const user = buildUserPrompt(request({ overrunSeconds: 18 }));
    expect(user).toContain("18 seconds past the limit");
    expect(user).toContain("Fluency & Coherence");
  });

  it("marks the late turn in the transcript", () => {
    const user = buildUserPrompt(
      request({
        turns: [{ role: "candidate", text: "ran long", at: 1, overrun: true }],
        overrunSeconds: 5,
      }),
    );
    expect(user).toContain("CANDIDATE [delivered after time expired]: ran long");
  });

  it("says plainly when the candidate kept to time", () => {
    expect(buildUserPrompt(request())).toContain("stayed within the time limit");
  });
});

describe("F-6 · scoring lifecycle", () => {
  it("returns a handle immediately and reports pending before the model answers", async () => {
    const { immediate } = await runScorer([goodScores()]);
    expect(immediate.status).toBe("pending");
    expect(immediate).toMatchObject({ pollAfterMs: 10 });
  });

  it("completes with three criteria on a clean first attempt", async () => {
    const { outcome, model } = await runScorer([goodScores()]);
    expect(outcome.status).toBe("complete");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.effort).toBe("high");
  });

  it("retries once, at higher effort, restating what was wrong", async () => {
    const bad = goodScores();
    bad.scores[0]!.band = "99";

    const { outcome, model } = await runScorer([bad, goodScores()]);

    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.effort).toBe("max");
    expect(model.calls[1]!.user).toContain("previous response was rejected");
    expect(model.calls[1]!.user).toContain('Band "99"');
    expect(outcome.status).toBe("complete");
  });

  it("never retries more than once", async () => {
    const bad = goodScores();
    bad.scores[0]!.band = "99";
    const { model } = await runScorer([bad, bad]);
    expect(model.calls).toHaveLength(2);
  });

  it("returns partial rather than fabricating the criteria it could not mark", async () => {
    const partial = { scores: [goodScores().scores[0]!, goodScores().scores[1]!] };

    const { outcome } = await runScorer([partial, partial]);

    expect(outcome.status).toBe("partial");
    if (outcome.status !== "partial") throw new Error("unreachable");
    expect(outcome.scores).toHaveLength(2);
    expect(outcome.scores.map((s) => s.criterion)).not.toContain("grammatical_range_accuracy");
    expect(outcome.note).toContain("rather than guess");
  });

  it("keeps the attempt that verified more criteria", async () => {
    const one = { scores: [goodScores().scores[0]!] };
    const two = { scores: [goodScores().scores[0]!, goodScores().scores[1]!] };

    const { outcome } = await runScorer([one, two]);

    expect(outcome.status).toBe("partial");
    if (outcome.status !== "partial") throw new Error("unreachable");
    expect(outcome.scores).toHaveLength(2);
  });

  it("reports unavailable, not a low score, when nothing could be marked", async () => {
    const { outcome } = await runScorer([null, null]);
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toContain("recorded in full");
  });

  it("reports unavailable when the grading service throws", async () => {
    const { outcome } = await runScorer([new Error("bedrock unreachable")]);
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toContain("unreachable");
    // The candidate never sees a band the model did not produce.
    expect(JSON.stringify(outcome)).not.toMatch(/"band"/);
  });

  it("does not reject when the model throws, so start() cannot crash the server", async () => {
    const model = new ScriptedModel([new Error("boom")]);
    const scorer = new RubricScorer({ model });
    const handle = scorer.start(request());
    await expect(scorer.settled(handle)).resolves.toBeUndefined();
  });

  it("reports an unknown handle honestly", async () => {
    const { scorer } = await runScorer([goodScores()]);
    expect(scorer.poll("not-a-handle").status).toBe("unavailable");
  });

  it("scores a TCF session on CEFR levels", async () => {
    const { outcome } = await runScorer([goodScores("tcf")], request({ exam: "tcf", locale: "fr-FR" }));
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") throw new Error("unreachable");
    expect(outcome.scores.every((s) => /^[ABC][12]$/.test(s.band))).toBe(true);
  });
});

describe("F-6 · grader selection", () => {
  it("stays off, with no AWS involvement, when no region is configured", () => {
    const config = loadScorerConfig({} as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
  });

  it("turns on when a region is given", () => {
    const config = loadScorerConfig({ VIVA_BEDROCK_REGION: "us-east-1" } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.model).toBe("anthropic.claude-opus-5");
  });

  it("can be switched off explicitly even with a region present", () => {
    const config = loadScorerConfig({
      AWS_REGION: "us-east-1",
      VIVA_SCORING_DISABLED: "1",
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
  });
});

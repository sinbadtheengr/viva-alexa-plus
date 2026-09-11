import { describe, expect, it } from "vitest";
import { Corpus } from "../src/exam/corpus.js";
import { PhaseViolationError, UnknownSessionError } from "../src/exam/errors.js";
import { SessionStore } from "../src/exam/session.js";
import { fakeClock, item, unpreppedItem } from "./fixtures.js";

function storeWith(items = [item(), unpreppedItem()], clock = fakeClock()) {
  const corpus = Corpus.fromItems(items);
  let n = 0;
  const store = new SessionStore({
    resolver: corpus,
    now: clock.now,
    newId: () => `session-${++n}`,
  });
  return { store, corpus, clock };
}

describe("F-3 · session lifecycle", () => {
  it("opens in briefing with the prompt already spoken", () => {
    const { store } = storeWith();
    const session = store.create(item());

    expect(session.phase).toBe("briefing");
    expect(session.phaseDeadline).toBeNull();
    expect(session.turns).toEqual([
      expect.objectContaining({ role: "examiner", text: item().prompt }),
    ]);
  });

  it("carries locale, exam and part from the corpus item, not from a caller", () => {
    const { store } = storeWith();
    const session = store.create(item({ locale: "fr-FR", exam: "tcf", id: "tcf.p2.a.001" }));

    expect(session.locale).toBe("fr-FR");
    expect(session.exam).toBe("tcf");
    expect(session.part).toBe(2);
  });

  it("goes briefing to prep when the item allows preparation time", () => {
    const { store, clock } = storeWith();
    const { id } = store.create(item());

    const result = store.advance(id);

    expect(result.phase).toBe("prep");
    expect(result.secondsRemaining).toBe(60);
    expect(result.session.phaseDeadline).toBe(clock.now() + 60_000);
  });

  it("skips prep entirely when the item has none", () => {
    const { store } = storeWith();
    const { id } = store.create(unpreppedItem());

    const result = store.advance(id);

    expect(result.phase).toBe("speaking");
    expect(result.secondsRemaining).toBe(45);
  });

  it("goes prep to speaking with the speaking clock", () => {
    const { store } = storeWith();
    const { id } = store.create(item());

    store.advance(id);
    const result = store.advance(id);

    expect(result.phase).toBe("speaking");
    expect(result.secondsRemaining).toBe(120);
  });
});

describe("F-3 · timing is server-owned", () => {
  it("counts down as the clock moves", () => {
    const { store, clock } = storeWith();
    const { id } = store.create(item());
    store.advance(id);

    expect(store.status(id).secondsRemaining).toBe(60);
    clock.advanceSeconds(25);
    expect(store.status(id).secondsRemaining).toBe(35);
  });

  it("floors at zero rather than going negative", () => {
    const { store, clock } = storeWith();
    const { id } = store.create(item());
    store.advance(id);

    clock.advanceSeconds(90);

    expect(store.status(id).secondsRemaining).toBe(0);
  });

  it("reports untimed phases as null, not as zero", () => {
    const { store } = storeWith();
    const { id } = store.create(item());

    expect(store.status(id).secondsRemaining).toBeNull();
  });
});

describe("F-3 · follow-up probes run without a model", () => {
  it("returns seeds in order and records both sides of the exchange", () => {
    const { store } = storeWith();
    const { id } = store.create(unpreppedItem());
    store.advance(id);

    const first = store.submitResponse(id, "I grew up in a small town near the coast.");

    expect(first.phase).toBe("followup");
    expect(first.followUp).toBe("Would you do it differently now?");
    expect(first.exhausted).toBe(false);
    expect(first.session.turns.map((t) => t.role)).toEqual([
      "examiner",
      "candidate",
      "examiner",
    ]);
  });

  it("walks the whole seed list, then reports exhaustion", () => {
    const { store } = storeWith();
    const { id } = store.create(unpreppedItem());
    store.advance(id);

    expect(store.submitResponse(id, "one").followUp).toBe("Would you do it differently now?");
    expect(store.submitResponse(id, "two").followUp).toBe("Who noticed?");

    const third = store.submitResponse(id, "three");
    expect(third.followUp).toBeNull();
    expect(third.exhausted).toBe(true);
    expect(third.phase).toBe("followup");
  });

  it("still records the final answer once seeds run out", () => {
    const { store } = storeWith();
    const { id } = store.create(unpreppedItem());
    store.advance(id);
    store.submitResponse(id, "one");
    store.submitResponse(id, "two");

    const session = store.submitResponse(id, "the last thing I said").session;

    expect(session.turns.at(-1)).toMatchObject({
      role: "candidate",
      text: "the last thing I said",
    });
  });
});

describe("F-3 · illegal transitions", () => {
  it("refuses submit_response during prep and names the legal actions", () => {
    const { store } = storeWith();
    const { id } = store.create(item());
    store.advance(id);

    expect(() => store.submitResponse(id, "too early")).toThrow(PhaseViolationError);

    try {
      store.submitResponse(id, "too early");
      expect.unreachable("should have thrown");
    } catch (error) {
      const violation = error as PhaseViolationError;
      expect(violation.phase).toBe("prep");
      expect(violation.action).toBe("submit_response");
      expect(violation.legalActions).toContain("advance_phase");
      expect(violation.message).toContain("prep");
      expect(violation.message).toContain("advance_phase");
    }
  });

  it("refuses scoring before the candidate has spoken", () => {
    const { store } = storeWith();
    const { id } = store.create(item());

    expect(() => store.beginScoring(id, "job-1")).toThrow(PhaseViolationError);
  });

  it("refuses to advance once the session is complete", () => {
    const { store } = storeWith();
    const { id } = store.create(unpreppedItem());
    store.advance(id);
    store.submitResponse(id, "answer");
    store.beginScoring(id, "job-1");
    store.completeScoring(id);

    expect(() => store.advance(id)).toThrow(PhaseViolationError);
  });

  it("allows get_status in every phase", () => {
    const { store } = storeWith();
    const { id } = store.create(unpreppedItem());

    const steps = [
      () => store.advance(id),
      () => store.submitResponse(id, "answer"),
      () => store.beginScoring(id, "job-1"),
      () => store.completeScoring(id),
    ];

    for (const step of steps) {
      expect(() => store.status(id)).not.toThrow();
      step();
    }
    expect(() => store.status(id)).not.toThrow();
  });
});

describe("F-3 · scoring handoff", () => {
  it("moves followup to scoring to complete and keeps the handle", () => {
    const { store } = storeWith();
    const { id } = store.create(unpreppedItem());
    store.advance(id);
    store.submitResponse(id, "answer");

    const scoring = store.beginScoring(id, "bedrock-job-42");
    expect(scoring.phase).toBe("scoring");
    expect(scoring.scoringHandle).toBe("bedrock-job-42");

    expect(store.completeScoring(id).phase).toBe("complete");
  });
});

describe("F-3 · expiry", () => {
  it("treats a session idle past the limit as gone", () => {
    const clock = fakeClock();
    const { store } = storeWith([item()], clock);
    const { id } = store.create(item());

    clock.advanceMs(30 * 60 * 1000 + 1);

    expect(() => store.get(id)).toThrow(UnknownSessionError);
  });

  it("reports the first expired read as expired, not as unknown", () => {
    const clock = fakeClock();
    const { store } = storeWith([item()], clock);
    const { id } = store.create(item());

    clock.advanceMs(30 * 60 * 1000 + 1);

    try {
      store.get(id);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as UnknownSessionError).reason).toBe("expired");
    }
  });

  it("keeps a session alive while it is being used", () => {
    const clock = fakeClock();
    const { store } = storeWith([unpreppedItem()], clock);
    const { id } = store.create(unpreppedItem());
    store.advance(id);

    // Four 20-minute gaps: well past the 30-minute limit in total, but never
    // 30 minutes of silence in a row.
    for (let i = 0; i < 4; i++) {
      clock.advanceMs(20 * 60 * 1000);
      expect(() => store.submitResponse(id, `answer ${i}`)).not.toThrow();
    }

    expect(store.status(id).phase).toBe("followup");
  });

  it("sweep drops only the expired sessions", () => {
    const clock = fakeClock();
    const { store } = storeWith([item()], clock);
    store.create(item());
    clock.advanceMs(31 * 60 * 1000);
    const fresh = store.create(item());

    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(1);
    expect(() => store.get(fresh.id)).not.toThrow();
  });

  it("reports an unknown id as not-found", () => {
    const { store } = storeWith();
    expect(() => store.get("nope")).toThrow(UnknownSessionError);
  });
});

import type { ExamItem } from "../src/exam/schema.js";

export function item(overrides: Partial<ExamItem> = {}): ExamItem {
  return {
    id: "ielts.p2.work.001",
    exam: "ielts",
    locale: "en-US",
    part: 2,
    topic: "work",
    prompt: "Describe a piece of work you were proud of.",
    bullets: ["what it was", "why it mattered"],
    prepSeconds: 60,
    speakSeconds: 120,
    followUpSeeds: ["Would you do it differently now?", "Who noticed?"],
    ...overrides,
  } as ExamItem;
}

/** An item with no prep time — part 1 and part 3 shape. */
export function unpreppedItem(overrides: Partial<ExamItem> = {}): ExamItem {
  return item({
    id: "ielts.p1.hometown.001",
    part: 1,
    topic: "hometown",
    prompt: "Tell me about where you grew up.",
    bullets: undefined,
    prepSeconds: 0,
    speakSeconds: 45,
    ...overrides,
  });
}

/** A controllable clock, so timing is tested without sleeping. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advanceMs: (ms: number) => {
      t += ms;
    },
    advanceSeconds: (s: number) => {
      t += s * 1000;
    },
  };
}

import type { Turn } from "../exam/session.js";
import type { Exam, Part } from "../exam/schema.js";

/**
 * The seam F-6 (Bedrock rubric scoring) plugs into.
 *
 * Scoring is deliberately a two-step interface — `start` then `poll` — because
 * a model call cannot fit the 500ms tool budget (GAP-005). Nothing that
 * implements this may block.
 */

/**
 * The three transcript-observable criteria. Pronunciation is absent on purpose:
 * tools receive a transcript, never audio, so it cannot be assessed (GAP-004).
 */
export const CRITERIA = [
  "fluency_coherence",
  "lexical_resource",
  "grammatical_range_accuracy",
] as const;

export type Criterion = (typeof CRITERIA)[number];

export const CRITERION_LABELS: Readonly<Record<Criterion, string>> = {
  fluency_coherence: "Fluency & Coherence",
  lexical_resource: "Lexical Resource",
  grammatical_range_accuracy: "Grammatical Range & Accuracy",
};

export interface CriterionScore {
  readonly criterion: Criterion;
  /** IELTS band "1".."9" or CEFR level "A1".."C2" — validated against the exam's set. */
  readonly band: string;
  /** One sentence quoting the candidate. */
  readonly evidence: string;
  /** One concrete thing to do differently. */
  readonly improvement: string;
}

export interface ScoreRequest {
  readonly sessionId: string;
  readonly exam: Exam;
  readonly locale: string;
  readonly part: Part;
  readonly turns: readonly Turn[];
  /** Passed to the rubric as Fluency & Coherence evidence (GAP-008). */
  readonly overrunSeconds: number;
}

export type ScoreOutcome =
  | { readonly status: "pending"; readonly pollAfterMs: number }
  | { readonly status: "complete"; readonly scores: readonly CriterionScore[] }
  /** Some criteria could not be scored. Never pad the gap with a guess. */
  | { readonly status: "partial"; readonly scores: readonly CriterionScore[]; readonly note: string }
  | { readonly status: "unavailable"; readonly reason: string };

export interface Scorer {
  readonly name: string;
  /** Kicks off scoring and returns a handle. Must return immediately. */
  start(request: ScoreRequest): string;
  /** Must return immediately with whatever is known so far. */
  poll(handle: string): ScoreOutcome;
}

/**
 * Stands in until F-6 lands. It reports honestly that scoring is not wired up
 * rather than inventing bands — a fabricated score is worse than no score.
 */
export class UnavailableScorer implements Scorer {
  readonly name = "unavailable";
  #n = 0;

  start(_request: ScoreRequest): string {
    return `unavailable-${++this.#n}`;
  }

  poll(_handle: string): ScoreOutcome {
    return {
      status: "unavailable",
      reason:
        "Rubric scoring is not configured on this server yet (F-6). The exam transcript was recorded in full and can be scored once a grader is connected.",
    };
  }
}

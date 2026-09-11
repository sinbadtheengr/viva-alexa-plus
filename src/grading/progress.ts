import type { Exam, Part } from "../exam/schema.js";
import type { Criterion, CriterionScore } from "./types.js";
import { CRITERION_LABELS } from "./types.js";

/**
 * The seam F-7 (progress tracking) plugs into.
 *
 * Records are keyed by `owner`, which is a placeholder until GAP-007 settles how
 * Alexa+ identifies a user to the server across turns. Everything else here is
 * final; only the key is provisional.
 */

export interface ProgressRecord {
  readonly owner: string;
  readonly at: number;
  readonly exam: Exam;
  readonly part: Part;
  readonly topic: string;
  readonly scores: readonly CriterionScore[];
}

export interface ProgressSummary {
  readonly sessionCount: number;
  /** The criterion with the lowest trailing-3 mean, or null with too little data. */
  readonly weakest: { readonly criterion: Criterion; readonly label: string; readonly mean: number } | null;
  /** Topics where the weakest criterion showed up, most recent first. */
  readonly recurringTopics: readonly string[];
}

export interface ProgressStore {
  append(record: ProgressRecord): void;
  summarize(owner: string): ProgressSummary;
}

/** Bands are "1".."9" (IELTS) or "A1".."C2" (TCF); only the former are averaged. */
function numericBand(band: string): number | null {
  const n = Number(band);
  return Number.isFinite(n) ? n : null;
}

export class InMemoryProgressStore implements ProgressStore {
  readonly #byOwner = new Map<string, ProgressRecord[]>();

  append(record: ProgressRecord): void {
    const existing = this.#byOwner.get(record.owner);
    if (existing) existing.push(record);
    else this.#byOwner.set(record.owner, [record]);
  }

  summarize(owner: string): ProgressSummary {
    const records = this.#byOwner.get(owner) ?? [];
    if (records.length === 0) {
      return { sessionCount: 0, weakest: null, recurringTopics: [] };
    }

    const recent = [...records].sort((a, b) => b.at - a.at).slice(0, 3);

    // Trailing-3 mean per criterion. Sum and count separately — averaging an
    // average would weight the oldest session most heavily.
    const totals = new Map<Criterion, { sum: number; count: number }>();
    for (const record of recent) {
      for (const score of record.scores) {
        const value = numericBand(score.band);
        if (value === null) continue;
        const entry = totals.get(score.criterion) ?? { sum: 0, count: 0 };
        entry.sum += value;
        entry.count += 1;
        totals.set(score.criterion, entry);
      }
    }

    let lowest: ProgressSummary["weakest"] = null;
    for (const [criterion, { sum, count }] of totals) {
      const mean = sum / count;
      if (lowest === null || mean < lowest.mean) {
        lowest = { criterion, label: CRITERION_LABELS[criterion], mean };
      }
    }

    // Bind to a const so narrowing survives into the callback below.
    const weakest = lowest;
    const recurringTopics =
      weakest === null
        ? []
        : [
            ...new Set(
              recent
                .filter((r) => r.scores.some((s) => s.criterion === weakest.criterion))
                .map((r) => r.topic),
            ),
          ];

    return { sessionCount: records.length, weakest, recurringTopics };
  }
}

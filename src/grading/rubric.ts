import { z } from "zod";
import type { Exam } from "../exam/schema.js";
import { CRITERIA, type Criterion, type CriterionScore } from "./types.js";

/**
 * F-6 · The rubric contract.
 *
 * The allowed band set is part of the schema handed to the model, so a level
 * outside it cannot be produced in the first place — and is checked again here
 * anyway. A score we cannot verify is dropped, never repaired into a guess.
 */

/** IELTS marks each criterion on a whole band 1–9. */
export const IELTS_BANDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** TCF reports CEFR levels. */
export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;

export function bandsFor(exam: Exam): readonly string[] {
  return exam === "ielts" ? IELTS_BANDS : CEFR_LEVELS;
}

export function scaleNameFor(exam: Exam): string {
  return exam === "ielts" ? "IELTS band (1–9, whole bands only)" : "CEFR level (A1–C2)";
}

/**
 * Built per exam so the band enum is baked into the structured-output schema
 * the model must satisfy.
 */
export function rubricSchemaFor(exam: Exam) {
  const bands = bandsFor(exam) as unknown as [string, ...string[]];
  return z.object({
    scores: z
      .array(
        z.object({
          criterion: z.enum(CRITERIA as unknown as [Criterion, ...Criterion[]]),
          band: z.enum(bands),
          evidence: z
            .string()
            .min(1)
            .describe("One sentence quoting the candidate's own words."),
          improvement: z
            .string()
            .min(1)
            .describe("One concrete thing to do differently next time."),
        }),
      )
      .length(CRITERIA.length),
  });
}

export interface ValidationResult {
  readonly valid: readonly CriterionScore[];
  /** Human-readable reasons, one per rejected or missing criterion. */
  readonly problems: readonly string[];
}

/**
 * Checks the model's output independently of the schema. Structured outputs
 * should make most of this unreachable — which is exactly why it is worth
 * having: if the guarantee ever slips, we drop the bad score instead of
 * reporting it.
 */
export function validateScores(exam: Exam, raw: unknown): ValidationResult {
  const bands = new Set(bandsFor(exam));
  const problems: string[] = [];
  const valid: CriterionScore[] = [];
  const seen = new Set<Criterion>();

  const rows = (raw as { scores?: unknown })?.scores;
  if (!Array.isArray(rows)) {
    return { valid: [], problems: ["Model returned no scores array."] };
  }

  for (const row of rows) {
    const entry = row as Partial<CriterionScore>;
    const criterion = entry.criterion;

    if (!criterion || !CRITERIA.includes(criterion)) {
      problems.push(`Unknown criterion "${String(criterion)}".`);
      continue;
    }
    if (seen.has(criterion)) {
      problems.push(`Criterion "${criterion}" was scored more than once.`);
      continue;
    }
    if (typeof entry.band !== "string" || !bands.has(entry.band)) {
      problems.push(`Band "${String(entry.band)}" is not valid for ${exam}.`);
      continue;
    }
    if (typeof entry.evidence !== "string" || entry.evidence.trim().length === 0) {
      problems.push(`Criterion "${criterion}" has no evidence.`);
      continue;
    }
    if (typeof entry.improvement !== "string" || entry.improvement.trim().length === 0) {
      problems.push(`Criterion "${criterion}" has no improvement.`);
      continue;
    }

    seen.add(criterion);
    valid.push({
      criterion,
      band: entry.band,
      evidence: entry.evidence.trim(),
      improvement: entry.improvement.trim(),
    });
  }

  for (const criterion of CRITERIA) {
    if (!seen.has(criterion)) problems.push(`Criterion "${criterion}" was not scored.`);
  }

  return { valid, problems };
}

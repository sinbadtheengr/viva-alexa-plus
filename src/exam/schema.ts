import { z } from "zod";

/**
 * F-2 · Exam corpus schema.
 *
 * The server refuses to start on an invalid corpus, so every constraint that
 * matters at runtime is expressed here rather than checked defensively later.
 */

export const EXAMS = ["ielts", "tcf"] as const;
export const PARTS = [1, 2, 3] as const;

export const examItemSchema = z
  .object({
    /** Stable id, e.g. "ielts.p2.work.001". Referenced by progress records. */
    id: z.string().regex(/^[a-z]+\.p[123]\.[a-z-]+\.\d{3}$/, {
      message: 'id must look like "ielts.p2.work.001"',
    }),
    exam: z.enum(EXAMS),
    /** BCP 47 tag. Never assume en-US (GAP-003). */
    locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, {
      message: 'locale must be a BCP 47 tag like "en-US"',
    }),
    part: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    topic: z.string().min(1),
    /** Spoken to the candidate verbatim. */
    prompt: z.string().min(1),
    /** Part 2 cue-card sub-points. Absent for parts without a cue card. */
    bullets: z.array(z.string().min(1)).min(1).optional(),
    prepSeconds: z.number().int().min(0).max(600),
    speakSeconds: z.number().int().min(15).max(600),
    /**
     * Fallback probes used when Bedrock is unavailable or slow.
     * Non-empty by contract: the exam must run to completion with the LLM down.
     */
    followUpSeeds: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .refine((item) => item.part !== 2 || item.bullets !== undefined, {
    message: "part 2 items must carry cue-card bullets",
    path: ["bullets"],
  });

export type ExamItem = z.infer<typeof examItemSchema>;

export const corpusFileSchema = z
  .object({
    /**
     * Provenance is required, not decorative: the repo is public and must
     * contain only original content (GAP-002 / hard rule 1).
     */
    provenance: z.string().min(1),
    items: z.array(examItemSchema).min(1),
  })
  .strict();

export type CorpusFile = z.infer<typeof corpusFileSchema>;

export type Exam = (typeof EXAMS)[number];
export type Part = (typeof PARTS)[number];

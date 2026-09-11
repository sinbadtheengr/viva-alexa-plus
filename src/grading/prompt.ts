import type { ScoreRequest } from "./types.js";
import { CRITERION_LABELS } from "./types.js";
import { bandsFor, scaleNameFor } from "./rubric.js";

/**
 * F-6 · Rubric prompt construction.
 *
 * Two things the prompt must always say, because getting either wrong would
 * produce a dishonest report:
 *  - audio was never available, so pronunciation is not assessable (GAP-004);
 *  - overrun is evidence to weigh under Fluency & Coherence, not a rule
 *    violation to punish (GAP-008).
 */

export function buildSystemPrompt(request: ScoreRequest): string {
  const scale = scaleNameFor(request.exam);
  const bands = bandsFor(request.exam).join(", ");
  const examName = request.exam === "ielts" ? "IELTS Speaking" : "TCF Expression Orale";

  return [
    `You are an experienced ${examName} examiner marking one candidate's performance.`,
    "",
    "Mark only these three criteria:",
    ...Object.entries(CRITERION_LABELS).map(([key, label]) => `  - ${label} (${key})`),
    "",
    `Use this scale for every criterion: ${scale}. Allowed values: ${bands}.`,
    "",
    "Rules you must follow:",
    "- You received a written transcript of speech. You did NOT hear the audio.",
    "  Pronunciation, accent, intonation and audible hesitation are therefore NOT",
    "  assessable. Never mention them, never score them, and never let them",
    "  influence the three criteria above.",
    "- Quote the candidate's own words in the evidence. If you cannot find",
    "  supporting words for a judgement, choose a judgement you can support.",
    "- Give one concrete, actionable improvement per criterion. Vague advice such",
    "  as 'practise more' is not an improvement; 'link your points with whereas",
    "  instead of stopping' is.",
    "- Mark what is actually there. A short or thin answer earns a low band;",
    "  do not inflate to be kind, and do not deflate to seem rigorous.",
    "- If the candidate ran past their time, weigh that under Fluency & Coherence",
    "  as evidence about planning and reaching a conclusion. It is not a rule",
    "  violation and carries no automatic penalty.",
  ].join("\n");
}

export function buildUserPrompt(request: ScoreRequest): string {
  const lines: string[] = [
    `Exam: ${request.exam.toUpperCase()}, part ${request.part}, locale ${request.locale}.`,
    "",
    "Transcript:",
  ];

  for (const turn of request.turns) {
    const who = turn.role === "examiner" ? "EXAMINER" : "CANDIDATE";
    const late = turn.overrun ? " [delivered after time expired]" : "";
    lines.push(`${who}${late}: ${turn.text}`);
  }

  lines.push("");
  if (request.overrunSeconds > 0) {
    lines.push(
      `Timing: the candidate ran ${request.overrunSeconds} seconds past the limit in total. ` +
        "Weigh this under Fluency & Coherence as evidence about pacing and reaching a conclusion.",
    );
  } else {
    lines.push("Timing: the candidate stayed within the time limit.");
  }

  lines.push("");
  lines.push("Mark the three criteria now.");
  return lines.join("\n");
}

/**
 * Appended on the single retry. The first attempt failing means the model
 * produced something outside the contract, so the retry states the contract
 * again rather than simply asking again.
 */
export function buildRetryInstruction(problems: readonly string[]): string {
  return [
    "Your previous response was rejected:",
    ...problems.map((p) => `  - ${p}`),
    "",
    "Return exactly one entry for each of the three criteria, using only the",
    "allowed values for the scale. Every entry needs non-empty evidence quoting",
    "the candidate and a non-empty concrete improvement.",
  ].join("\n");
}

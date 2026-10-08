import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { subjectOf } from "../auth/identity.js";
import { DEFAULT_LOCALE } from "../config.js";
import type { Corpus } from "../exam/corpus.js";
import { PhaseViolationError, UnknownSessionError } from "../exam/errors.js";
import { EXAMS } from "../exam/schema.js";
import type { SessionStore } from "../exam/session.js";
import type { ProgressStore } from "../grading/progress.js";
import type { Scorer } from "../grading/types.js";
import { CRITERION_LABELS } from "../grading/types.js";
import type { ProbeCoordinator } from "../probes/probes.js";
import type { Logger } from "./logging.js";

/**
 * F-4 · The seven tools.
 *
 * Descriptions are written for a reasoning model deciding *when* to call
 * something, not for a developer reading an API doc — they say what the tool is
 * for, what the model should do with the result, and when not to call it.
 *
 * Every handler is wrapped by `logger.timed` against its documented budget, so
 * a regression against the 500ms round trip shows up in the log immediately.
 */

export interface ToolDeps {
  readonly corpus: Corpus;
  readonly sessions: SessionStore;
  readonly scorer: Scorer;
  readonly progress: ProgressStore;
  readonly logger: Logger;
  /** F-5 - optional; without it every follow-up is a corpus seed. */
  readonly probes?: ProbeCoordinator;
  /**
   * F-7 · Resolves the caller to a progress key, or null when this connection
   * carries no identity. Defaults to the OAuth grant subject on the request's
   * access token — see auth/identity.ts for why that and nothing else.
   */
  readonly identify?: (extra: ToolExtra) => string | null;
  readonly now?: () => number;
}

/**
 * The slice of the SDK's request context these handlers use. Declared
 * structurally so a test can call a handler with a bare object.
 */
export interface ToolExtra {
  readonly authInfo?: AuthInfo;
}

interface ToolResult {
  // The SDK's CallToolResult carries an index signature for protocol
  // extensions; without one here the shapes are not assignable.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function say(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/**
 * Domain errors reach the model with their message intact. A phase violation
 * already names the legal actions, which is exactly what a model needs in order
 * to recover inside the conversation instead of dead-ending.
 */
function fail(error: unknown): ToolResult {
  if (error instanceof PhaseViolationError) {
    return {
      content: [{ type: "text", text: error.message }],
      structuredContent: {
        error: "phase_violation",
        phase: error.phase,
        legalActions: [...error.legalActions],
      },
      isError: true,
    };
  }
  if (error instanceof UnknownSessionError) {
    return {
      content: [{ type: "text", text: error.message }],
      structuredContent: { error: error.reason },
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: "internal" },
    isError: true,
  };
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { corpus, sessions, scorer, progress, logger, probes } = deps;
  const identify = deps.identify ?? ((extra: ToolExtra) => subjectOf(extra.authInfo));
  const now = deps.now ?? Date.now;

  const run = <T>(tool: string, budgetMs: number, fn: () => T): T | ToolResult => {
    try {
      return logger.timed(tool, budgetMs, fn);
    } catch (error) {
      return fail(error);
    }
  };

  server.registerTool(
    "start_exam",
    {
      title: "Start a speaking exam",
      description:
        "Begins a timed speaking-exam practice session and returns the examiner's opening prompt. " +
        "Call this when the user wants to practise speaking, sit a mock oral exam, or prepare for IELTS or TCF. " +
        "Read the returned prompt aloud verbatim — it is exam wording and must not be paraphrased. " +
        "If the prompt comes with cue-card bullets, read those too. " +
        "Then call advance_phase to start the clock. Do not ask the user to answer before you have done that.",
      inputSchema: {
        exam: z.enum(EXAMS).describe("ielts for English, tcf for French"),
        part: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .describe("Exam part. 2 is the long-turn cue card; 1 and 3 are shorter exchanges."),
        locale: z
          .string()
          .optional()
          .describe(`BCP 47 tag such as en-US or fr-FR. Defaults to ${DEFAULT_LOCALE}.`),
        topic: z
          .string()
          .optional()
          .describe("Optional topic, e.g. work or travel. Omit to let the examiner choose."),
      },
    },
    async ({ exam, part, locale, topic }) =>
      run("start_exam", 100, () => {
        const query = { exam, part, locale: locale ?? DEFAULT_LOCALE, ...(topic ? { topic } : {}) };
        const item = corpus.pick(query);
        if (!item) {
          return fail(
            new Error(
              `No ${exam} part ${part} item for locale ${query.locale}` +
                (topic ? ` on topic "${topic}"` : "") +
                `. Available locales: ${corpus.locales().join(", ")}.`,
            ),
          );
        }

        const session = sessions.create(item);
        const lines = [item.prompt];
        if (item.bullets) lines.push(...item.bullets.map((b) => `— ${b}`));

        return say(lines.join("\n"), {
          sessionId: session.id,
          view: "cue_card",
          prompt: item.prompt,
          bullets: item.bullets ?? [],
          exam: item.exam,
          part: item.part,
          locale: item.locale,
          topic: item.topic,
          prepSeconds: item.prepSeconds,
          speakSeconds: item.speakSeconds,
          phase: session.phase,
        });
      }),
  );

  server.registerTool(
    "get_status",
    {
      title: "Check the exam clock",
      description:
        "Reports which phase the session is in and how many seconds remain. " +
        "Call this when the user asks how long is left, or before deciding whether to prompt them. " +
        "If overrun is true the candidate is past their time — you may gently prompt them to conclude, " +
        "but never cut them off, and never refuse their answer.",
      inputSchema: { sessionId: z.string().describe("From start_exam.") },
    },
    async ({ sessionId }) =>
      run("get_status", 50, () => {
        const status = sessions.status(sessionId);
        const clock =
          status.secondsRemaining === null
            ? "This phase is not timed."
            : status.overrun
              ? "Time is up for this phase."
              : `${status.secondsRemaining} seconds remaining.`;
        return say(`Phase: ${status.phase}. ${clock}`, { view: "clock", ...status });
      }),
  );

  server.registerTool(
    "advance_phase",
    {
      title: "Move the exam to its next phase",
      description:
        "Moves the session forward: from the briefing into preparation time, or from preparation into speaking. " +
        "Call this once after start_exam to begin, and again when preparation time is up. " +
        "Read the returned line aloud — it tells the candidate what to do and how long they have. " +
        "Do not call this to end the candidate's answer; use submit_response for that.",
      inputSchema: { sessionId: z.string().describe("From start_exam.") },
    },
    async ({ sessionId }) =>
      run("advance_phase", 50, () => {
        const result = sessions.advance(sessionId);
        return say(result.say, {
          view: result.phase === "prep" ? "cue_card" : "speaking",
          sessionId,
          phase: result.phase,
          secondsRemaining: result.secondsRemaining,
        });
      }),
  );

  server.registerTool(
    "submit_response",
    {
      title: "Record what the candidate said",
      description:
        "Records the candidate's spoken answer and returns the examiner's next follow-up question. " +
        "Call this every time the candidate finishes speaking, passing their words as faithfully as you received them — " +
        "do not summarise, clean up grammar, or correct them, because the transcript is what gets scored. " +
        "Read the returned follow-up aloud. " +
        "A late answer is always accepted; overrun is recorded and scored, never rejected. " +
        "When exhausted is true there are no more questions — call score_session.",
      inputSchema: {
        sessionId: z.string().describe("From start_exam."),
        transcript: z
          .string()
          .min(1)
          .describe("The candidate's words, verbatim and uncorrected."),
      },
    },
    async ({ sessionId, transcript }) =>
      run("submit_response", 150, () => {
        const result = sessions.submitResponse(
          sessionId,
          transcript,
          probes ? (session) => probes.take(session) : undefined,
        );
        // F-5 - fired after the turn is recorded and deliberately not awaited:
        // the answer below never depends on the model (hard rule 3).
        if (probes && !result.exhausted) {
          const item = corpus.byId(result.session.itemId);
          probes.fire(result.session, {
            sessionId,
            exam: result.session.exam,
            locale: result.session.locale,
            part: result.session.part,
            topic: item?.topic ?? "unknown",
            prompt: item?.prompt ?? "",
            transcript,
          });
        }
        const text = result.followUp ?? "Thank you. That is the end of this part.";
        return say(text, {
          view: "speaking",
          sessionId,
          phase: result.phase,
          followUp: result.followUp,
          followUpSource: result.followUpSource,
          exhausted: result.exhausted,
          overrun: result.overrun,
          overrunSeconds: result.overrunSeconds,
          turnCount: result.session.turns.length,
        });
      }),
  );

  server.registerTool(
    "score_session",
    {
      title: "Ask for the candidate's marks",
      description:
        "Starts rubric scoring of the whole exam. Returns immediately — scoring takes longer than a single turn. " +
        "Call this once the follow-up questions are exhausted, or when the candidate asks how they did. " +
        "Tell the candidate you are working out their results, then call get_results after pollAfterMs.",
      inputSchema: { sessionId: z.string().describe("From start_exam.") },
    },
    async ({ sessionId }) =>
      run("score_session", 100, () => {
        const session = sessions.get(sessionId);
        const handle = scorer.start({
          sessionId,
          exam: session.exam,
          locale: session.locale,
          part: session.part,
          turns: session.turns,
          overrunSeconds: session.overrunSeconds,
        });
        sessions.beginScoring(sessionId, handle);
        return say("Let me pull your results together.", {
          view: "scoring",
          sessionId,
          status: "pending",
          pollAfterMs: 1500,
        });
      }),
  );

  server.registerTool(
    "get_results",
    {
      title: "Read back the candidate's marks",
      description:
        "Returns the rubric scores once they are ready. If status is pending, say something brief and call again shortly. " +
        "Read each criterion with its band, the evidence, and the one improvement. " +
        "Pronunciation is deliberately absent — this server receives a transcript, not audio, and cannot judge it. " +
        "Do not invent a pronunciation score or an overall band the tool did not return.",
      inputSchema: { sessionId: z.string().describe("From start_exam.") },
    },
    async ({ sessionId }, extra: ToolExtra) =>
      run("get_results", 100, () => {
        const session = sessions.get(sessionId);
        if (session.scoringHandle === null) {
          return fail(new Error("Scoring has not been started. Call score_session first."));
        }

        const outcome = scorer.poll(session.scoringHandle);

        if (outcome.status === "pending") {
          return say("Still working out the results.", {
            view: "scoring",
            sessionId,
            status: "pending",
            pollAfterMs: outcome.pollAfterMs,
          });
        }

        if (outcome.status === "unavailable") {
          sessions.completeScoring(sessionId);
          return say(outcome.reason, {
            view: "results",
            sessionId,
            status: "unavailable",
            reason: outcome.reason,
          });
        }

        const item = corpus.byId(session.itemId);

        // F-7 · A record with no owner is not a record. Behind requireBearerAuth
        // every call carries a grant subject, so this is defence in depth — but
        // filing the session under a shared fallback key would silently mix two
        // candidates' histories together, which is worse than not filing it.
        // The marks are still read out either way: the candidate asked for their
        // score, not for a lecture about tokens. get_progress is where a missing
        // identity actually matters, and that is where it is said out loud.
        const subject = identify(extra);
        if (subject === null) {
          logger.log({
            event: "warning",
            tool: "get_results",
            sessionId,
            message: "No grant subject on this connection — progress not recorded.",
          });
        } else {
          progress.append({
            owner: subject,
            at: now(),
            exam: session.exam,
            part: session.part,
            topic: item?.topic ?? "unknown",
            scores: outcome.scores,
          });
        }
        sessions.completeScoring(sessionId);

        const spoken = outcome.scores
          .map(
            (s) =>
              `${CRITERION_LABELS[s.criterion]}: ${s.band}. ${s.evidence} To improve: ${s.improvement}`,
          )
          .join(" ");

        return say(
          outcome.status === "partial" ? `${spoken} ${outcome.note}` : spoken,
          {
            view: "results",
            sessionId,
            status: outcome.status,
            scores: outcome.scores.map((s) => ({ ...s, label: CRITERION_LABELS[s.criterion] })),
            pronunciationAssessed: false,
            progressRecorded: subject !== null,
            ...(outcome.status === "partial" ? { note: outcome.note } : {}),
          },
        );
      }),
  );

  server.registerTool(
    "get_progress",
    {
      title: "Look at progress over time",
      description:
        "Summarises the candidate's recent sessions and which criterion has been weakest. " +
        "Call this when the user asks how they are doing overall, whether they are improving, or what to work on next. " +
        "Do not call it mid-exam — it is about history, not the session in progress.",
      inputSchema: {},
    },
    async (_args, extra: ToolExtra) =>
      run("get_progress", 100, () => {
        // Without a subject there is no honest answer: any history we returned
        // would be someone else's. Say so plainly and name the way out, rather
        // than reporting an empty history the candidate has not earned.
        const subject = identify(extra);
        if (subject === null) {
          return say(
            "I can't tell whose practice history this is on this connection. " +
              "Reconnect Viva and ask again.",
            { view: "progress", status: "unidentified" },
          );
        }

        const summary = progress.summarize(subject);
        if (summary.sessionCount === 0) {
          return say("No completed sessions yet. Finish an exam and I can track progress.", {
            view: "progress",
            status: "ok",
            ...summary,
          });
        }
        const text =
          summary.weakest === null
            ? `${summary.sessionCount} sessions so far. Not enough scored data to pick out a weakest area yet.`
            : `${summary.sessionCount} sessions so far. Weakest area: ${summary.weakest.label}, ` +
              `averaging ${summary.weakest.mean.toFixed(1)}` +
              (summary.recurringTopics.length > 0
                ? `, most often on ${summary.recurringTopics.join(" and ")}.`
                : ".");
        return say(text, { view: "progress", status: "ok", ...summary });
      }),
  );
}

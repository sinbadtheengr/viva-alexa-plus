import { randomUUID } from "node:crypto";
import type { Logger } from "../mcp/logging.js";
import { silentLogger } from "../mcp/logging.js";
import type { RubricModel } from "./model.js";
import { buildRetryInstruction, buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { rubricSchemaFor, validateScores } from "./rubric.js";
import { CRITERIA, type ScoreOutcome, type ScoreRequest, type Scorer } from "./types.js";

/**
 * F-6 · Rubric scoring.
 *
 * `start` returns a handle immediately and the model call runs in the
 * background, because a rubric call cannot fit inside the 500ms tool budget
 * (GAP-005). `poll` always answers with whatever is known right now.
 *
 * The honesty rule runs through all of it: a criterion we cannot verify is
 * dropped and reported as missing. We never pad a partial result up to three
 * scores, and a model failure surfaces as `unavailable`, not as a low band.
 */

export interface RubricScorerOptions {
  readonly model: RubricModel;
  readonly logger?: Logger;
  readonly pollAfterMs?: number;
  readonly now?: () => number;
}

interface Job {
  outcome: ScoreOutcome;
  readonly startedAt: number;
}

export class RubricScorer implements Scorer {
  readonly name: string;
  readonly #model: RubricModel;
  readonly #logger: Logger;
  readonly #pollAfterMs: number;
  readonly #now: () => number;
  readonly #jobs = new Map<string, Job>();
  /** Exposed so tests can await the background work deterministically. */
  readonly #running = new Map<string, Promise<void>>();

  constructor(options: RubricScorerOptions) {
    this.#model = options.model;
    this.name = options.model.name;
    this.#logger = options.logger ?? silentLogger;
    this.#pollAfterMs = options.pollAfterMs ?? 2500;
    this.#now = options.now ?? Date.now;
  }

  start(request: ScoreRequest): string {
    const handle = randomUUID();
    this.#jobs.set(handle, {
      outcome: { status: "pending", pollAfterMs: this.#pollAfterMs },
      startedAt: this.#now(),
    });

    // Deliberately not awaited: `start` must return inside the tool budget.
    // `#grade` resolves rather than rejects, so there is no unhandled rejection.
    this.#running.set(handle, this.#grade(handle, request));
    return handle;
  }

  poll(handle: string): ScoreOutcome {
    return (
      this.#jobs.get(handle)?.outcome ?? {
        status: "unavailable",
        reason: "No scoring job with that handle. It may have been started by a previous process.",
      }
    );
  }

  /** Resolves once the job behind `handle` has settled. Test helper. */
  async settled(handle: string): Promise<void> {
    await this.#running.get(handle);
  }

  async #grade(handle: string, request: ScoreRequest): Promise<void> {
    const startedAt = this.#now();
    try {
      const outcome = await this.#attempt(request);
      this.#finish(handle, outcome, startedAt);
    } catch (error) {
      // A model or network failure is not a low score. Say so plainly.
      const message = error instanceof Error ? error.message : String(error);
      this.#finish(
        handle,
        {
          status: "unavailable",
          reason:
            "Scoring could not be completed because the grading service was unreachable. " +
            "Your transcript was recorded in full and can be scored later.",
        },
        startedAt,
        message,
      );
    }
  }

  async #attempt(request: ScoreRequest): Promise<ScoreOutcome> {
    const schema = rubricSchemaFor(request.exam);
    const system = buildSystemPrompt(request);
    const user = buildUserPrompt(request);

    const first = await this.#model.complete({ system, user, schema, effort: "high" });
    const firstCheck = validateScores(request.exam, first);
    if (firstCheck.problems.length === 0) {
      return { status: "complete", scores: firstCheck.valid };
    }

    this.#logger.log({
      event: "rubric_retry",
      sessionId: request.sessionId,
      problems: firstCheck.problems,
    });

    // One retry, restating the contract and raising effort. F-6 originally
    // specified temperature 0 here; Claude Opus 5 rejects `temperature` with a
    // 400, so effort is the equivalent lever. See GAP-012.
    const second = await this.#model.complete({
      system,
      user: `${user}\n\n${buildRetryInstruction(firstCheck.problems)}`,
      schema,
      effort: "max",
    });
    const secondCheck = validateScores(request.exam, second);

    if (secondCheck.problems.length === 0) {
      return { status: "complete", scores: secondCheck.valid };
    }

    // Keep whichever attempt verified more criteria; never merge the two, since
    // a band from one attempt and evidence from another would be a fabrication.
    const best =
      secondCheck.valid.length >= firstCheck.valid.length ? secondCheck : firstCheck;

    if (best.valid.length === 0) {
      return {
        status: "unavailable",
        reason:
          "The grader did not return a usable mark for any criterion, so there is nothing " +
          "reliable to report. Your transcript was recorded in full.",
      };
    }

    const missing = CRITERIA.filter((c) => !best.valid.some((s) => s.criterion === c));
    return {
      status: "partial",
      scores: best.valid,
      note: `I could not reliably mark ${missing.length} of the three criteria, so I have left ${
        missing.length === 1 ? "it" : "them"
      } out rather than guess.`,
    };
  }

  #finish(handle: string, outcome: ScoreOutcome, startedAt: number, error?: string): void {
    const job = this.#jobs.get(handle);
    if (job) job.outcome = outcome;
    this.#logger.log({
      event: "rubric_scored",
      status: outcome.status,
      durationMs: this.#now() - startedAt,
      model: this.name,
      ...(error ? { error } : {}),
    });
  }
}

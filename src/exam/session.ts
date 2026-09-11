import { randomUUID } from "node:crypto";
import { SESSION_IDLE_MS } from "../config.js";
import { PhaseViolationError, UnknownSessionError } from "./errors.js";
import type { Action, Phase } from "./phases.js";
import { isLegal } from "./phases.js";
import type { Exam, ExamItem, Part } from "./schema.js";

/**
 * F-3 · Session state machine.
 *
 * Phase deadlines are computed here from the corpus item and never accepted
 * from a caller — a candidate must not be able to award themselves more time.
 * Nothing in this module performs I/O or calls a model (hard rule 3).
 */

export interface Turn {
  readonly role: "examiner" | "candidate";
  readonly text: string;
  readonly at: number;
  /** True when this turn arrived after the phase deadline had passed. */
  readonly overrun: boolean;
}

export interface Session {
  readonly id: string;
  readonly locale: string;
  readonly exam: Exam;
  readonly part: Part;
  readonly itemId: string;
  phase: Phase;
  /** Epoch ms at which the current phase runs out, or null if it is untimed. */
  phaseDeadline: number | null;
  turns: Turn[];
  /** How many seed probes have been used (F-5 replaces these when Bedrock answers). */
  followUpIndex: number;
  /**
   * Total seconds the candidate ran past a deadline across the session.
   * Scored as evidence under Fluency & Coherence by F-6, never punished here.
   */
  overrunSeconds: number;
  scoringHandle: string | null;
  lastTouchedAt: number;
}

/** Minimal shape the store needs from the corpus — keeps the two decoupled. */
export interface ItemResolver {
  byId(id: string): ExamItem | undefined;
}

export interface SessionStatus {
  readonly sessionId: string;
  readonly phase: Phase;
  /** Whole seconds left in the current phase, or null when the phase is untimed. */
  readonly secondsRemaining: number | null;
  readonly turnCount: number;
  /**
   * True once the current timed phase has run out. A caller may use this to
   * prompt the candidate — nothing in the exam depends on it doing so (GAP-008).
   */
  readonly overrun: boolean;
  readonly overrunSeconds: number;
}

export interface AdvanceResult {
  readonly session: Session;
  readonly phase: Phase;
  readonly secondsRemaining: number | null;
  /** What the examiner should say on entering the new phase. */
  readonly say: string;
}

export interface SubmitResult {
  readonly session: Session;
  readonly phase: Phase;
  /** The next probe, or null once the seeds are exhausted. */
  readonly followUp: string | null;
  /** True when no probes remain and the caller should move to scoring. */
  readonly exhausted: boolean;
  /** True when this turn arrived late. The turn is still accepted in full. */
  readonly overrun: boolean;
  /** How far past the deadline this turn arrived, in whole seconds. */
  readonly overrunSeconds: number;
}

export interface SessionStoreOptions {
  readonly resolver: ItemResolver;
  readonly now?: () => number;
  readonly idleMs?: number;
  readonly newId?: () => string;
}

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #resolver: ItemResolver;
  readonly #now: () => number;
  readonly #idleMs: number;
  readonly #newId: () => string;

  constructor(options: SessionStoreOptions) {
    this.#resolver = options.resolver;
    this.#now = options.now ?? Date.now;
    this.#idleMs = options.idleMs ?? SESSION_IDLE_MS;
    this.#newId = options.newId ?? randomUUID;
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** Opens a session on the given item, in `briefing`. */
  create(item: ExamItem): Session {
    const at = this.#now();
    const session: Session = {
      id: this.#newId(),
      locale: item.locale,
      exam: item.exam,
      part: item.part,
      itemId: item.id,
      phase: "briefing",
      phaseDeadline: null,
      turns: [{ role: "examiner", text: item.prompt, at, overrun: false }],
      followUpIndex: 0,
      overrunSeconds: 0,
      scoringHandle: null,
      lastTouchedAt: at,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  /** Throws if the session is unknown or has gone idle past the limit. */
  get(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new UnknownSessionError(id, "not-found");
    if (this.#now() - session.lastTouchedAt > this.#idleMs) {
      this.#sessions.delete(id);
      throw new UnknownSessionError(id, "expired");
    }
    return session;
  }

  status(id: string): SessionStatus {
    const session = this.get(id);
    const secondsRemaining = this.#secondsRemaining(session);
    return {
      sessionId: session.id,
      phase: session.phase,
      secondsRemaining,
      turnCount: session.turns.length,
      overrun: secondsRemaining === 0,
      overrunSeconds: session.overrunSeconds,
    };
  }

  /** briefing → prep (or straight to speaking when there is no prep time), prep → speaking. */
  advance(id: string): AdvanceResult {
    const session = this.#require(id, "advance_phase");
    const item = this.#item(session);
    const at = this.#now();

    if (session.phase === "briefing" && item.prepSeconds > 0) {
      session.phase = "prep";
      session.phaseDeadline = at + item.prepSeconds * 1000;
    } else {
      session.phase = "speaking";
      session.phaseDeadline = at + item.speakSeconds * 1000;
    }

    session.lastTouchedAt = at;
    return {
      session,
      phase: session.phase,
      secondsRemaining: this.#secondsRemaining(session),
      say:
        session.phase === "prep"
          ? `You have ${item.prepSeconds} seconds to prepare. I'll tell you when to begin.`
          : `Please begin. You have ${item.speakSeconds} seconds.`,
    };
  }

  /**
   * Records the candidate's turn and returns the next probe.
   *
   * The probe comes from `followUpSeeds` so this call never waits on a model
   * (hard rule 3); F-5 swaps in a Bedrock-generated probe on a later turn only
   * if one has already arrived.
   *
   * A late turn is accepted in full and marked `overrun` (GAP-008, option 2).
   * Never reject a turn and never truncate one — running long is scored by F-6
   * as evidence under Fluency & Coherence, not enforced here.
   */
  submitResponse(id: string, transcript: string): SubmitResult {
    const session = this.#require(id, "submit_response");
    const item = this.#item(session);
    const at = this.#now();

    const lateBy =
      session.phaseDeadline === null ? 0 : Math.max(0, Math.ceil((at - session.phaseDeadline) / 1000));
    const overrun = lateBy > 0;
    if (overrun) session.overrunSeconds += lateBy;

    session.turns.push({ role: "candidate", text: transcript, at, overrun });

    const followUp = item.followUpSeeds[session.followUpIndex] ?? null;
    if (followUp !== null) {
      session.followUpIndex += 1;
      session.turns.push({ role: "examiner", text: followUp, at, overrun: false });
    }

    session.phase = "followup";
    session.phaseDeadline = null;
    session.lastTouchedAt = at;

    return {
      session,
      phase: session.phase,
      followUp,
      exhausted: followUp === null,
      overrun,
      overrunSeconds: lateBy,
    };
  }

  /** followup → scoring. The handle is whatever F-6 needs to poll its async job. */
  beginScoring(id: string, handle: string): Session {
    const session = this.#require(id, "score_session");
    session.phase = "scoring";
    session.phaseDeadline = null;
    session.scoringHandle = handle;
    session.lastTouchedAt = this.#now();
    return session;
  }

  /** scoring → complete, once F-6 has results to hand back. */
  completeScoring(id: string): Session {
    const session = this.#require(id, "get_results");
    session.phase = "complete";
    session.phaseDeadline = null;
    session.lastTouchedAt = this.#now();
    return session;
  }

  /** Drops sessions past the idle limit. Returns how many were removed. */
  sweep(): number {
    const cutoff = this.#now() - this.#idleMs;
    let removed = 0;
    for (const [id, session] of this.#sessions) {
      if (session.lastTouchedAt < cutoff) {
        this.#sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  #require(id: string, action: Action): Session {
    const session = this.get(id);
    if (!isLegal(action, session.phase)) {
      throw new PhaseViolationError(action, session.phase);
    }
    return session;
  }

  #item(session: Session): ExamItem {
    const item = this.#resolver.byId(session.itemId);
    if (!item) {
      throw new Error(
        `Session ${session.id} references item ${session.itemId}, which is not in the corpus.`,
      );
    }
    return item;
  }

  #secondsRemaining(session: Session): number | null {
    if (session.phaseDeadline === null) return null;
    return Math.max(0, Math.ceil((session.phaseDeadline - this.#now()) / 1000));
  }
}

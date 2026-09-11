import type { Action, Phase } from "./phases.js";
import { LEGAL_ACTIONS } from "./phases.js";

/**
 * Domain errors. Deliberately transport-agnostic: the MCP layer (F-4) maps
 * these onto protocol errors, so the state machine stays testable on its own.
 */

export class PhaseViolationError extends Error {
  override readonly name = "PhaseViolationError";
  readonly legalActions: readonly Action[];

  constructor(
    readonly action: Action,
    readonly phase: Phase,
  ) {
    const legal = LEGAL_ACTIONS[phase];
    super(
      `Cannot ${action} while the session is in the "${phase}" phase. ` +
        `Legal actions now: ${legal.join(", ")}.`,
    );
    this.legalActions = legal;
  }
}

export class UnknownSessionError extends Error {
  override readonly name = "UnknownSessionError";
  constructor(
    readonly sessionId: string,
    readonly reason: "not-found" | "expired",
  ) {
    super(
      reason === "expired"
        ? `Session ${sessionId} expired after being idle. Start a new exam.`
        : `No session with id ${sessionId}.`,
    );
  }
}

export class CorpusError extends Error {
  override readonly name = "CorpusError";
  constructor(message: string) {
    super(message);
  }
}

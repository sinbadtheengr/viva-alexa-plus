/**
 * F-3 · Phase vocabulary and the legality table.
 *
 * Transitions are server-owned. This module is the single source of truth for
 * what a session may do next, so that error messages and the state machine can
 * never disagree with each other.
 */

export const PHASES = [
  "idle",
  "briefing",
  "prep",
  "speaking",
  "followup",
  "scoring",
  "complete",
] as const;

export type Phase = (typeof PHASES)[number];

export const ACTIONS = [
  "start_exam",
  "get_status",
  "advance_phase",
  "submit_response",
  "score_session",
  "get_results",
  "get_progress",
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * `get_status` is legal in every phase by design — a caller must always be able
 * to ask where it is without risking an error.
 */
export const LEGAL_ACTIONS: Readonly<Record<Phase, readonly Action[]>> = {
  idle: ["start_exam", "get_status"],
  briefing: ["advance_phase", "get_status"],
  prep: ["advance_phase", "get_status"],
  speaking: ["submit_response", "get_status"],
  followup: ["submit_response", "score_session", "get_status"],
  scoring: ["get_results", "get_status"],
  complete: ["get_progress", "get_status"],
};

export function isLegal(action: Action, phase: Phase): boolean {
  return LEGAL_ACTIONS[phase].includes(action);
}

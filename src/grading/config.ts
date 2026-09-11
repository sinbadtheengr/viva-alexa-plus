import type { Logger } from "../mcp/logging.js";
import { BedrockRubricModel, DEFAULT_BEDROCK_MODEL } from "./model.js";
import { RubricScorer } from "./scorer.js";
import { UnavailableScorer, type Scorer } from "./types.js";

/**
 * F-6 · Choosing a grader.
 *
 * Scoring is opt-in. With no region configured the server runs with
 * `UnavailableScorer`, which tells the candidate plainly that no grader is
 * connected — the exam itself still runs end to end (hard rule: the exam must
 * survive the LLM being entirely absent).
 */

export interface ScorerConfig {
  readonly enabled: boolean;
  readonly region: string | undefined;
  readonly model: string;
}

export function loadScorerConfig(env: NodeJS.ProcessEnv = process.env): ScorerConfig {
  const region = env["VIVA_BEDROCK_REGION"] ?? env["AWS_REGION"] ?? undefined;
  return {
    enabled: env["VIVA_SCORING_DISABLED"] !== "1" && region !== undefined,
    region,
    model: env["VIVA_BEDROCK_MODEL"] ?? DEFAULT_BEDROCK_MODEL,
  };
}

export function createScorer(config: ScorerConfig, logger?: Logger): Scorer {
  if (!config.enabled || config.region === undefined) {
    return new UnavailableScorer();
  }
  return new RubricScorer({
    model: new BedrockRubricModel({ region: config.region, model: config.model }),
    ...(logger ? { logger } : {}),
  });
}

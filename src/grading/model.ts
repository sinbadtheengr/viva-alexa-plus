import type { z } from "zod";

/**
 * F-6 · The model port.
 *
 * `RubricScorer` depends on this, not on the Anthropic SDK, so the scoring
 * logic is testable without a network or credentials and the SDK surface stays
 * confined to the adapter below.
 */

export interface RubricRequest {
  readonly system: string;
  readonly user: string;
  readonly schema: z.ZodType;
  /** Raised on the retry — see GAP-012 for why this is not `temperature`. */
  readonly effort: "high" | "max";
}

export interface RubricModel {
  readonly name: string;
  /** Returns the parsed object, or null when the model did not produce one. */
  complete(request: RubricRequest): Promise<unknown | null>;
}

/** Default Bedrock model id. Bedrock ids carry the `anthropic.` prefix. */
export const DEFAULT_BEDROCK_MODEL = "anthropic.claude-opus-5";

export interface BedrockRubricModelOptions {
  readonly region: string;
  readonly model?: string;
  readonly maxTokens?: number;
}

/**
 * Adapter over the Anthropic Bedrock client.
 *
 * Uses `messages.parse` with a structured-output format, so the band enum and
 * the three-criteria shape are enforced by the API rather than by parsing prose
 * on our side.
 *
 * Note on sampling: Claude Opus 5 rejects `temperature` with a 400, so the
 * retry raises `effort` instead. See GAP-012.
 */
export class BedrockRubricModel implements RubricModel {
  readonly name: string;
  readonly #region: string;
  readonly #maxTokens: number;
  #client: unknown;

  constructor(options: BedrockRubricModelOptions) {
    this.name = options.model ?? DEFAULT_BEDROCK_MODEL;
    this.#region = options.region;
    this.#maxTokens = options.maxTokens ?? 4000;
  }

  async complete(request: RubricRequest): Promise<unknown | null> {
    const client = await this.#lazyClient();
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");

    const response = await (
      client as {
        messages: {
          parse(params: Record<string, unknown>): Promise<{ parsed_output?: unknown }>;
        };
      }
    ).messages.parse({
      model: this.name,
      max_tokens: this.#maxTokens,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      output_config: {
        format: zodOutputFormat(request.schema as never),
        effort: request.effort,
      },
    });

    return response.parsed_output ?? null;
  }

  /**
   * Imported on first use so that a server with scoring switched off never
   * loads the AWS client or looks for credentials.
   */
  async #lazyClient(): Promise<unknown> {
    if (this.#client === undefined) {
      const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
      this.#client = new AnthropicBedrockMantle({ awsRegion: this.#region });
    }
    return this.#client;
  }
}

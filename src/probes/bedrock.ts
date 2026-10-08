import { DEFAULT_BEDROCK_MODEL } from "../grading/model.js";
import {
  buildProbePrompt,
  NoopProbeGenerator,
  type ProbeGenerator,
  type ProbeRequest,
} from "./probes.js";

/**
 * F-5 - the Bedrock adapter and its opt-in config.
 *
 * Mirrors src/grading: same Mantle client, same lazy import so a server with
 * no region never loads the AWS client, and no sampling parameters (Opus 5
 * rejects `temperature`, GAP-012). Effort is set low: a probe is one sentence.
 */

export interface ProbeConfig {
  readonly enabled: boolean;
  readonly region: string | undefined;
  readonly model: string;
}

export function loadProbeConfig(env: NodeJS.ProcessEnv = process.env): ProbeConfig {
  const region = env["VIVA_BEDROCK_REGION"] ?? env["AWS_REGION"] ?? undefined;
  return {
    enabled: env["VIVA_PROBES_DISABLED"] !== "1" && region !== undefined,
    region,
    model: env["VIVA_BEDROCK_PROBE_MODEL"] ?? env["VIVA_BEDROCK_MODEL"] ?? DEFAULT_BEDROCK_MODEL,
  };
}

export class BedrockProbeGenerator implements ProbeGenerator {
  readonly enabled = true;
  readonly #region: string;
  readonly #model: string;
  readonly #maxTokens: number;
  #client: unknown;

  constructor(options: { region: string; model?: string; maxTokens?: number }) {
    this.#region = options.region;
    this.#model = options.model ?? DEFAULT_BEDROCK_MODEL;
    this.#maxTokens = options.maxTokens ?? 200;
  }

  async generate(request: ProbeRequest): Promise<string | null> {
    const client = await this.#lazyClient();
    const { system, user } = buildProbePrompt(request);
    const response = await (
      client as {
        messages: {
          create(params: Record<string, unknown>): Promise<{
            content?: { type: string; text?: string }[];
          }>;
        };
      }
    ).messages.create({
      model: this.#model,
      max_tokens: this.#maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low" },
    });
    const block = response.content?.find((b) => b.type === "text");
    return block?.text ?? null;
  }

  /** Imported on first use: with no region the AWS client is never loaded. */
  async #lazyClient(): Promise<unknown> {
    if (this.#client === undefined) {
      const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
      this.#client = new AnthropicBedrockMantle({ awsRegion: this.#region });
    }
    return this.#client;
  }
}

export function createProbeGenerator(config: ProbeConfig): ProbeGenerator {
  if (!config.enabled || config.region === undefined) return new NoopProbeGenerator();
  return new BedrockProbeGenerator({ region: config.region, model: config.model });
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Corpus } from "../src/exam/corpus.js";
import { SessionStore } from "../src/exam/session.js";
import { silentLogger } from "../src/mcp/logging.js";
import { buildServer } from "../src/mcp/server.js";
import { createProbeGenerator, loadProbeConfig } from "../src/probes/bedrock.js";
import {
  NoopProbeGenerator,
  ProbeCoordinator,
  validateProbe,
  type ProbeGenerator,
  type ProbeRequest,
} from "../src/probes/probes.js";
import { fakeClock, item } from "./fixtures.js";

/**
 * F-5 - follow-up probes. No network: every generator here is a fake.
 */

/** A generator whose promise the test settles by hand. */
class DeferredGenerator implements ProbeGenerator {
  readonly enabled = true;
  readonly requests: ProbeRequest[] = [];
  #settle: Array<{ resolve: (v: string | null) => void; reject: (e: unknown) => void }> = [];

  generate(request: ProbeRequest): Promise<string | null> {
    this.requests.push(request);
    return new Promise((resolve, reject) => this.#settle.push({ resolve, reject }));
  }
  resolve(index: number, value: string | null): void {
    this.#settle[index]!.resolve(value);
  }
  reject(index: number, error: unknown): void {
    this.#settle[index]!.reject(error);
  }
}

interface Call {
  text: string;
  sc: Record<string, unknown>;
  isError: boolean;
}

async function harness(generator: ProbeGenerator, seeds?: string[]) {
  const clock = fakeClock();
  const corpus = Corpus.fromItems([item(seeds ? { followUpSeeds: seeds } : {})]);
  const probes = new ProbeCoordinator({ generator, logger: silentLogger });
  const { server } = buildServer({
    corpus,
    sessions: new SessionStore({ resolver: corpus, now: clock.now }),
    logger: silentLogger,
    probes,
    now: clock.now,
    identify: () => "owner",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([client.connect(a), server.connect(b)]);

  const call = async (name: string, args: Record<string, unknown>): Promise<Call> => {
    const r = (await client.callTool({ name, arguments: args })) as unknown as {
      content: { text?: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    return {
      text: r.content.map((c) => c.text ?? "").join(" "),
      sc: r.structuredContent ?? {},
      isError: r.isError === true,
    };
  };

  const start = await call("start_exam", { exam: "ielts", part: 2 });
  const sessionId = start.sc["sessionId"] as string;
  await call("advance_phase", { sessionId });
  await call("advance_phase", { sessionId });
  const submit = (transcript: string) => call("submit_response", { sessionId, transcript });
  return { probes, submit };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const GOOD = "You said the launch was stressful; what made it so?";

afterEach(() => vi.restoreAllMocks());

describe("F-5 - probe replaces the seed on the next turn", () => {
  it("uses a probe that arrived in time, and says it was generated", async () => {
    const gen = new DeferredGenerator();
    const { probes, submit } = await harness(gen);

    const first = await submit("I shipped a launch under pressure.");
    expect(first.text).toBe("Would you do it differently now?");
    expect(first.sc["followUpSource"]).toBe("seed");
    expect(gen.requests[0]?.transcript).toBe("I shipped a launch under pressure.");
    expect(gen.requests[0]?.locale).toBe("en-US");
    expect(gen.requests[0]?.exam).toBe("ielts");

    gen.resolve(0, GOOD);
    await probes.idle();

    const second = await submit("Mostly the deadline.");
    expect(second.text).toBe(GOOD);
    expect(second.sc["followUpSource"]).toBe("generated");
    expect(second.sc["exhausted"]).toBe(false);
  });

  it("discards a probe that arrives after the next turn, and uses the seed", async () => {
    const gen = new DeferredGenerator();
    const { submit } = await harness(gen);

    await submit("First answer.");
    const second = await submit("Second answer."); // probe 0 still pending
    expect(second.text).toBe("Who noticed?");
    expect(second.sc["followUpSource"]).toBe("seed");

    gen.resolve(0, GOOD); // too late
    await flush();
    const third = await submit("Third answer.");
    expect(third.text).not.toBe(GOOD);
    expect(third.sc["exhausted"]).toBe(true);
  });

  it("never lets a late probe leak into a later turn", async () => {
    const gen = new DeferredGenerator();
    const { submit } = await harness(gen, ["s1", "s2", "s3", "s4"]);

    await submit("a");
    await submit("b"); // takes + clears slot 0 (pending), fires probe 1
    gen.resolve(0, GOOD);
    await flush();
    const third = await submit("c"); // probe 1 still pending
    expect(third.text).toBe("s3");
  });

  it("falls back to the seed when the model rejects, with no error surfaced", async () => {
    const gen = new DeferredGenerator();
    const { probes, submit } = await harness(gen);

    await submit("First answer.");
    gen.reject(0, new Error("ThrottlingException"));
    await probes.idle();

    const second = await submit("Second answer.");
    expect(second.isError).toBe(false);
    expect(second.text).toBe("Who noticed?");
    expect(second.sc["followUpSource"]).toBe("seed");
  });

  it("falls back to the seed when generate() throws synchronously", async () => {
    const gen: ProbeGenerator = {
      enabled: true,
      generate: () => {
        throw new Error("boom");
      },
    };
    const { submit } = await harness(gen);
    const first = await submit("x");
    expect(first.isError).toBe(false);
    const second = await submit("y");
    expect(second.text).toBe("Who noticed?");
  });

  it.each([
    ["empty", ""],
    ["two questions", "What happened? Why did it matter?"],
    ["no question mark", "Tell me more about the launch"],
    ["multi-line", "What happened?\nWhy?"],
    ["too long", "Why ".repeat(80) + "?"],
    ["leaks marking", "Your grammar was good, but what happened next?"],
    ["pronunciation", "How is your pronunciation of that word?"],
    ["null", null],
  ])("falls back to the seed on invalid output: %s", async (_name, bad) => {
    const gen = new DeferredGenerator();
    const { probes, submit } = await harness(gen);
    await submit("First answer.");
    gen.resolve(0, bad);
    await probes.idle();
    const second = await submit("Second answer.");
    expect(second.text).toBe("Who noticed?");
    expect(second.sc["followUpSource"]).toBe("seed");
  });

  it("does not fire once the seeds are exhausted", async () => {
    const gen = new DeferredGenerator();
    const { submit } = await harness(gen, ["only one"]);
    await submit("a"); // seed 1, fires
    await submit("b"); // exhausted
    expect(gen.requests).toHaveLength(1);
  });

  it("never awaits the model: submit_response returns while generate() never settles", async () => {
    const gen: ProbeGenerator = { enabled: true, generate: () => new Promise(() => {}) };
    const { submit } = await harness(gen);
    const started = performance.now();
    const result = await Promise.race([
      submit("hello"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("submit_response blocked on the model")), 1000),
      ),
    ]);
    expect(result.text).toBe("Would you do it differently now?");
    expect(performance.now() - started).toBeLessThan(150);
  });

  it("keeps the corpus seeds only when the generator is the no-op", async () => {
    const generate = vi.spyOn(NoopProbeGenerator.prototype, "generate");
    const { submit } = await harness(new NoopProbeGenerator());
    const first = await submit("a");
    expect(first.sc["followUpSource"]).toBe("seed");
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("F-5 - opt-in config", () => {
  it("returns the no-op and never constructs the AWS client without a region", async () => {
    const ctor = vi.fn();
    vi.resetModules();
    vi.doMock("@anthropic-ai/bedrock-sdk", () => ({ AnthropicBedrockMantle: ctor }));
    const { createProbeGenerator: create, loadProbeConfig: load } = await import(
      "../src/probes/bedrock.js"
    );
    const generator = create(load({}));
    expect(generator.enabled).toBe(false);
    expect(await generator.generate({} as ProbeRequest)).toBeNull();
    expect(ctor).not.toHaveBeenCalled();
    vi.doUnmock("@anthropic-ai/bedrock-sdk");
  });

  it("is enabled by a region, disabled by VIVA_PROBES_DISABLED, and uses the anthropic. model id", () => {
    const on = loadProbeConfig({ VIVA_BEDROCK_REGION: "us-east-1" });
    expect(on.enabled).toBe(true);
    expect(on.model).toBe("anthropic.claude-opus-5");
    expect(createProbeGenerator(on).enabled).toBe(true);

    const off = loadProbeConfig({ VIVA_BEDROCK_REGION: "us-east-1", VIVA_PROBES_DISABLED: "1" });
    expect(createProbeGenerator(off).enabled).toBe(false);
  });
});

describe("F-5 - validateProbe", () => {
  it("accepts one short question and strips wrapping quotes", () => {
    expect(validateProbe(`  "${GOOD}"  `)).toBe(GOOD);
    expect(validateProbe("Qu'est-ce qui a rendu ce projet si difficile ?")).toBe(
      "Qu'est-ce qui a rendu ce projet si difficile ?",
    );
  });
  it("rejects non-strings", () => {
    expect(validateProbe(undefined)).toBeNull();
    expect(validateProbe(42)).toBeNull();
  });
});

import { createServer as createNetServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { createApp } from "../app.js";
import { loadAuthConfig, type AuthConfig } from "../auth/config.js";
import { Corpus } from "../exam/corpus.js";
import type { ExamItem } from "../exam/schema.js";
import type { Scorer, ScoreOutcome } from "../grading/types.js";
import { createLogger } from "../mcp/logging.js";
import { ProbeCoordinator, type ProbeGenerator } from "../probes/probes.js";
import { summarize, type Stats } from "./stats.js";

/**
 * A8 · Latency benchmark.
 *
 * Boots the real app (real OAuth router, real bearer middleware, real Streamable
 * HTTP transport) on a loopback port, signs in with the real OAuth 2.1 + PKCE
 * flow, and drives complete exams over HTTP. Only the model-facing collaborators
 * are fakes: a scorer that takes seconds to "think", and a probe generator that
 * never answers. That is the point: it measures this server, not Bedrock.
 */

/** F-4 budgets (CLAUDE.md). The server's own log carries budgetMs; we cross-check it. */
export const BUDGETS_MS = {
  start_exam: 100,
  get_status: 50,
  submit_response: 150,
  advance_phase: 50,
  score_session: 100,
  get_results: 100,
  get_progress: 100,
} as const;
export type ToolName = keyof typeof BUDGETS_MS;

/** The overall voice round-trip target (GAP-005). */
export const OVERALL_TARGET_MS = 500;

export interface BenchOptions {
  /** Complete exams per scenario (and so samples per once-per-exam tool). */
  readonly iterations: number;
  /** Unrecorded exams run first so JIT and connection setup are not in the numbers. */
  readonly warmup: number;
  /** submit_response turns per exam. */
  readonly turns: number;
  /** How long the fake scorer takes to "finish". */
  readonly scorerDelayMs: number;
  readonly log?: (message: string) => void;
}

export const DEFAULT_OPTIONS: BenchOptions = {
  iterations: 200,
  warmup: 10,
  turns: 5,
  scorerDelayMs: 3000,
};

export interface RowResult {
  readonly label: string;
  readonly tool: ToolName;
  readonly budgetMs: number;
  /** HTTP round trip as the client sees it. */
  readonly client: Stats;
  /** The server's own per-tool duration (F-1 log). */
  readonly server: Stats;
  /** Calls the server itself flagged overBudget. */
  readonly serverOverBudget: number;
  readonly pass: boolean;
}

export interface ScenarioResult {
  readonly name: string;
  readonly description: string;
  readonly rows: readonly RowResult[];
  readonly initializeMs: number;
  /** Server-side time for the whole /mcp POST handler (F-1 "http" log lines). */
  readonly httpHandler: Stats;
  /** Sessions in the progress history when get_progress was measured. */
  readonly progressSessions: number;
  readonly followUpSources: Readonly<Record<string, number>>;
}

export interface Machine {
  readonly os: string;
  readonly arch: string;
  readonly cpu: string;
  readonly cores: number;
  readonly memoryGiB: number;
  readonly node: string;
}

export interface BenchResult {
  readonly startedAt: string;
  readonly options: BenchOptions;
  readonly machine: Machine;
  readonly scenarios: readonly ScenarioResult[];
  /** Largest single client round trip seen anywhere, against the 500ms target. */
  readonly worstClientMs: number;
  readonly passed: boolean;
}

export function describeMachine(): Machine {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()} (${os.version()})`,
    arch: os.arch(),
    cpu: (cpus[0]?.model ?? "unknown").trim(),
    cores: cpus.length,
    memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    node: process.version,
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A grader whose "model" takes `delayMs`. start() returns at once, as the Scorer
 * contract requires; the job completes on a timer. If score_session were to wait
 * for it, its latency would be ~delayMs and the budget check would fail.
 */
export class SlowFakeScorer implements Scorer {
  readonly name = "bench-slow-fake";
  readonly #done = new Set<string>();
  #n = 0;
  constructor(readonly delayMs: number) {}

  start(): string {
    const handle = `bench-${++this.#n}`;
    const timer = setTimeout(() => {
      this.#done.add(handle);
    }, this.delayMs);
    timer.unref();
    return handle;
  }

  poll(handle: string): ScoreOutcome {
    if (!this.#done.has(handle)) return { status: "pending", pollAfterMs: 1500 };
    return {
      status: "complete",
      scores: [
        {
          criterion: "fluency_coherence",
          band: "6",
          evidence: "\"I would say that it was\" shows steady delivery.",
          improvement: "Link ideas with fewer fillers.",
        },
        {
          criterion: "lexical_resource",
          band: "7",
          evidence: "\"deadline\" and \"stakeholders\" were used precisely.",
          improvement: "Try more idiomatic collocations.",
        },
        {
          criterion: "grammatical_range_accuracy",
          band: "6",
          evidence: "Mixed simple and complex clauses with minor slips.",
          improvement: "Vary conditionals.",
        },
      ],
    };
  }

  /** Resolves once every job started so far has finished. */
  async drain(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.delayMs + 50));
  }
}

/** A "model" that never answers. submit_response must not care. */
export const neverResolvingGenerator: ProbeGenerator = {
  enabled: true,
  generate: () => new Promise<string | null>(() => {}),
};

// ---------------------------------------------------------------------------
// Protocol plumbing: reuse the demo client's own helpers (src/ui/public/lib.js)
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: unknown;
}
interface ToolOutcomeShape {
  readonly text: string;
  readonly data: Record<string, unknown>;
  readonly isError: boolean;
}
interface Lib {
  randomToken(bytes?: number): string;
  codeChallengeS256(verifier: string): Promise<string>;
  buildAuthorizeUrl(a: Record<string, string>): string;
  buildTokenRequestBody(a: Record<string, string>): string;
  parseAuthorizationResponse(search: string, state: string): { kind: string; code?: string; error?: string };
  initializeRequest(id: number, info: { name: string; version: string }): object;
  jsonRpcNotification(method: string): object;
  toolCallRequest(id: number, name: string, args?: object): object;
  mcpHeaders(a: { token?: string | null; sessionId?: string | null }): Record<string, string>;
  parseResponseBody(contentType: string | null, text: string): JsonRpcMessage[];
  responseFor(messages: JsonRpcMessage[], id: number): unknown;
  toolOutcome(result: unknown): ToolOutcomeShape;
}

/**
 * lib.js is plain browser JS, outside tsc's rootDir, so it is loaded at runtime
 * by URL. Both src/bench/ and dist/bench/ sit two levels below the repo root.
 */
async function loadLib(): Promise<Lib> {
  const url = new URL("../../src/ui/public/lib.js", import.meta.url).href;
  return (await import(/* @vite-ignore */ url)) as Lib;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const PASSCODE = "bench-passcode";
const CLIENT_ID = "viva-bench";

function benchAuth(origin: string): AuthConfig {
  return loadAuthConfig({
    VIVA_ISSUER_URL: origin,
    VIVA_RESOURCE_URL: `${origin}/mcp`,
    VIVA_DEMO_PASSCODE: PASSCODE,
    VIVA_OAUTH_CLIENTS: JSON.stringify([
      { client_id: CLIENT_ID, client_name: "Viva bench", redirect_uris: [`${origin}/bench/`] },
    ]),
  } as NodeJS.ProcessEnv);
}

/** The real authorization-code + PKCE (S256) flow, as the demo client performs it. */
async function signIn(L: Lib, origin: string, auth: AuthConfig): Promise<string> {
  const redirectUri = `${origin}/bench/`;
  const meta = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    code_challenge_methods_supported?: string[];
  };
  if (!meta.code_challenge_methods_supported?.includes("S256")) throw new Error("server does not advertise S256");

  const verifier = L.randomToken(32);
  const challenge = await L.codeChallengeS256(verifier);
  const state = L.randomToken(16);
  const authorize = await fetch(
    L.buildAuthorizeUrl({
      authorizationEndpoint: meta.authorization_endpoint,
      clientId: CLIENT_ID,
      redirectUri,
      challenge,
      state,
      resource: auth.resourceUrl.href,
      scope: "exam progress",
    }),
    { redirect: "manual" },
  );
  if (authorize.status !== 302) throw new Error(`authorize returned ${authorize.status}`);
  const rid = new URL(authorize.headers.get("location") ?? "", origin).searchParams.get("rid");
  if (!rid) throw new Error("authorize did not hand back a consent request id");

  const consent = await fetch(`${origin}/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ rid, passcode: PASSCODE, action: "approve" }),
  });
  const back = new URL(consent.headers.get("location") ?? "");
  const parsed = L.parseAuthorizationResponse(back.search, state);
  if (parsed.kind !== "code" || !parsed.code) throw new Error(`consent failed: ${JSON.stringify(parsed)}`);

  const tokenRes = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: L.buildTokenRequestBody({
      code: parsed.code,
      clientId: CLIENT_ID,
      redirectUri,
      verifier,
      resource: auth.resourceUrl.href,
    }),
  });
  if (tokenRes.status !== 200) throw new Error(`token endpoint returned ${tokenRes.status}`);
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

// ---------------------------------------------------------------------------
// One scenario
// ---------------------------------------------------------------------------

interface Series {
  readonly tool: ToolName;
  readonly client: number[];
  readonly server: number[];
  serverOverBudget: number;
}

interface ServerToolLine {
  readonly tool: string;
  readonly durationMs: number;
  readonly budgetMs: number;
  readonly overBudget: boolean;
}

const TRANSCRIPT =
  "Well, I would like to talk about a project I led last year at work. We had to migrate our " +
  "customer records to a new system before the end of the quarter, and honestly it was quite " +
  "stressful because the deadline kept moving. I organised the team, split the work into small " +
  "pieces, and we managed to finish two days early, which I was really proud of.";

function benchItem(turns: number): ExamItem {
  return {
    id: "ielts.p2.bench.001",
    exam: "ielts",
    locale: "en-US",
    part: 2,
    topic: "bench",
    prompt: "Describe a piece of work you were proud of.",
    bullets: ["what it was", "why it mattered", "how you felt afterwards"],
    prepSeconds: 60,
    speakSeconds: 120,
    // One more seed than turns, so no turn in the benchmark is the "exhausted" one.
    followUpSeeds: Array.from({ length: turns + 1 }, (_, i) => `Bench follow-up question number ${i + 1}?`),
  } as ExamItem;
}

interface ScenarioSpec {
  readonly name: string;
  readonly description: string;
  readonly probes?: ProbeCoordinator;
  /** Every submit_response follow-up must come from a seed, never from a model. */
  readonly expectSeeds: boolean;
}

async function runScenario(L: Lib, spec: ScenarioSpec, options: BenchOptions): Promise<ScenarioResult> {
  const log = options.log ?? (() => {});
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const auth = benchAuth(origin);

  let recording = false;
  let lastTool: ServerToolLine | null = null;
  const httpMs: number[] = [];
  const logger = createLogger((line) => {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry["event"] === "tool") lastTool = entry as unknown as ServerToolLine;
    else if (entry["event"] === "http" && recording && entry["method"] === "POST") {
      httpMs.push(entry["durationMs"] as number);
    }
  });

  const scorer = new SlowFakeScorer(options.scorerDelayMs);
  const built = await createApp({
    corpus: Corpus.fromItems([benchItem(options.turns)]),
    auth,
    logger,
    scorer,
    ...(spec.probes ? { probes: spec.probes } : {}),
  });
  const server: Server = built.app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));

  try {
    const token = await signIn(L, origin, auth);

    let nextId = 1;
    let sessionId: string | null = null;
    const post = async (body: object, id?: number) => {
      const started = performance.now();
      const res = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: L.mcpHeaders({ token, sessionId }),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const ms = performance.now() - started;
      const messages = id === undefined ? [] : L.parseResponseBody(res.headers.get("content-type"), text);
      return { res, ms, messages };
    };

    const initId = nextId++;
    const init = await post(L.initializeRequest(initId, { name: "viva-bench", version: "0" }), initId);
    L.responseFor(init.messages, initId);
    sessionId = init.res.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("initialize returned no Mcp-Session-Id");
    const initialized = await post(L.jsonRpcNotification("notifications/initialized"));
    if (initialized.res.status !== 202) throw new Error(`initialized notification returned ${initialized.res.status}`);

    const series = new Map<string, Series>();
    const sources: Record<string, number> = {};

    const call = async (tool: ToolName, args: object, label: string, record: boolean): Promise<ToolOutcomeShape> => {
      const id = nextId++;
      lastTool = null;
      recording = record;
      const { ms, messages } = await post(L.toolCallRequest(id, tool, args), id);
      const outcome = L.toolOutcome(L.responseFor(messages, id));
      if (outcome.isError) throw new Error(`${tool} returned a tool error: ${outcome.text}`);
      const srv = lastTool as ServerToolLine | null;
      if (!srv || srv.tool !== tool) throw new Error(`no server timing line for ${tool}`);
      if (srv.budgetMs !== BUDGETS_MS[tool]) {
        throw new Error(`budget drift: server says ${tool} is ${srv.budgetMs}ms, F-4 table says ${BUDGETS_MS[tool]}ms`);
      }
      if (record) {
        let s = series.get(label);
        if (!s) series.set(label, (s = { tool, client: [], server: [], serverOverBudget: 0 }));
        s.client.push(ms);
        s.server.push(srv.durationMs);
        if (srv.overBudget) s.serverOverBudget += 1;
      }
      return outcome;
    };

    const pending: { sessionId: string; record: boolean }[] = [];
    const total = options.warmup + options.iterations;

    // Phase A: whole exams, back to back.
    for (let i = 0; i < total; i++) {
      const record = i >= options.warmup;
      const started = await call("start_exam", { exam: "ielts", part: 2, locale: "en-US" }, "start_exam", record);
      const sid = String(started.data["sessionId"]);
      await call("get_status", { sessionId: sid }, "get_status", record);
      await call("advance_phase", { sessionId: sid }, "advance_phase", record); // briefing -> prep
      await call("get_status", { sessionId: sid }, "get_status", record);
      await call("advance_phase", { sessionId: sid }, "advance_phase", record); // prep -> speaking
      for (let t = 0; t < options.turns; t++) {
        const turn = await call("submit_response", { sessionId: sid, transcript: TRANSCRIPT }, "submit_response", record);
        const source = String(turn.data["followUpSource"]);
        if (record) sources[source] = (sources[source] ?? 0) + 1;
        if (spec.expectSeeds && source !== "seed") throw new Error(`expected a seed follow-up, got ${source}`);
        if (turn.data["exhausted"] === true) throw new Error("exam exhausted early; benchmark turns exceed seeds");
      }
      const scoring = await call("score_session", { sessionId: sid }, "score_session", record);
      if (scoring.data["status"] !== "pending") throw new Error("score_session did not return pending");
      const early = await call("get_results", { sessionId: sid }, "get_results (pending)", record);
      if (early.data["status"] !== "pending") {
        throw new Error("get_results was not pending while the fake model was still working");
      }
      pending.push({ sessionId: sid, record });
      if ((i + 1) % 50 === 0) log(`  ${spec.name}: ${i + 1}/${total} exams`);
    }

    // Phase B: the fake model has had time to finish; read every result back.
    log(`  ${spec.name}: waiting ${options.scorerDelayMs}ms for the simulated model to finish`);
    await scorer.drain();
    for (const p of pending) {
      const done = await call("get_results", { sessionId: p.sessionId }, "get_results (complete)", p.record);
      if (done.data["status"] !== "complete") {
        throw new Error(`expected complete results, got ${String(done.data["status"])}`);
      }
      if (done.data["progressRecorded"] !== true) throw new Error("progress was not recorded");
    }

    // Phase C: progress, with the whole history now on file.
    let progressSessions = 0;
    for (let i = 0; i < options.iterations; i++) {
      const progress = await call("get_progress", {}, "get_progress", true);
      progressSessions = Number(progress.data["sessionCount"] ?? 0);
    }

    const order = [
      "start_exam",
      "get_status",
      "advance_phase",
      "submit_response",
      "score_session",
      "get_results (pending)",
      "get_results (complete)",
      "get_progress",
    ];
    const rows: RowResult[] = order.map((label) => {
      const s = series.get(label);
      if (!s) throw new Error(`no samples for ${label}`);
      const budgetMs = BUDGETS_MS[s.tool];
      const client = summarize(s.client);
      return {
        label,
        tool: s.tool,
        budgetMs,
        client,
        server: summarize(s.server),
        serverOverBudget: s.serverOverBudget,
        pass: client.p95 <= budgetMs,
      };
    });

    return {
      name: spec.name,
      description: spec.description,
      rows,
      initializeMs: init.ms,
      httpHandler: summarize(httpMs),
      progressSessions,
      followUpSources: sources,
    };
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    await built.close();
  }
}

// ---------------------------------------------------------------------------
// The whole benchmark
// ---------------------------------------------------------------------------

export async function runBenchmark(partial: Partial<BenchOptions> = {}): Promise<BenchResult> {
  const options: BenchOptions = { ...DEFAULT_OPTIONS, ...partial };
  const L = await loadLib();
  const startedAt = new Date().toISOString();

  const scenarios: ScenarioResult[] = [];
  options.log?.("Scenario: baseline (seed follow-ups, slow fake scorer)");
  scenarios.push(
    await runScenario(
      L,
      {
        name: "baseline",
        description: `Probes off (seed follow-ups only); fake scorer takes ${options.scorerDelayMs}ms to finish.`,
        expectSeeds: true,
      },
      options,
    ),
  );

  options.log?.("Scenario: hung-probe (probe generator never resolves)");
  scenarios.push(
    await runScenario(
      L,
      {
        name: "hung-probe",
        description:
          "Follow-up probes ENABLED with a generator whose promise never resolves, plus the same slow fake scorer. " +
          "Every submit_response fires a probe call that hangs forever; none may delay a turn, and every follow-up must still be a seed.",
        probes: new ProbeCoordinator({ generator: neverResolvingGenerator }),
        expectSeeds: true,
      },
      options,
    ),
  );

  const rows = scenarios.flatMap((s) => s.rows);
  return {
    startedAt,
    options,
    machine: describeMachine(),
    scenarios,
    worstClientMs: Math.max(...rows.map((r) => r.client.max)),
    passed: rows.every((r) => r.pass),
  };
}

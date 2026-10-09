import type { BenchResult, ScenarioResult } from "./harness.js";
import { OVERALL_TARGET_MS } from "./harness.js";

const f = (ms: number): string => (Number.isFinite(ms) ? ms.toFixed(2) : "n/a");

function table(s: ScenarioResult): string {
  const lines = [
    "| Tool | n | min | p50 | p95 | p99 | max | Budget | Server p50 | Server p95 | Result |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const r of s.rows) {
    lines.push(
      `| ${r.label} | ${r.client.n} | ${f(r.client.min)} | ${f(r.client.p50)} | ${f(r.client.p95)} | ` +
        `${f(r.client.p99)} | ${f(r.client.max)} | ${r.budgetMs} | ${f(r.server.p50)} | ${f(r.server.p95)} | ` +
        `${r.pass ? "PASS" : "FAIL"} |`,
    );
  }
  return lines.join("\n");
}

/** Markdown for stdout and docs/latency.md. Times are milliseconds. */
export function renderMarkdown(result: BenchResult): string {
  const { options: o, machine: m } = result;
  const out: string[] = [];
  out.push("# Viva latency evidence (A8)");
  out.push("");
  out.push(`- **Date:** ${result.startedAt}`);
  out.push(`- **Machine:** ${m.os}, ${m.arch}; ${m.cpu} (${m.cores} logical cores); ${m.memoryGiB} GiB RAM`);
  out.push(`- **Runtime:** Node ${m.node}`);
  out.push(
    `- **Run:** ${o.iterations} recorded exams per scenario after ${o.warmup} unrecorded warm-up exams; ` +
      `${o.turns} submit_response turns per exam; simulated model latency ${o.scorerDelayMs}ms. ` +
      "Refresh this file with `npm run bench:report` (200 exams); a plain `npm run bench` writes to untracked bench-output/latency.md instead (`BENCH_ITERATIONS`, `BENCH_WARMUP`, `BENCH_TURNS`, `BENCH_SCORER_DELAY_MS`).",
  );
  out.push(
    `- **Verdict:** ${result.passed ? "PASS" : "FAIL"}. The gate is client-observed p95 <= the F-4 budget for every row in every scenario.`,
  );
  out.push("");
  out.push(
    "**Read this first.** This is a local-loopback run with fakes: the app, OAuth 2.1 + PKCE flow, bearer middleware " +
      "and Streamable HTTP transport are the real ones, but the grader and the follow-up probe generator are fakes " +
      "(no Bedrock), and there is no Alexa+ and no network between client and server. It proves **server-side budget " +
      "compliance** (what this process costs per call). It does **not** prove end-to-end Alexa+ latency, which adds " +
      "the Internet path, TLS, Alexa+'s own orchestration, speech recognition and synthesis.",
  );
  out.push("");
  out.push(
    "All times in milliseconds. Client columns are the full HTTP round trip (request sent to response body fully read) " +
      "from a Node `fetch` client over a keep-alive loopback connection. *Server* columns are the server's own per-tool " +
      'duration from its F-1 log (`event:"tool"`), i.e. the handler only; the gap between the two is transport, ' +
      "JSON-RPC/SSE framing, auth and HTTP. Percentiles are nearest-rank.",
  );
  for (const s of result.scenarios) {
    out.push("");
    out.push(`## Scenario: ${s.name}`);
    out.push("");
    out.push(s.description);
    out.push("");
    out.push(table(s));
    out.push("");
    const over = s.rows.reduce((a, r) => a + r.serverOverBudget, 0);
    out.push(
      `Server-side \`/mcp\` POST handler time (all calls): p50 ${f(s.httpHandler.p50)}, p95 ${f(s.httpHandler.p95)}, ` +
        `max ${f(s.httpHandler.max)} (n=${s.httpHandler.n}). ` +
        `\`initialize\`: ${f(s.initializeMs)} ms (one-off, includes session setup). ` +
        `Calls the server itself logged as \`overBudget\`: ${over}. ` +
        `get_progress was read with ${s.progressSessions} sessions on file. ` +
        `Follow-up sources: ${Object.entries(s.followUpSources)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}.`,
    );
  }
  out.push("");
  out.push("## What the rows show");
  out.push("");
  out.push(
    `- **score_session** returns while the simulated model (${o.scorerDelayMs}ms) is still working; \`get_results (pending)\` ` +
      "is read immediately afterwards and is pending, and `get_results (complete)` is read after the model has finished " +
      "(this is the call that files progress). Neither waits on the model.",
  );
  out.push(
    "- **hung-probe** fires a probe call that never resolves on every turn. `submit_response` stays within budget and " +
      "every follow-up it returned was a corpus seed (asserted during the run; a mismatch aborts it).",
  );
  out.push(
    `- Worst single client round trip anywhere in this run: ${f(result.worstClientMs)} ms, against the overall ${OVERALL_TARGET_MS}ms target.`,
  );
  out.push("");
  out.push("## Caveats");
  out.push("");
  out.push("- Loopback only; real deployments add network RTT and TLS on top of every number above.");
  out.push("- The corpus is a single synthetic item sized like the real ones, so corpus lookup cost is not exercised at scale.");
  out.push(
    "- The log sink here is an in-memory function; production writes the same JSON lines to stderr, which costs a little more per call.",
  );
  out.push(
    "- Progress is the in-memory store. The JSON-file store adds a disk write to `get_results (complete)`, which this run does not measure.",
  );
  out.push("- Calls are sequential (one candidate, one session), which matches a voice conversation. Concurrency is not measured.");
  out.push("- The first exams are discarded as warm-up, so cold-start cost (first request after boot) is not in the table.");
  out.push("- Each scenario boots its own app instance so the two runs stay independent; the server itself now supports many concurrent MCP sessions (GAP-015, closed), which this benchmark does not exercise.");
  out.push("");
  return out.join("\n");
}

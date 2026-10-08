import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark } from "./harness.js";
import { renderMarkdown } from "./report.js";

/** `npm run bench`. Exit 0 = every p95 within budget, 1 = a budget was missed, 2 = the harness itself failed. */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

async function main(): Promise<number> {
  const iterations = num("BENCH_ITERATIONS", 200);
  if (iterations < 1) throw new Error("BENCH_ITERATIONS must be at least 1");
  const result = await runBenchmark({
    iterations,
    warmup: num("BENCH_WARMUP", 10),
    turns: num("BENCH_TURNS", 5),
    scorerDelayMs: num("BENCH_SCORER_DELAY_MS", 3000),
    log: (m) => process.stderr.write(m + "\n"),
  });

  const markdown = renderMarkdown(result);
  process.stdout.write(markdown + "\n");

  // BENCH_OUT=- skips the file (useful for quick local runs).
  const out = process.env["BENCH_OUT"] ?? fileURLToPath(new URL("../../docs/latency.md", import.meta.url));
  if (out !== "-") {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, markdown, "utf8");
    process.stderr.write(`Wrote ${out}\n`);
  }
  return result.passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`bench failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(2);
  },
);

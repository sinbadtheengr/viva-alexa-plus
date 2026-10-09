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
  // `--report` (npm run bench:report) is the only way to refresh the committed docs/latency.md:
  // it pins the full 200-iteration run so a short run can never overwrite the published numbers.
  const report = process.argv.includes("--report");
  const iterations = report ? 200 : num("BENCH_ITERATIONS", 200);
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

  // Default output is an untracked path (bench-output/ is gitignored). BENCH_OUT overrides it;
  // BENCH_OUT=- skips the file. --report writes the tracked docs/latency.md.
  const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
  const out = report ? (process.env["BENCH_OUT"] ?? root("docs/latency.md")) : (process.env["BENCH_OUT"] ?? root("bench-output/latency.md"));
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

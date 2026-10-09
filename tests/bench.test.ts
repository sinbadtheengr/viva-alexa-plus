import { describe, expect, it } from "vitest";
import { percentile, summarize } from "../src/bench/stats.js";
import { runBenchmark } from "../src/bench/harness.js";
import { renderMarkdown } from "../src/bench/report.js";

describe("bench stats", () => {
  it("uses nearest-rank percentiles and only returns observed values", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
    expect(percentile([5], 99)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 75)).toBe(3);
  });

  it("summarises unsorted samples without mutating them", () => {
    const samples = [9, 1, 5, 3, 7];
    const s = summarize(samples);
    expect(samples).toEqual([9, 1, 5, 3, 7]);
    expect(s).toMatchObject({ n: 5, min: 1, p50: 5, p95: 9, p99: 9, max: 9, mean: 5 });
  });

  it("is NaN, not zero, for no samples, and rejects a bad percentile", () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.p95).toBeNaN();
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
});

describe("bench harness", () => {
  it("runs end to end over real OAuth + HTTP with a tiny N", async () => {
    const result = await runBenchmark({ iterations: 3, warmup: 1, turns: 2, scorerDelayMs: 60 });

    expect(result.scenarios.map((s) => s.name)).toEqual(["baseline", "hung-probe"]);
    for (const s of result.scenarios) {
      const byLabel = Object.fromEntries(s.rows.map((r) => [r.label, r]));
      expect(byLabel["start_exam"]?.client.n).toBe(3);
      expect(byLabel["get_status"]?.client.n).toBe(6);
      expect(byLabel["advance_phase"]?.client.n).toBe(6);
      expect(byLabel["submit_response"]?.client.n).toBe(6);
      expect(byLabel["get_results (complete)"]?.client.n).toBe(3);
      expect(byLabel["get_progress"]?.client.n).toBe(3);
      // The server's own timing line was captured for every sample.
      for (const r of s.rows) expect(r.server.n).toBe(r.client.n);
      // 1 warm-up + 3 recorded sessions were filed.
      expect(s.progressSessions).toBe(4);
      expect(s.followUpSources).toEqual({ seed: 6 });
    }

    const md = renderMarkdown(result);
    expect(md).toContain("| submit_response |");
    expect(md).toContain("loopback");
  }, 30_000);
});

/**
 * A8 · Latency statistics.
 *
 * Nearest-rank percentiles: the p-th percentile is the smallest sample such that
 * at least p% of samples are <= it. It always returns a value that was actually
 * observed, which is what you want when defending a budget ("the 95th slowest of
 * 100 calls took X"), and it never interpolates a number nobody measured.
 */

export interface Stats {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

/** `p` in (0, 100]. `sorted` must be ascending. Returns NaN for no samples. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export function summarize(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n,
    min: n ? (sorted[0] as number) : Number.NaN,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: n ? (sorted[n - 1] as number) : Number.NaN,
    mean: n ? sum / n : Number.NaN,
  };
}

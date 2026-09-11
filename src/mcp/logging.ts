/**
 * F-1 · Structured request logging.
 *
 * One JSON object per line on stderr. Per-tool duration is the point: the 500ms
 * round-trip budget (GAP-005) can only be defended with numbers, and a budget
 * breach should be visible in the log without anyone going looking for it.
 */

export interface LogFields {
  readonly event: string;
  readonly tool?: string;
  readonly sessionId?: string;
  readonly durationMs?: number;
  readonly ok?: boolean;
  readonly error?: string;
  readonly budgetMs?: number;
  readonly overBudget?: boolean;
  readonly [key: string]: unknown;
}

export type Sink = (line: string) => void;

export interface Logger {
  log(fields: LogFields): void;
  /** Times `fn`, logs it against `budgetMs`, and re-throws whatever it throws. */
  timed<T>(tool: string, budgetMs: number, fn: () => T): T;
}

export function createLogger(sink: Sink = (line) => process.stderr.write(line + "\n")): Logger {
  const log = (fields: LogFields): void => {
    sink(JSON.stringify({ at: new Date().toISOString(), ...fields }));
  };

  return {
    log,
    timed<T>(tool: string, budgetMs: number, fn: () => T): T {
      const started = process.hrtime.bigint();
      const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1e6;
      try {
        const result = fn();
        const durationMs = elapsed();
        log({
          event: "tool",
          tool,
          durationMs: round(durationMs),
          budgetMs,
          overBudget: durationMs > budgetMs,
          ok: true,
        });
        return result;
      } catch (error) {
        const durationMs = elapsed();
        log({
          event: "tool",
          tool,
          durationMs: round(durationMs),
          budgetMs,
          overBudget: durationMs > budgetMs,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** Discards everything. For tests. */
export const silentLogger: Logger = createLogger(() => {});

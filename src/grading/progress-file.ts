import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { CRITERIA } from "./types.js";
import {
  assertAttributed,
  summarizeRecords,
  type ProgressRecord,
  type ProgressStore,
  type ProgressSummary,
} from "./progress.js";

/**
 * F-7 · JSON-file progress store.
 *
 * Durability rules:
 *  - Writes are atomic: the full document goes to a temp file in the same
 *    directory, is fsynced, then renamed over the target. A crash leaves either
 *    the old file or the new one, never a torn one.
 *  - A missing file is an empty history. A file that exists but cannot be parsed
 *    or validated is NEVER overwritten and never silently ignored: the store
 *    throws `ProgressFileCorruptError` and the server refuses to start. The
 *    history is the user's; losing it quietly is worse than stopping loudly.
 *    Recovery is manual (repair the file, or move it aside for a fresh start).
 *  - Every append re-reads the file, adds the record and rewrites it, all
 *    synchronously. Within a process that serializes concurrent appends (the
 *    event loop cannot interleave them) and, because the read is fresh, two
 *    store instances on one file do not drop each other's records either.
 *    There is no cross-process lock: run one server process per file.
 *  - The file holds records only (owner subject, date, exam, part, topic,
 *    scores) — never tokens, client ids or conversation ids.
 */

export class ProgressFileCorruptError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(
      `Progress file ${path} exists but is not valid (${detail}). Refusing to start or overwrite it. ` +
        "Repair it, or move it aside to begin a fresh history.",
    );
    this.name = "ProgressFileCorruptError";
  }
}

const ScoreSchema = z.object({
  criterion: z.enum(CRITERIA),
  band: z.string().min(1),
  evidence: z.string(),
  improvement: z.string(),
});

const RecordSchema = z.object({
  owner: z.string().refine((o) => o.trim() !== "", "empty owner"),
  at: z.number().finite(),
  exam: z.enum(["ielts", "tcf"]),
  part: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  topic: z.string(),
  scores: z.array(ScoreSchema),
});

const FileSchema = z.object({
  version: z.literal(1),
  records: z.array(RecordSchema),
});

let tempCounter = 0;

export class FileProgressStore implements ProgressStore {
  #records: ProgressRecord[];

  constructor(readonly path: string) {
    this.#records = this.#read();
  }

  append(record: ProgressRecord): void {
    assertAttributed(record.owner);
    const next = [...this.#read(), record];
    this.#write(next);
    this.#records = next;
  }

  summarize(owner: string): ProgressSummary {
    return summarizeRecords(this.#records.filter((r) => r.owner === owner));
  }

  #read(): ProgressRecord[] {
    if (!existsSync(this.path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw new ProgressFileCorruptError(this.path, error instanceof Error ? error.message : "unreadable");
    }
    const result = FileSchema.safeParse(parsed);
    if (!result.success) {
      throw new ProgressFileCorruptError(this.path, result.error.issues[0]?.message ?? "bad schema");
    }
    return result.data.records as ProgressRecord[];
  }

  #write(records: readonly ProgressRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${tempCounter++}.tmp`;
    const payload = JSON.stringify({ version: 1, records }, null, 2) + "\n";
    try {
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* temp may not exist */
      }
      throw error;
    }
  }
}

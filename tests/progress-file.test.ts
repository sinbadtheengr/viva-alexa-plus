import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileProgressStore, ProgressFileCorruptError } from "../src/grading/progress-file.js";
import { InMemoryProgressStore, type ProgressRecord } from "../src/grading/progress.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "viva-progress-"));
  file = join(dir, "nested", "progress.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(owner: string, at: number, band = "6", topic = "work"): ProgressRecord {
  return {
    owner,
    at,
    exam: "ielts",
    part: 2,
    topic,
    scores: [
      { criterion: "fluency_coherence", band: "8", evidence: "e", improvement: "i" },
      { criterion: "lexical_resource", band, evidence: "e", improvement: "i" },
      { criterion: "grammatical_range_accuracy", band: "7", evidence: "e", improvement: "i" },
    ],
  };
}

describe("FileProgressStore", () => {
  it("starts empty when the file is missing and creates it on first append", () => {
    const store = new FileProgressStore(file);
    expect(store.summarize("passcode:default").sessionCount).toBe(0);
    store.append(record("passcode:default", 1));
    expect(store.summarize("passcode:default").sessionCount).toBe(1);
  });

  it("persists across a fresh store instance with identical summaries", () => {
    const a = new FileProgressStore(file);
    a.append(record("u1", 1, "5", "work"));
    a.append(record("u1", 2, "6", "hometown"));
    const b = new FileProgressStore(file);
    expect(b.summarize("u1")).toEqual(a.summarize("u1"));
    expect(b.summarize("u1").weakest?.criterion).toBe("lexical_resource");
    expect(b.summarize("u1").recurringTopics).toEqual(["hometown", "work"]);
  });

  it("matches the in-memory store's get_progress semantics", () => {
    const mem = new InMemoryProgressStore();
    const disk = new FileProgressStore(file);
    for (const [i, band] of ["4", "5", "6", "7"].entries()) {
      const r = record("u1", i + 1, band, `t${i}`);
      mem.append(r);
      disk.append(r);
    }
    expect(disk.summarize("u1")).toEqual(mem.summarize("u1"));
  });

  it("writes atomically: no temp files left, file is complete JSON, no secrets keys", () => {
    const store = new FileProgressStore(file);
    store.append(record("u1", 1));
    store.append(record("u1", 2));
    const files = readdirSync(join(dir, "nested"));
    expect(files).toEqual(["progress.json"]);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version: number; records: Record<string, unknown>[] };
    expect(parsed.version).toBe(1);
    expect(parsed.records).toHaveLength(2);
    expect(Object.keys(parsed.records[0]!).sort()).toEqual(["at", "exam", "owner", "part", "scores", "topic"]);
  });

  it("leaves the old file intact and no temp file if the write fails", () => {
    const store = new FileProgressStore(file);
    store.append(record("u1", 1));
    const before = readFileSync(file, "utf8");
    // A record that cannot be serialized (BigInt) fails before the rename.
    const bad = { ...record("u1", 2), at: 10n as unknown as number };
    expect(() => store.append(bad)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(join(dir, "nested"))).toEqual(["progress.json"]);
    expect(store.summarize("u1").sessionCount).toBe(1);
  });

  it("refuses a corrupt file and does not touch it", () => {
    const store = new FileProgressStore(file);
    store.append(record("u1", 1));
    writeFileSync(file, '{"version":1,"records":[{"owner":');
    expect(() => new FileProgressStore(file)).toThrow(ProgressFileCorruptError);
    expect(readFileSync(file, "utf8")).toBe('{"version":1,"records":[{"owner":');
  });

  it("refuses a well-formed file with the wrong shape", () => {
    new FileProgressStore(file).append(record("u1", 1));
    writeFileSync(file, JSON.stringify({ version: 1, records: [{ owner: "u1" }] }));
    expect(() => new FileProgressStore(file)).toThrow(ProgressFileCorruptError);
  });

  it("does not overwrite a file that became corrupt after startup", () => {
    const store = new FileProgressStore(file);
    store.append(record("u1", 1));
    writeFileSync(file, "garbage");
    expect(() => store.append(record("u1", 2))).toThrow(ProgressFileCorruptError);
    expect(readFileSync(file, "utf8")).toBe("garbage");
  });

  it("loses no record when many appends land together, even across two instances", async () => {
    const a = new FileProgressStore(file);
    const b = new FileProgressStore(file);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() => (i % 2 === 0 ? a : b).append(record("u1", i + 1, "6", `t${i}`))),
      ),
    );
    expect(new FileProgressStore(file).summarize("u1").sessionCount).toBe(20);
  });

  it("keeps subjects isolated", () => {
    const store = new FileProgressStore(file);
    store.append(record("u1", 1, "3", "work"));
    store.append(record("u2", 2, "9", "travel"));
    const fresh = new FileProgressStore(file);
    expect(fresh.summarize("u1").sessionCount).toBe(1);
    expect(fresh.summarize("u1").recurringTopics).toEqual(["work"]);
    expect(fresh.summarize("u2").recurringTopics).toEqual(["travel"]);
    expect(fresh.summarize("nobody").sessionCount).toBe(0);
  });

  it.each([["" as string], ["   "]])("rejects an unattributed record (%j) and writes nothing", (owner) => {
    const store = new FileProgressStore(file);
    expect(() => store.append(record(owner, 1))).toThrow(/no owner/);
    expect(readdirSync(dir)).toEqual([]);
    expect(store.summarize(owner).sessionCount).toBe(0);
  });
});

describe("InMemoryProgressStore", () => {
  it("also rejects unattributed records", () => {
    expect(() => new InMemoryProgressStore().append(record("", 1))).toThrow(/no owner/);
  });
});

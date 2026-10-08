import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Corpus } from "../src/exam/corpus.js";
import { CorpusError } from "../src/exam/errors.js";
import { corpusFileSchema, examItemSchema } from "../src/exam/schema.js";
import { item, unpreppedItem } from "./fixtures.js";

const REPO_CORPUS = join(import.meta.dirname, "..", "corpus");

/** Writes a throwaway corpus tree and returns its root. */
async function tempCorpus(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "viva-corpus-"));
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(contents), "utf8");
  }
  return root;
}

function file(items: unknown[], provenance = "original, written for tests") {
  return { provenance, items };
}

describe("F-2 · the shipped corpus", () => {
  it("loads and validates from disk", async () => {
    const corpus = await Corpus.load(REPO_CORPUS);
    expect(corpus.list().length).toBeGreaterThan(0);
  });

  it("covers both locales, so nothing has hardcoded en-US", async () => {
    const corpus = await Corpus.load(REPO_CORPUS);
    expect(corpus.locales()).toEqual(["en-US", "fr-FR"]);
  });

  it("records provenance for every file, as GAP-002 requires", async () => {
    const corpus = await Corpus.load(REPO_CORPUS);
    expect(corpus.provenanceFor("en-US", "ielts")).toMatch(/original/i);
    expect(corpus.provenanceFor("fr-FR", "tcf")).toMatch(/original/i);
  });

  it("gives every item a non-empty seed list, so the exam survives an LLM outage", async () => {
    const corpus = await Corpus.load(REPO_CORPUS);
    for (const entry of corpus.list()) {
      expect(entry.followUpSeeds.length).toBeGreaterThan(0);
    }
  });

  it("gives every part 2 item a cue card", async () => {
    const corpus = await Corpus.load(REPO_CORPUS);
    for (const entry of corpus.list().filter((e) => e.part === 2)) {
      expect(entry.bullets?.length).toBeGreaterThan(0);
    }
  });

  it("offers every part of both exams", async () => {
    const corpus = await Corpus.load(REPO_CORPUS);
    for (const [exam, locale] of [
      ["ielts", "en-US"],
      ["tcf", "fr-FR"],
    ] as const) {
      for (const part of [1, 2, 3] as const) {
        expect(corpus.candidates({ exam, part, locale }).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("F-2 · schema", () => {
  it("rejects a part 2 item with no cue card", () => {
    const result = examItemSchema.safeParse({ ...item(), bullets: undefined });
    expect(result.success).toBe(false);
  });

  it("rejects an empty seed list", () => {
    const result = examItemSchema.safeParse({ ...item(), followUpSeeds: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed id", () => {
    const result = examItemSchema.safeParse({ ...item(), id: "work item 1" });
    expect(result.success).toBe(false);
  });

  it("rejects a locale that is not a BCP 47 tag", () => {
    const result = examItemSchema.safeParse({ ...item(), locale: "english" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields rather than silently dropping them", () => {
    const result = examItemSchema.safeParse({ ...item(), difficulty: "hard" });
    expect(result.success).toBe(false);
  });

  it("requires provenance on a corpus file", () => {
    const result = corpusFileSchema.safeParse({ items: [item()] });
    expect(result.success).toBe(false);
  });
});

describe("F-2 · loader refuses a bad corpus", () => {
  it("rejects an item whose locale contradicts its directory", async () => {
    const root = await tempCorpus({
      "en-US/ielts.json": file([{ ...item(), locale: "fr-FR" }]),
    });
    await expect(Corpus.load(root)).rejects.toThrow(CorpusError);
  });

  it("rejects an item whose exam contradicts its filename", async () => {
    const root = await tempCorpus({
      "en-US/ielts.json": file([{ ...item(), exam: "tcf" }]),
    });
    await expect(Corpus.load(root)).rejects.toThrow(CorpusError);
  });

  it("rejects duplicate ids across files", async () => {
    const root = await tempCorpus({
      "en-US/ielts.json": file([item()]),
      "fr-FR/ielts.json": file([{ ...item(), locale: "fr-FR" }]),
    });
    await expect(Corpus.load(root)).rejects.toThrow(/Duplicate item id/);
  });

  it("rejects malformed JSON with the path in the message", async () => {
    const root = await mkdtemp(join(tmpdir(), "viva-corpus-"));
    await mkdir(join(root, "en-US"), { recursive: true });
    await writeFile(join(root, "en-US", "ielts.json"), "{ not json", "utf8");
    await expect(Corpus.load(root)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects an empty corpus root", async () => {
    const root = await mkdtemp(join(tmpdir(), "viva-corpus-"));
    await expect(Corpus.load(root)).rejects.toThrow(/no locale directories/);
  });

  it("rejects a missing corpus root", async () => {
    await expect(Corpus.load(join(tmpdir(), "viva-does-not-exist"))).rejects.toThrow(CorpusError);
  });
});

describe("F-2 · selection", () => {
  const corpus = Corpus.fromItems([
    item(),
    item({ id: "ielts.p2.journey.001", topic: "journey" }),
    unpreppedItem(),
    unpreppedItem({ id: "tcf.p1.quotidien.001", exam: "tcf", locale: "fr-FR" }),
  ]);

  it("filters by exam, part and locale together", () => {
    expect(corpus.candidates({ exam: "ielts", part: 2, locale: "en-US" })).toHaveLength(2);
    expect(corpus.candidates({ exam: "tcf", part: 1, locale: "fr-FR" })).toHaveLength(1);
  });

  it("narrows by topic when one is given", () => {
    const pool = corpus.candidates({ exam: "ielts", part: 2, locale: "en-US", topic: "journey" });
    expect(pool.map((e) => e.id)).toEqual(["ielts.p2.journey.001"]);
  });

  it("never crosses locales", () => {
    expect(corpus.candidates({ exam: "tcf", part: 1, locale: "en-US" })).toHaveLength(0);
  });

  it("picks deterministically when the rng is injected", () => {
    const query = { exam: "ielts", part: 2, locale: "en-US" } as const;
    expect(corpus.pick(query, () => 0)?.id).toBe("ielts.p2.work.001");
    expect(corpus.pick(query, () => 0.99)?.id).toBe("ielts.p2.journey.001");
  });

  it("returns undefined rather than throwing when nothing matches", () => {
    expect(corpus.pick({ exam: "tcf", part: 3, locale: "de-DE" })).toBeUndefined();
  });

  it("looks items up by id", () => {
    expect(corpus.byId("ielts.p2.work.001")?.topic).toBe("work");
    expect(corpus.byId("nope")).toBeUndefined();
  });
});

describe("F-2 · corpus quality (hard rule 1, GAP-002)", () => {
  const words = (text: string): Set<string> =>
    new Set(text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) ?? []);
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    let shared = 0;
    for (const w of a) if (b.has(w)) shared += 1;
    return shared / (a.size + b.size - shared);
  };

  it("has unique ids", async () => {
    const ids = (await Corpus.load(REPO_CORPUS)).list().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("validates every item against the schema and keeps ids in step with their fields", async () => {
    for (const entry of (await Corpus.load(REPO_CORPUS)).list()) {
      expect(examItemSchema.safeParse(entry).success, entry.id).toBe(true);
      expect(entry.id.startsWith(`${entry.exam}.p${entry.part}.${entry.topic}.`), entry.id).toBe(true);
    }
  });

  it("gives every item at least three follow-up seeds", async () => {
    for (const entry of (await Corpus.load(REPO_CORPUS)).list()) {
      expect(entry.followUpSeeds.length, entry.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives every part 2 item 3-4 cue-card bullets", async () => {
    for (const entry of (await Corpus.load(REPO_CORPUS)).list().filter((e) => e.part === 2)) {
      expect(entry.bullets?.length, entry.id).toBeGreaterThanOrEqual(3);
      expect(entry.bullets?.length, entry.id).toBeLessThanOrEqual(4);
    }
  });

  it("keeps IELTS part 2 at 60s prep / 120s speaking, and has no bullets elsewhere", async () => {
    for (const entry of (await Corpus.load(REPO_CORPUS)).list().filter((e) => e.exam === "ielts")) {
      if (entry.part === 2) {
        expect([entry.prepSeconds, entry.speakSeconds], entry.id).toEqual([60, 120]);
      } else {
        expect(entry.prepSeconds, entry.id).toBe(0);
        expect(entry.bullets, entry.id).toBeUndefined();
      }
    }
  });

  it("gives every IELTS topic with a part 2 a part 3 discussion, and covers 8+ topics", async () => {
    const ielts = (await Corpus.load(REPO_CORPUS)).list().filter((e) => e.exam === "ielts" && e.locale === "en-US");
    const topicsOf = (part: number) => new Set(ielts.filter((e) => e.part === part).map((e) => e.topic));
    const part3 = topicsOf(3);
    for (const topic of topicsOf(2)) expect(part3.has(topic), topic).toBe(true);
    expect(topicsOf(2).size).toBeGreaterThanOrEqual(8);
    for (const part of [1, 2, 3]) {
      for (const topic of topicsOf(2)) {
        expect(ielts.filter((e) => e.part === part && e.topic === topic).length, `p${part} ${topic}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("contains no near-duplicate prompts within an exam and part", async () => {
    const all = (await Corpus.load(REPO_CORPUS)).list();
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        if (a.exam !== b.exam || a.part !== b.part) continue;
        expect(jaccard(words(a.prompt), words(b.prompt)), `${a.id} vs ${b.id}`).toBeLessThan(0.7);
      }
    }
  });

  it("contains no duplicated follow-up seeds inside one item", async () => {
    for (const entry of (await Corpus.load(REPO_CORPUS)).list()) {
      expect(new Set(entry.followUpSeeds).size, entry.id).toBe(entry.followUpSeeds.length);
    }
  });
});

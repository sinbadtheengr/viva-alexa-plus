import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CORPUS_ROOT } from "../config.js";
import { CorpusError } from "./errors.js";
import type { Exam, ExamItem, Part } from "./schema.js";
import { corpusFileSchema } from "./schema.js";

/**
 * F-2 · Corpus loading.
 *
 * Validation is strict and happens once, at startup: an invalid corpus stops
 * the server rather than surfacing as a confusing failure mid-exam.
 */

export interface PickQuery {
  readonly exam: Exam;
  readonly part: Part;
  readonly locale: string;
  readonly topic?: string;
}

export class Corpus {
  readonly #byId: ReadonlyMap<string, ExamItem>;
  readonly #items: readonly ExamItem[];
  readonly #provenance: ReadonlyMap<string, string>;

  private constructor(items: readonly ExamItem[], provenance: ReadonlyMap<string, string>) {
    this.#items = items;
    this.#byId = new Map(items.map((item) => [item.id, item]));
    this.#provenance = provenance;
  }

  /**
   * Reads every `<root>/<locale>/<exam>.json`. Throws CorpusError on anything
   * malformed, mislabelled or duplicated.
   */
  static async load(root: string = CORPUS_ROOT): Promise<Corpus> {
    const base = resolve(root);
    const items: ExamItem[] = [];
    const provenance = new Map<string, string>();
    const seen = new Map<string, string>();

    let locales: string[];
    try {
      const entries = await readdir(base, { withFileTypes: true });
      locales = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (cause) {
      throw new CorpusError(`Cannot read corpus root ${base}: ${String(cause)}`);
    }

    if (locales.length === 0) {
      throw new CorpusError(`Corpus root ${base} contains no locale directories.`);
    }

    for (const locale of locales) {
      const dir = join(base, locale);
      const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();

      for (const file of files) {
        const path = join(dir, file);
        const exam = file.replace(/\.json$/, "");

        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(path, "utf8"));
        } catch (cause) {
          throw new CorpusError(`${path} is not valid JSON: ${String(cause)}`);
        }

        const result = corpusFileSchema.safeParse(parsed);
        if (!result.success) {
          throw new CorpusError(`${path} failed validation:\n${formatIssues(result.error)}`);
        }

        provenance.set(`${locale}/${exam}`, result.data.provenance);

        for (const item of result.data.items) {
          // The directory layout is part of the contract: a mislabelled item
          // would otherwise be unreachable through `pick`.
          if (item.locale !== locale) {
            throw new CorpusError(
              `${path}: item ${item.id} declares locale "${item.locale}" but sits in "${locale}/".`,
            );
          }
          if (item.exam !== exam) {
            throw new CorpusError(
              `${path}: item ${item.id} declares exam "${item.exam}" but sits in "${file}".`,
            );
          }
          const priorPath = seen.get(item.id);
          if (priorPath !== undefined) {
            throw new CorpusError(`Duplicate item id ${item.id} in ${priorPath} and ${path}.`);
          }
          seen.set(item.id, path);
          items.push(item);
        }
      }
    }

    if (items.length === 0) {
      throw new CorpusError(`Corpus root ${base} contains no items.`);
    }

    return new Corpus(items, provenance);
  }

  /** Builds a corpus straight from memory. Used by tests. */
  static fromItems(items: readonly ExamItem[], provenance = "test fixture"): Corpus {
    const map = new Map<string, string>();
    for (const item of items) map.set(`${item.locale}/${item.exam}`, provenance);
    return new Corpus(items, map);
  }

  byId(id: string): ExamItem | undefined {
    return this.#byId.get(id);
  }

  list(): readonly ExamItem[] {
    return this.#items;
  }

  locales(): readonly string[] {
    return [...new Set(this.#items.map((i) => i.locale))].sort();
  }

  provenanceFor(locale: string, exam: Exam): string | undefined {
    return this.#provenance.get(`${locale}/${exam}`);
  }

  /** Every item matching the query, in corpus order. */
  candidates(query: PickQuery): readonly ExamItem[] {
    return this.#items.filter(
      (item) =>
        item.exam === query.exam &&
        item.part === query.part &&
        item.locale === query.locale &&
        (query.topic === undefined || item.topic === query.topic),
    );
  }

  /**
   * One matching item, or undefined when nothing matches. `rng` is injectable
   * so tests are deterministic and the demo still varies between runs.
   */
  pick(query: PickQuery, rng: () => number = Math.random): ExamItem | undefined {
    const pool = this.candidates(query);
    if (pool.length === 0) return undefined;
    const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    return pool[index];
  }
}

function formatIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `  • ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

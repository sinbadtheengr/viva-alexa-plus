import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const REPO = join(import.meta.dirname, "..");

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("../src/config.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("CORPUS_ROOT resolution", () => {
  it("defaults to <repo root>/corpus regardless of the working directory", async () => {
    const { CORPUS_ROOT } = await loadConfig({ VIVA_CORPUS_ROOT: "" });
    expect(isAbsolute(CORPUS_ROOT)).toBe(true);
    expect(resolve(CORPUS_ROOT)).toBe(resolve(REPO, "corpus"));
    expect(existsSync(CORPUS_ROOT)).toBe(true);
  });

  it("takes an absolute VIVA_CORPUS_ROOT as-is", async () => {
    const abs = resolve(REPO, "somewhere", "else");
    const { CORPUS_ROOT } = await loadConfig({ VIVA_CORPUS_ROOT: abs });
    expect(CORPUS_ROOT).toBe(abs);
  });

  it("resolves a relative VIVA_CORPUS_ROOT against the working directory", async () => {
    const { CORPUS_ROOT } = await loadConfig({ VIVA_CORPUS_ROOT: "my-corpus" });
    expect(CORPUS_ROOT).toBe(resolve(process.cwd(), "my-corpus"));
  });
});

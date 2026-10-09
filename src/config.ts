import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The only place locale and exam defaults are allowed to appear as literals.
 * Hard rule 2 (CLAUDE.md): locale is a parameter everywhere else.
 */

export const DEFAULT_LOCALE = process.env["VIVA_DEFAULT_LOCALE"] ?? "en-US";
export const DEFAULT_EXAM = process.env["VIVA_DEFAULT_EXAM"] ?? "ielts";

/** Repo/package root: one level above src/ (tsx, vitest) and dist/ (compiled) alike. */
export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Corpus root. The default is <repo root>/corpus, independent of the working
 * directory. VIVA_CORPUS_ROOT overrides it: absolute as-is, relative resolved
 * against the process working directory (the usual meaning of a relative env path).
 */
export const CORPUS_ROOT = process.env["VIVA_CORPUS_ROOT"]
  ? resolve(process.env["VIVA_CORPUS_ROOT"])
  : resolve(REPO_ROOT, "corpus");

/** F-3: sessions expire after 30 minutes idle. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * F-7 · Where progress history is persisted. Unset = in-memory only (history is
 * lost on restart); tests and casual dev runs stay file-free.
 */
export const PROGRESS_FILE: string | undefined = process.env["VIVA_PROGRESS_FILE"] || undefined;

/**
 * F-1 · Transport-level MCP sessions (GAP-015). Distinct from exam sessions
 * (SESSION_IDLE_MS above): these are the Mcp-Session-Id connections, one per
 * client conversation, and they are reaped when idle so a client that vanishes
 * without a DELETE cannot leak a transport forever.
 */
const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
export const MCP_SESSION_IDLE_MS = positiveInt(process.env["VIVA_MCP_SESSION_IDLE_MS"], 30 * 60 * 1000);
/** Hard cap; at the cap the least-recently-used connection is evicted to admit a new one. */
export const MCP_SESSION_MAX = positiveInt(process.env["VIVA_MCP_SESSION_MAX"], 100);
export const MCP_SESSION_SWEEP_MS = positiveInt(process.env["VIVA_MCP_SESSION_SWEEP_MS"], 60 * 1000);

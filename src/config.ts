/**
 * The only place locale and exam defaults are allowed to appear as literals.
 * Hard rule 2 (CLAUDE.md): locale is a parameter everywhere else.
 */

export const DEFAULT_LOCALE = process.env["VIVA_DEFAULT_LOCALE"] ?? "en-US";
export const DEFAULT_EXAM = process.env["VIVA_DEFAULT_EXAM"] ?? "ielts";

/** Corpus root, relative to the repo root unless absolute. */
export const CORPUS_ROOT = process.env["VIVA_CORPUS_ROOT"] ?? "corpus";

/** F-3: sessions expire after 30 minutes idle. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

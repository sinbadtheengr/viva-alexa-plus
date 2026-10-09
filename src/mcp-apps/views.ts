import { DEFAULT_LOCALE } from "../config.js";
import { CLIENT_JS } from "./client.js";
import { VIEW_CSS } from "./styles.js";

/**
 * F-8 · The three MCP Apps views.
 *
 * Each is one self-contained HTML document (inline CSS and JS, no external
 * loads). All three carry the same script; the resource only chooses which
 * layout a payload falls back to, because one tool can legitimately return more
 * than one kind of payload (advance_phase answers with a cue card during
 * preparation and a speaking clock afterwards).
 */

export type ViewId = "cue" | "speaking" | "results";

export interface ViewDef {
  readonly id: ViewId;
  readonly uri: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

export const VIEWS: Readonly<Record<ViewId, ViewDef>> = {
  cue: {
    id: "cue",
    uri: "ui://viva/cue-card.html",
    name: "viva-cue-card",
    title: "Cue card",
    description: "The examiner's prompt, cue-card bullets and a live preparation countdown.",
  },
  speaking: {
    id: "speaking",
    uri: "ui://viva/speaking.html",
    name: "viva-speaking",
    title: "Speaking",
    description: "Elapsed speaking time, a microphone level meter and the current follow-up question.",
  },
  results: {
    id: "results",
    uri: "ui://viva/results.html",
    name: "viva-results",
    title: "Results",
    description: "Three rubric criteria with level, evidence and one improvement each.",
  },
};

/**
 * `locale` seeds the document language (BCP 47); the client script then follows
 * the payload's own locale at runtime. Anything that is not a plain language tag
 * falls back to the configured default rather than reaching the attribute.
 */
export function renderView(id: ViewId, locale: string = DEFAULT_LOCALE): string {
  const view = VIEWS[id];
  const lang = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale) ? locale : DEFAULT_LOCALE;
  return (
    `<!doctype html>\n<html lang="${lang}" data-default-view="${id}">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>Viva — ${view.title}</title>\n` +
    `<style>${VIEW_CSS}</style>\n</head>\n<body>\n<div id="root"></div>\n` +
    `<script>${CLIENT_JS}</script>\n</body>\n</html>\n`
  );
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Router } from "express";
import type { AuthConfig } from "../auth/config.js";
import { DEFAULT_EXAM, DEFAULT_LOCALE } from "../config.js";
import type { Corpus } from "../exam/corpus.js";

/**
 * Demo client — the stand-in for Alexa+.
 *
 * The Alexa+ add-on toolchain is closed to hackathon participants (GAP-001,
 * GAP-006), so a browser app plays the Alexa+ role for the demo: it runs the
 * OAuth 2.1 + PKCE flow against our own authorization server and drives the
 * seven tools over Streamable HTTP, speaking and listening through the browser.
 *
 * It is served same-origin, so no CORS is opened on /mcp or the auth endpoints.
 * Nothing here is a tool or an auth endpoint; it is only static files plus one
 * config document.
 */

export const DEMO_PATH = "/demo";

export interface DemoConfig {
  readonly clientId: string;
  /** Must be registered for `clientId` in VIVA_OAUTH_CLIENTS. */
  readonly redirectUri: string;
  readonly scope: string;
}

export function loadDemoConfig(auth: AuthConfig, env: NodeJS.ProcessEnv = process.env): DemoConfig | null {
  if (env["VIVA_DEMO_UI"] === "0") return null;
  return {
    clientId: env["VIVA_DEMO_CLIENT_ID"] ?? "viva-demo",
    redirectUri: env["VIVA_DEMO_REDIRECT_URI"] ?? new URL(`${DEMO_PATH}/`, auth.issuerUrl).href,
    scope: env["VIVA_DEMO_SCOPE"] ?? "exam progress",
  };
}

/** What the browser needs to know, derived from server config and the corpus. */
export function clientConfig(demo: DemoConfig, auth: AuthConfig, corpus: Corpus) {
  const combos = new Map<string, { exam: string; locale: string; parts: Map<number, Set<string>> }>();
  for (const item of corpus.list()) {
    const key = `${item.exam}/${item.locale}`;
    const entry = combos.get(key) ?? { exam: item.exam, locale: item.locale, parts: new Map() };
    const topics = entry.parts.get(item.part) ?? new Set<string>();
    topics.add(item.topic);
    entry.parts.set(item.part, topics);
    combos.set(key, entry);
  }
  return {
    authEnabled: auth.enabled,
    clientId: demo.clientId,
    redirectUri: demo.redirectUri,
    scope: demo.scope,
    // Only the browser's view of these URLs matters; it uses the metadata
    // document at the issuer to discover the endpoints, as a real client would.
    issuer: auth.issuerUrl.href,
    resource: auth.resourceUrl.href,
    mcpUrl: "/mcp",
    defaults: { exam: DEFAULT_EXAM, locale: DEFAULT_LOCALE },
    catalog: [...combos.values()].map((c) => ({
      exam: c.exam,
      locale: c.locale,
      // part -> topics available for it
      parts: Object.fromEntries([...c.parts].map(([part, topics]) => [part, [...topics].sort()])),
    })),
  };
}

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

/**
 * `PUBLIC_DIR` resolves beside this module. From `dist/ui/` that directory does
 * not exist (tsc does not copy static files), so fall back to the source tree.
 */
const SOURCE_PUBLIC_DIR = fileURLToPath(new URL("../../src/ui/public/", import.meta.url));

export function demoRouter(demo: DemoConfig, auth: AuthConfig, corpus: Corpus): Router {
  const router = express.Router();
  const doc = clientConfig(demo, auth, corpus);

  router.get(`${DEMO_PATH}/config.json`, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(doc);
  });

  // index.html is a template so its lang follows the configured default locale.
  const indexHtml = (): string | null => {
    for (const dir of [PUBLIC_DIR, SOURCE_PUBLIC_DIR]) {
      try {
        return readFileSync(dir + "index.html", "utf8").replaceAll("__VIVA_LANG__", DEFAULT_LOCALE);
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  };
  router.get([DEMO_PATH, `${DEMO_PATH}/`, `${DEMO_PATH}/index.html`], (req, res, next) => {
    if (req.path === DEMO_PATH) return res.redirect(301, `${DEMO_PATH}/`);
    const html = indexHtml();
    if (html === null) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(html);
  });

  const options = { index: "index.html", maxAge: 0, fallthrough: true } as const;
  router.use(DEMO_PATH, express.static(PUBLIC_DIR, options));
  router.use(DEMO_PATH, express.static(SOURCE_PUBLIC_DIR, options));
  return router;
}

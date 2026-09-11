import { createApp } from "./app.js";
import { loadAuthConfig } from "./auth/config.js";
import { CORPUS_ROOT } from "./config.js";
import { Corpus } from "./exam/corpus.js";
import { createScorer, loadScorerConfig } from "./grading/config.js";
import { createLogger } from "./mcp/logging.js";
import { SERVER_VERSION } from "./mcp/server.js";

/**
 * Entrypoint. Everything interesting lives in `createApp` (F-1 + F-9) — this
 * file only resolves configuration, binds a port, and shuts down cleanly.
 */

const PORT = Number(process.env["PORT"] ?? 8787);
const HOST = process.env["HOST"] ?? "127.0.0.1";

async function main(): Promise<void> {
  const logger = createLogger();
  const auth = loadAuthConfig();
  const corpus = await Corpus.load(CORPUS_ROOT);

  logger.log({ event: "corpus_loaded", items: corpus.list().length, locales: corpus.locales() });

  const scorerConfig = loadScorerConfig();
  const scorer = createScorer(scorerConfig, logger);
  logger.log({
    event: "scorer",
    name: scorer.name,
    enabled: scorerConfig.enabled,
    ...(scorerConfig.enabled ? { region: scorerConfig.region, model: scorerConfig.model } : {}),
    ...(scorerConfig.enabled
      ? {}
      : { note: "Set VIVA_BEDROCK_REGION to enable rubric scoring (F-6)." }),
  });

  const { app, provider, close } = await createApp({ corpus, auth, logger, scorer });

  if (provider) {
    // Expired codes and tokens should not accumulate for the life of the process.
    const sweeper = setInterval(() => provider.store.sweep(), 60_000);
    sweeper.unref();
  }

  const http = app.listen(PORT, HOST, () => {
    logger.log({
      event: "listening",
      url: `http://${HOST}:${PORT}/mcp`,
      version: SERVER_VERSION,
      authenticated: auth.enabled,
    });
  });

  const shutdown = (signal: string): void => {
    logger.log({ event: "shutdown", signal });
    http.close(() => {
      void close().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "fatal",
      error: error instanceof Error ? error.message : String(error),
    }) + "\n",
  );
  process.exit(1);
});

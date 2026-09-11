import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CORPUS_ROOT } from "./config.js";
import { Corpus } from "./exam/corpus.js";
import { createLogger } from "./mcp/logging.js";
import { buildServer, SERVER_VERSION } from "./mcp/server.js";

/**
 * F-1 · HTTP entrypoint.
 *
 * Streamable HTTP only — the 2025-11-25 spec deprecated the standalone HTTP+SSE
 * transport, and Alexa+ will not talk to it (mcp-toolkit docs). Plain node:http;
 * the SDK transport adapts it internally, so there is no framework to keep current.
 *
 * OAuth 2.1 + PKCE is F-9 and is NOT implemented here yet: this server currently
 * accepts unauthenticated requests and must not be exposed publicly as-is.
 */

const PORT = Number(process.env["PORT"] ?? 8787);
const HOST = process.env["HOST"] ?? "127.0.0.1";

async function main(): Promise<void> {
  const logger = createLogger();
  const corpus = await Corpus.load(CORPUS_ROOT);
  const { server } = buildServer({ corpus, logger });

  logger.log({
    event: "corpus_loaded",
    items: corpus.list().length,
    locales: corpus.locales(),
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // The SDK's own transport does not satisfy the SDK's own Transport interface
  // under `exactOptionalPropertyTypes`: the class declares `onclose` as
  // `(() => void) | undefined` while the interface declares it optional-but-
  // non-undefined. Narrow cast rather than relaxing the flag for our own code.
  // See FRICTION-005 — this is an upstream fix worth sending.
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: SERVER_VERSION }));
      return;
    }

    if (url.pathname === "/mcp") {
      const started = process.hrtime.bigint();
      res.on("finish", () => {
        logger.log({
          event: "http",
          method: req.method ?? "?",
          path: url.pathname,
          status: res.statusCode,
          durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e3) / 1e3,
        });
      });
      void transport.handleRequest(req, res).catch((error: unknown) => {
        logger.log({
          event: "transport_error",
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.writeHead(500).end();
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  http.listen(PORT, HOST, () => {
    logger.log({
      event: "listening",
      url: `http://${HOST}:${PORT}/mcp`,
      version: SERVER_VERSION,
      authenticated: false,
      warning: "F-9 (OAuth 2.1 + PKCE) is not implemented. Do not expose this publicly.",
    });
  });

  const shutdown = (signal: string): void => {
    logger.log({ event: "shutdown", signal });
    http.close(() => {
      void server.close().then(() => process.exit(0));
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

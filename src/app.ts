import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthConfig } from "./auth/config.js";
import { consentRouter } from "./auth/consent.js";
import { VivaOAuthProvider } from "./auth/provider.js";
import type { Corpus } from "./exam/corpus.js";
import { createLogger, type Logger } from "./mcp/logging.js";
import { buildServer, SERVER_VERSION } from "./mcp/server.js";

/**
 * F-1 + F-9 · The HTTP application.
 *
 * Split out from the entrypoint so tests can drive the real app — real auth
 * router, real middleware, real transport — over a loopback port, rather than
 * asserting against a rearranged copy of it.
 */

export interface AppOptions {
  readonly corpus: Corpus;
  readonly auth: AuthConfig;
  readonly logger?: Logger;
}

export interface BuiltApp {
  readonly app: Express;
  readonly provider: VivaOAuthProvider | null;
  readonly close: () => Promise<void>;
}

export async function createApp(options: AppOptions): Promise<BuiltApp> {
  const logger = options.logger ?? createLogger();
  const { server } = buildServer({ corpus: options.corpus, logger });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // The SDK's own transport does not satisfy the SDK's own Transport interface
  // under `exactOptionalPropertyTypes`. Narrow cast rather than relaxing the
  // flag for our own code. See FRICTION-005 — an upstream fix worth sending.
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: SERVER_VERSION, authenticated: options.auth.enabled });
  });

  const guards: express.RequestHandler[] = [];
  let provider: VivaOAuthProvider | null = null;

  if (options.auth.enabled) {
    provider = new VivaOAuthProvider(options.auth);

    // Authorization server: /authorize, /token and the metadata documents.
    // Dynamic Client Registration is absent because StaticClientsStore has no
    // registerClient — the SDK only mounts that endpoint when it exists (F-9).
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: options.auth.issuerUrl,
        resourceServerUrl: options.auth.resourceUrl,
        resourceName: "Viva speaking examiner",
        scopesSupported: ["exam", "progress"],
      }),
    );
    app.use(consentRouter(provider, options.auth));

    guards.push(
      requireBearerAuth({
        verifier: provider,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(options.auth.resourceUrl),
      }),
    );

    logger.log({
      event: "auth_enabled",
      issuer: options.auth.issuerUrl.href,
      resource: options.auth.resourceUrl.href,
      clients: provider.clientsStore.size,
      dynamicClientRegistration: false,
    });

    if (provider.clientsStore.size === 0) {
      logger.log({
        event: "warning",
        message: "No OAuth clients configured. Set VIVA_OAUTH_CLIENTS or no client can authorize.",
      });
    }
  } else {
    logger.log({
      event: "warning",
      message:
        "VIVA_AUTH_DISABLED=1 — /mcp is unauthenticated. Local development only; never expose this.",
    });
  }

  app.all("/mcp", ...guards, (req, res) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      logger.log({
        event: "http",
        method: req.method,
        path: "/mcp",
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e3) / 1e3,
      });
    });
    void transport.handleRequest(req, res).catch((error: unknown) => {
      logger.log({
        event: "transport_error",
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) res.status(500).end();
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return {
    app,
    provider,
    close: async () => {
      await server.close();
    },
  };
}

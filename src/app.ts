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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SESSION_IDLE_MS, MCP_SESSION_MAX, MCP_SESSION_SWEEP_MS } from "./config.js";
import { LOCAL_SUBJECT } from "./auth/identity.js";
import { VivaOAuthProvider } from "./auth/provider.js";
import type { Corpus } from "./exam/corpus.js";
import { SessionStore } from "./exam/session.js";
import { InMemoryProgressStore, type ProgressStore } from "./grading/progress.js";
import { UnavailableScorer, type Scorer } from "./grading/types.js";
import type { ProbeCoordinator } from "./probes/probes.js";
import { createLogger, type Logger } from "./mcp/logging.js";
import { buildServer, SERVER_VERSION } from "./mcp/server.js";
import { demoRouter, type DemoConfig } from "./ui/demo.js";

const BARE_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

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
  /** F-6 grader. Defaults to the honest "no grader connected" stand-in. */
  readonly scorer?: Scorer;
  /** F-7 progress store. Defaults to in-memory. */
  readonly progress?: ProgressStore;
  /** F-5 follow-up probes. Defaults to seeds only. */
  readonly probes?: ProbeCoordinator;
  /** Serve the browser demo client (the Alexa+ stand-in) under /demo. Omit to leave it off. */
  readonly demo?: DemoConfig;
  /** Clock for the consent-screen passcode throttle (tests). Defaults to Date.now. */
  readonly consentClock?: () => number;
  /** GAP-015 · Idle limit for an MCP transport session. Defaults to config. */
  readonly mcpSessionIdleMs?: number;
  /** GAP-015 · Max concurrent MCP transport sessions. Defaults to config. */
  readonly mcpSessionMax?: number;
  /** GAP-015 · How often idle MCP sessions are swept. Defaults to config. */
  readonly mcpSessionSweepMs?: number;
  /** Clock for MCP session idleness; tests inject one. */
  readonly now?: () => number;
}

export interface BuiltApp {
  readonly app: Express;
  readonly provider: VivaOAuthProvider | null;
  readonly close: () => Promise<void>;
  /** Reaps idle MCP transport sessions now; returns how many were closed. */
  readonly sweepMcpSessions: () => Promise<number>;
  /** Number of live MCP transport sessions. */
  readonly mcpSessionCount: () => number;
}

interface McpConnection {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  lastSeenAt: number;
}

function jsonRpcError(code: number, message: string): { jsonrpc: "2.0"; error: { code: number; message: string }; id: null } {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

export async function createApp(options: AppOptions): Promise<BuiltApp> {
  const logger = options.logger ?? createLogger();
  const now = options.now ?? Date.now;
  const idleMs = options.mcpSessionIdleMs ?? MCP_SESSION_IDLE_MS;
  const maxSessions = options.mcpSessionMax ?? MCP_SESSION_MAX;

  // GAP-015 · Exam sessions, progress, the scorer and probes are process-wide and
  // shared by every MCP connection. Only the transport + McpServer pair is
  // per-connection, so an exam started on one MCP session stays readable on
  // another (a reload, or Alexa+ opening a fresh connection mid-exam).
  const shared = {
    corpus: options.corpus,
    logger,
    sessions: new SessionStore({ resolver: options.corpus }),
    progress: options.progress ?? new InMemoryProgressStore(),
    scorer: options.scorer ?? new UnavailableScorer(),
    // F-7 · With auth on, progress is keyed on the grant subject carried by the
    // access token. With auth off there is no grant to key on, so local
    // development gets one fixed subject rather than losing its history between
    // calls — a substitution that is only reachable because /mcp is unguarded,
    // which is itself local-only and already warned about below.
    ...(options.auth.enabled ? {} : { identify: () => LOCAL_SUBJECT }),
    ...(options.probes ? { probes: options.probes } : {}),
  };

  const connections = new Map<string, McpConnection>();

  const closeConnection = async (id: string): Promise<void> => {
    const conn = connections.get(id);
    if (!conn) return;
    connections.delete(id);
    // server.close() closes the transport too; both paths are idempotent.
    await conn.server.close().catch(() => undefined);
  };

  const createConnection = (): McpConnection => {
    const { server } = buildServer(shared);
    const conn: McpConnection = {
      server,
      lastSeenAt: now(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          // Make room first: evict the least-recently-used connection at the cap.
          while (connections.size >= maxSessions) {
            let oldest: string | undefined;
            let oldestAt = Infinity;
            for (const [key, c] of connections) {
              if (c.lastSeenAt < oldestAt) {
                oldest = key;
                oldestAt = c.lastSeenAt;
              }
            }
            if (oldest === undefined) break;
            logger.log({ event: "mcp_session_evicted", mcpSessionId: oldest, reason: "cap" });
            void closeConnection(oldest); // removes it from the map synchronously
          }
          connections.set(id, conn);
          logger.log({ event: "mcp_session_open", mcpSessionId: id, open: connections.size });
        },
      }),
    };
    conn.transport.onclose = () => {
      const id = conn.transport.sessionId;
      if (id) {
        connections.delete(id);
        logger.log({ event: "mcp_session_closed", mcpSessionId: id, open: connections.size });
      }
    };
    // The SDK's own transport does not satisfy the SDK's own Transport interface
    // under `exactOptionalPropertyTypes`. Narrow cast rather than relaxing the
    // flag for our own code. See FRICTION-005 — an upstream fix worth sending.
    void server.connect(conn.transport as unknown as Parameters<typeof server.connect>[0]);
    return conn;
  };

  const sweepMcpSessions = async (): Promise<number> => {
    const cutoff = now() - idleMs;
    const stale = [...connections].filter(([, c]) => c.lastSeenAt < cutoff).map(([id]) => id);
    for (const id of stale) {
      logger.log({ event: "mcp_session_evicted", mcpSessionId: id, reason: "idle" });
      await closeConnection(id);
    }
    return stale.length;
  };

  const sweeper = setInterval(() => void sweepMcpSessions(), options.mcpSessionSweepMs ?? MCP_SESSION_SWEEP_MS);
  sweeper.unref();

  const app = express();
  app.disable("x-powered-by");
  // GAP-011: req.ip stays the socket address unless a proxy is explicitly declared,
  // otherwise X-Forwarded-For (client-controlled) would defeat the consent throttle.
  if (options.auth.enabled && options.auth.trustProxy !== undefined) {
    app.set("trust proxy", options.auth.trustProxy);
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: SERVER_VERSION, authenticated: options.auth.enabled });
  });

  const guards: express.RequestHandler[] = [];
  let provider: VivaOAuthProvider | null = null;

  if (options.auth.enabled) {
    provider = new VivaOAuthProvider(options.auth);

    // RFC 9728 clients may probe the bare well-known path as well as the
    // resource-suffixed one the 401 challenge advertises. Rewrite the bare form
    // onto the suffixed route so both serve the identical document.
    const suffixedMetadataPath = new URL(getOAuthProtectedResourceMetadataUrl(options.auth.resourceUrl)).pathname;
    if (suffixedMetadataPath !== BARE_PROTECTED_RESOURCE_PATH) {
      app.use((req, _res, next) => {
        if (req.path === BARE_PROTECTED_RESOURCE_PATH) {
          req.url = suffixedMetadataPath + req.url.slice(BARE_PROTECTED_RESOURCE_PATH.length);
        }
        next();
      });
    }

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
    app.use(consentRouter(provider, options.auth, options.consentClock));

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

  if (options.demo) {
    app.use(demoRouter(options.demo, options.auth, options.corpus));
    logger.log({ event: "demo_ui", path: "/demo/", clientId: options.demo.clientId });
  }

  const route: express.RequestHandler = (req, res) => {
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

    const header = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const body: unknown = req.body;
    // A batch cannot carry initialize (the transport rejects it too), so only a
    // lone initialize request starts a connection.
    const isInit = req.method === "POST" && !Array.isArray(body) && isInitializeRequest(body);

    let conn: McpConnection | undefined;
    if (isInit) {
      // Any stale Mcp-Session-Id is ignored: a reloaded client re-initialises.
      conn = createConnection();
    } else if (!sessionId) {
      res
        .status(400)
        .json(jsonRpcError(-32000, "Bad Request: Mcp-Session-Id header is required. Send an initialize request first."));
      return;
    } else {
      conn = connections.get(sessionId);
      if (!conn) {
        res.status(404).json(jsonRpcError(-32001, "Session not found. It may have expired; send a new initialize request."));
        return;
      }
    }

    conn.lastSeenAt = now();
    void conn.transport
      .handleRequest(req, res, req.method === "POST" ? body : undefined)
      .catch((error: unknown) => {
        logger.log({
          event: "transport_error",
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.status(500).end();
      });
  };

  // Auth guards run first, unchanged. The JSON body is parsed after them so an
  // unauthenticated caller never reaches the parser.
  app.all(
    "/mcp",
    ...guards,
    express.json({ limit: "1mb" }),
    route,
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : 400;
      if (!res.headersSent) res.status(status).json(jsonRpcError(-32700, "Parse error: request body is not valid JSON."));
    },
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return {
    app,
    provider,
    close: async () => {
      clearInterval(sweeper);
      await Promise.all([...connections.keys()].map(closeConnection));
    },
    sweepMcpSessions,
    mcpSessionCount: () => connections.size,
  };
}

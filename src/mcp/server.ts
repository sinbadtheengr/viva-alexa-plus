import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Corpus } from "../exam/corpus.js";
import { SessionStore } from "../exam/session.js";
import { InMemoryProgressStore, type ProgressStore } from "../grading/progress.js";
import { UnavailableScorer, type Scorer } from "../grading/types.js";
import { createLogger, type Logger } from "./logging.js";
import { registerTools } from "./tools.js";

/**
 * F-1 · Assembling the MCP server.
 *
 * Every collaborator is injectable so the whole server can be built in a test
 * without touching the filesystem, the network, or a model.
 */

export const SERVER_NAME = "viva";
export const SERVER_VERSION = "0.1.0";

export interface BuildOptions {
  readonly corpus: Corpus;
  readonly sessions?: SessionStore;
  readonly scorer?: Scorer;
  readonly progress?: ProgressStore;
  readonly logger?: Logger;
  readonly owner?: () => string;
  readonly now?: () => number;
}

export interface BuiltServer {
  readonly server: McpServer;
  readonly sessions: SessionStore;
  readonly progress: ProgressStore;
  readonly scorer: Scorer;
  readonly logger: Logger;
}

export function buildServer(options: BuildOptions): BuiltServer {
  const logger = options.logger ?? createLogger();
  const sessions = options.sessions ?? new SessionStore({ resolver: options.corpus });
  const progress = options.progress ?? new InMemoryProgressStore();
  const scorer = options.scorer ?? new UnavailableScorer();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Viva runs timed speaking exams (IELTS in English, TCF in French). " +
        "Act as the examiner: read prompts aloud verbatim, keep to the clock the tools report, " +
        "and pass the candidate's words to submit_response exactly as spoken. " +
        "Never correct their grammar mid-exam and never invent a score.",
    },
  );

  registerTools(server, {
    corpus: options.corpus,
    sessions,
    scorer,
    progress,
    logger,
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return { server, sessions, progress, scorer, logger };
}

/** Loads the corpus from disk and builds the server around it. */
export async function buildFromDisk(corpusRoot?: string): Promise<BuiltServer> {
  const corpus = await Corpus.load(corpusRoot);
  return buildServer({ corpus });
}

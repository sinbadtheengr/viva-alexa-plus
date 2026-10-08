import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { Session } from "../exam/session.js";
import type { ExamItem } from "../exam/schema.js";
import { VIEWS, renderView, type ViewId } from "./views.js";

/**
 * F-8 · Registering the UI resources and linking tools to them.
 */

/**
 * Tool `_meta` that links a tool to a view. Both the current `ui.resourceUri`
 * and the legacy `ui/resourceUri` key are set, the same normalisation the
 * ext-apps `registerAppTool` helper performs.
 */
export function uiToolMeta(view: ViewId): Record<string, unknown> {
  const resourceUri = VIEWS[view].uri;
  return { ui: { resourceUri }, "ui/resourceUri": resourceUri };
}

/**
 * Additive clock fields for a tool's structuredContent. The deadline is the
 * session's own (server-computed, GAP-008); `serverNow` rides along so a view
 * can count down without ever comparing its clock with ours.
 */
export interface ClockFields {
  readonly phaseDeadline: number | null;
  readonly serverNow: number;
  /** Length of the current timed phase in seconds, or null when untimed. */
  readonly phaseSeconds: number | null;
}

export function clockFields(
  session: Pick<Session, "phase" | "phaseDeadline">,
  item: Pick<ExamItem, "prepSeconds" | "speakSeconds"> | undefined,
  now: number,
): ClockFields {
  const phaseSeconds =
    session.phaseDeadline === null || !item
      ? null
      : session.phase === "prep"
        ? item.prepSeconds
        : session.phase === "speaking"
          ? item.speakSeconds
          : null;
  return { phaseDeadline: session.phaseDeadline, serverNow: now, phaseSeconds };
}

/**
 * Registers the three `ui://` resources. The speaking view asks the host for
 * microphone access (feature-detected in the view) purely to draw a level
 * meter; no audio leaves the page and none is recorded. No `csp` is declared,
 * which is the standard's "no network at all" default.
 */
export function registerViewResources(server: McpServer): void {
  for (const view of Object.values(VIEWS)) {
    server.registerResource(
      view.name,
      view.uri,
      {
        description: view.description,
        mimeType: RESOURCE_MIME_TYPE,
        _meta: {
          ui: {
            prefersBorder: false,
            ...(view.id === "speaking" ? { permissions: { microphone: {} } } : {}),
          },
        },
      },
      () => ({
        contents: [
          {
            uri: view.uri,
            mimeType: RESOURCE_MIME_TYPE,
            text: renderView(view.id),
            _meta: {
              ui: {
                prefersBorder: false,
                ...(view.id === "speaking" ? { permissions: { microphone: {} } } : {}),
              },
            },
          },
        ],
      }),
    );
  }
}

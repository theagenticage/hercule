/**
 * The GitHub plugin: the GitHub connection type, the event source that polls
 * GitHub for what changed, and the workflow actions that act on GitHub.
 */
import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerConnectionType,
  registerEventSource,
  registerWorkflowAction,
  type EventSourceContribution,
  type Plugin,
} from "@hercule/plugin-host";
import { GITHUB_WORKFLOW_ACTIONS } from "./actions";
import { connectionType, GITHUB_CONNECTION_TYPE } from "./connection-type";
import { openGithubIngest } from "./ingest";
import { GITHUB_EVENT_KINDS } from "./kinds";
import { GITHUB_SIGNAL_KINDS } from "./signal-kinds";

/**
 * The GitHub mark, path data only, on the 16x16 grid a plugin's mark uses. It
 * is the desktop app's GitHub mark (Simple Icons, CC0), drawn on a 24-unit
 * grid there, with every coordinate scaled by 2/3 and rounded to six
 * decimals, so it draws the same pixels as the original.
 */
const GITHUB_MARK_PATH =
  "M8 .198c-4.42 0-8 3.582-8 8 0 3.535333 2.292 6.533333 5.47 7.59.4.075333.546667-.172.546667-.384667 0-.19-.006667-.693333-.01-1.36-2.225333.482667-2.694667-1.073333-2.694667-1.073333C2.948 12.046667 2.422 11.8 2.422 11.8c-.724667-.496.056-.486.056-.486 .803333.056 1.225333 .824 1.225333 .824 .713333 1.223333 1.872667 .87 2.33.665333.072-.517333.278-.87.506667-1.07-1.776667-.2-3.644-.888-3.644-3.953333 0-.873333.31-1.586667 .823333-2.146667-.09-.202-.36-1.015333.07-2.117333 0 0 .67-.214667 2.2 .82.64-.178 1.32-.266 2-.27 .68.004 1.36.092 2 .27 1.52-1.034667 2.19-.82 2.19-.82.43 1.102.16 1.915333.08 2.117333.51.56 .82 1.273333 .82 2.146667 0 3.073333-1.87 3.75-3.65 3.946667.28.24.54 .730667.54 1.48 0 1.070667-.01 1.930667-.01 2.190667 0 .21.14.46.55.38C13.71 14.728 16 11.728 16 8.198c0-4.418-3.582-8-8-8";

/**
 * The unqualified id, which the host prefixes to make `github/github`.
 *
 * The default intervals are spec 08 section 5.1's. The floors are this
 * plugin's: the notifications feed may not go below its default because
 * GitHub's `X-Poll-Interval` is 60 seconds, and the other two stay well
 * inside the hourly quota at their floor.
 */
const eventSource: EventSourceContribution = {
  id: "github",
  connectionType: GITHUB_CONNECTION_TYPE,
  kinds: GITHUB_EVENT_KINDS,
  feeds: {
    notifications: { defaultIntervalSeconds: 60 },
    repos: { defaultIntervalSeconds: 120, minIntervalSeconds: 60 },
    checks: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
  },
  signalKinds: GITHUB_SIGNAL_KINDS,
  open: openGithubIngest,
};

export const github: Plugin = {
  manifest: {
    id: "github",
    displayName: "GitHub",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources", "events", "resources", "workflow-actions"],
    configSchema: Schema.Struct({}),
    mark: { paths: [GITHUB_MARK_PATH] },
  },
  register: (host) =>
    Effect.gen(function* () {
      yield* registerConnectionType(host, connectionType);
      yield* registerEventSource(host, eventSource);
      for (const action of GITHUB_WORKFLOW_ACTIONS) yield* registerWorkflowAction(host, action);
    }),
  // The host opens and polls the ingest handles itself, so there is nothing
  // for the plugin to start.
  activate: () => Effect.succeed(Effect.void),
};

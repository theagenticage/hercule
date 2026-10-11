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
 * grid there, with every coordinate scaled by 2/3 and rounded to three
 * decimals.
 */
const GITHUB_MARK_PATH =
  "M8 .198c-4.42 0-8 3.582-8 8 0 3.535 2.292 6.533 5.47 7.59 .4 .075 .547-.172 .547-.385 0-.19-.007-.693-.01-1.36-2.225 .483-2.695-1.073-2.695-1.073C2.948 12.047 2.422 11.8 2.422 11.8c-.725-.496 .056-.486 .056-.486 .803 .056 1.225 .824 1.225 .824 .713 1.223 1.873 .87 2.33 .665 .072-.517 .278-.87 .507-1.07-1.777-.2-3.644-.888-3.644-3.953 0-.873 .31-1.587 .823-2.147-.09-.202-.36-1.015 .07-2.117 0 0 .67-.215 2.2 .82 .64-.178 1.32-.266 2-.27 .68 .004 1.36 .092 2 .27 1.52-1.035 2.19-.82 2.19-.82 .43 1.102 .16 1.915 .08 2.117 .51 .56 .82 1.273 .82 2.147 0 3.073-1.87 3.75-3.65 3.947 .28 .24 .54 .731 .54 1.48 0 1.071-.01 1.931-.01 2.191 0 .21 .14 .46 .55 .38C13.71 14.728 16 11.728 16 8.198c0-4.418-3.582-8-8-8";

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

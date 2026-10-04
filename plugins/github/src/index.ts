/**
 * The GitHub plugin: the GitHub connection type, the event source that polls
 * GitHub for what changed, and the workflow actions that act on GitHub.
 */
import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerConnectionType,
  registerEventSource,
  type EventSourceContribution,
  type Plugin,
} from "@hercule/plugin-host";
import { connectionType } from "./connection-type";
import { openGithubIngest } from "./ingest";
import { GITHUB_EVENT_KINDS } from "./kinds";

/**
 * The unqualified id, which the host prefixes to make `github/github`. The
 * feed intervals are spec 08 section 5.1's defaults.
 */
const eventSource: EventSourceContribution = {
  id: "github",
  connectionType: "github/github",
  kinds: GITHUB_EVENT_KINDS,
  feeds: {
    notifications: { defaultIntervalSeconds: 60 },
    repos: { defaultIntervalSeconds: 120, minIntervalSeconds: 60 },
    checks: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
  },
  open: openGithubIngest,
};

export const github: Plugin = {
  manifest: {
    id: "github",
    displayName: "GitHub",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    Effect.andThen(
      registerConnectionType(host, connectionType),
      registerEventSource(host, eventSource),
    ),
  // The host opens and polls the ingest handles itself, so there is nothing
  // for the plugin to start.
  activate: () => Effect.succeed(Effect.void),
};

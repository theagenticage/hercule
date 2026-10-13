/**
 * The Linear plugin: the Linear connection type, and the event source that
 * polls Linear for the issues the user watches and for their inbox.
 */
import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerConnectionType,
  registerEventSource,
  type EventSourceContribution,
  type Plugin,
} from "@hercule/plugin-host";
import { connectionType, LINEAR_CONNECTION_TYPE } from "./connection-type";
import { openLinearIngest } from "./ingest";
import { LINEAR_EVENT_KINDS } from "./kinds";
import { LINEAR_SIGNAL_KINDS } from "./signal-kinds";

/**
 * A geometric mark drawn for Hercule, path data only, on the 16x16 grid a
 * plugin's mark uses: a square standing on one corner, with a smaller square
 * hole. It is not Linear's logo. The outer square runs clockwise and the inner
 * one counter-clockwise, so a nonzero fill leaves the hole open.
 */
const LINEAR_MARK_PATH = "M8 1 15 8 8 15 1 8Z M8 5 5 8 8 11 11 8Z";

/**
 * The unqualified id, which the host prefixes to make `linear/linear`. Both
 * feeds poll a minute apart by default and may not go below 30 seconds,
 * which keeps a Connection well inside Linear's hourly limits.
 */
const eventSource: EventSourceContribution = {
  id: "linear",
  connectionType: LINEAR_CONNECTION_TYPE,
  kinds: LINEAR_EVENT_KINDS,
  feeds: {
    issues: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
    notifications: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
  },
  signalKinds: LINEAR_SIGNAL_KINDS,
  open: openLinearIngest,
};

export const linear: Plugin = {
  manifest: {
    id: "linear",
    displayName: "Linear",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources", "events"],
    configSchema: Schema.Struct({}),
    mark: { paths: [LINEAR_MARK_PATH] },
  },
  register: (host) =>
    Effect.gen(function* () {
      yield* registerConnectionType(host, connectionType);
      yield* registerEventSource(host, eventSource);
    }),
  // The host opens and polls the ingest handles itself, so there is nothing
  // for the plugin to start.
  activate: () => Effect.succeed(Effect.void),
};

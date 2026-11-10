/**
 * The Linear plugin: the Linear connection type, and the event source that
 * polls Linear for the issues the user watches, for their inbox and for the
 * issues assigned to them.
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
import { LINEAR_ENTITY_KINDS } from "./entity-kinds";
import { linearEntityLookup } from "./entity-lookup";
import { openLinearIngest } from "./ingest";
import { LINEAR_EVENT_KINDS } from "./kinds";
import { LINEAR_SIGNAL_KINDS } from "./signal-kinds";

/**
 * The Linear mark, path data only, on the 16x16 grid a plugin's mark uses. It
 * is Simple Icons' Linear mark (CC0), drawn on a 24-unit grid there, with
 * every coordinate scaled by 2/3 and rounded to six decimals, so it draws the
 * same pixels as the original.
 */
const LINEAR_MARK_PATH =
  "M1.924 2.786667A7.988 7.988 0 0 1 7.993333 0C12.416 0 16 3.584 16 8.006c0 2.426667-1.08 4.602-2.786667 6.07L1.924667 2.786667ZM1.211333 3.750667l11.037333 11.037333c-.349333.22-.716667.413333-1.1.577333L.634 4.851333c.164667-.383333.358-.750667.577333-1.1ZM.214667 6.108667l9.676667 9.676667c-.473333.114667-.962.188-1.463333.214667L0 7.572a8 8 0 0 1 .214667-1.463333Zm-.113333 3.241333 6.548667 6.549333a8.013333 8.013333 0 0 1-6.549333-6.549333Z";

/**
 * The unqualified id, which the host prefixes to make `linear/linear`. The
 * `issues` and `notifications` feeds poll a minute apart by default and may
 * not go below 30 seconds; the `entities` feed polls every two minutes and
 * may not go below one. That keeps a Connection well inside Linear's hourly
 * limits.
 */
const eventSource: EventSourceContribution = {
  id: "linear",
  connectionType: LINEAR_CONNECTION_TYPE,
  kinds: LINEAR_EVENT_KINDS,
  feeds: {
    issues: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
    notifications: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
    entities: { defaultIntervalSeconds: 120, minIntervalSeconds: 60 },
  },
  signalKinds: LINEAR_SIGNAL_KINDS,
  entityKinds: LINEAR_ENTITY_KINDS,
  entityLookup: linearEntityLookup,
  open: openLinearIngest,
};

export const linear: Plugin = {
  manifest: {
    id: "linear",
    displayName: "Linear",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources", "events", "entities"],
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

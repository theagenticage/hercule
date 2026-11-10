/**
 * The Sentry plugin: the Sentry connection type, the event source that polls
 * Sentry for issues entering, leaving and changing, and the workflow actions
 * that resolve, archive and assign an issue.
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
import { SENTRY_WORKFLOW_ACTIONS } from "./actions";
import { connectionType, SENTRY_CONNECTION_TYPE } from "./connection-type";
import { openSentryIngest } from "./ingest";
import { SENTRY_EVENT_KINDS } from "./kinds";
import { SENTRY_SIGNAL_KINDS } from "./signal-kinds";

/**
 * The Sentry mark, path data only, on the 16x16 grid a plugin's mark uses. It
 * is Simple Icons' Sentry mark (CC0), drawn on a 24-unit grid there, with
 * every coordinate scaled by 2/3 and rounded to six decimals, so it draws the
 * same pixels as the original.
 */
const SENTRY_MARK_PATH =
  "M9.273333 1.67c-.582-.965333-1.981333-.965333-2.562667 0L4.602667 5.28a10.318667 10.318667 0 0 1 5.686667 8.540667h-1.480667A8.867333 8.867333 0 0 0 3.856 6.542667l-1.950667 3.373333a5.1 5.1 0 0 1 2.956667 3.898667H1.462667a.243333 .243333 0 0 1-.198667-.356l.942-1.601333a3.44 3.44 0 0 0-1.076-.608667L.197333 12.85a1.454667 1.454667 0 0 0 .541333 1.999333 1.493333 1.493333 0 0 0 .724.192h4.655333a6.214667 6.214667 0 0 0-2.563333-5.545333l.74-1.281333a7.646667 7.646667 0 0 1 3.3 6.826667h3.943333a11.494667 11.494667 0 0 0-5.256667-10.186667l1.496-2.563333a.246667 .246667 0 0 1 .336-.086667c.17.093333 6.5 11.138667 6.618667 11.266667a.243333 .243333 0 0 1-.218.362h-1.524667c.019333.408.019333.815333 0 1.220667h1.531333a1.470667 1.470667 0 0 0 1.281333-2.206667z";

/**
 * The unqualified id, which the host prefixes to make `sentry/sentry`. The
 * `issues` feed polls a minute apart by default and may not go below 30
 * seconds, which keeps a Connection well inside Sentry's rate limits.
 */
const eventSource: EventSourceContribution = {
  id: "sentry",
  connectionType: SENTRY_CONNECTION_TYPE,
  kinds: SENTRY_EVENT_KINDS,
  feeds: {
    issues: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
  },
  signalKinds: SENTRY_SIGNAL_KINDS,
  open: openSentryIngest,
};

export const sentry: Plugin = {
  manifest: {
    id: "sentry",
    displayName: "Sentry",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources", "events", "workflow-actions"],
    configSchema: Schema.Struct({}),
    mark: { paths: [SENTRY_MARK_PATH] },
  },
  register: (host) =>
    Effect.gen(function* () {
      yield* registerConnectionType(host, connectionType);
      yield* registerEventSource(host, eventSource);
      for (const action of SENTRY_WORKFLOW_ACTIONS) yield* registerWorkflowAction(host, action);
    }),
  // The host opens and polls the ingest handles itself, so there is nothing
  // for the plugin to start.
  activate: () => Effect.succeed(Effect.void),
};

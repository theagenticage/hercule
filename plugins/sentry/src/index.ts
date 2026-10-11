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
 * A geometric mark drawn for Hercule, path data only, on the 16x16 grid a
 * plugin's mark uses: a triangle with a triangular hole. It is not Sentry's
 * logo. The outer triangle runs clockwise and the inner one counter-clockwise,
 * so a nonzero fill leaves the hole open.
 */
const SENTRY_MARK_PATH = "M8 1.5 15 14H1Z M8 6 5.2 11.5H10.8Z";

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

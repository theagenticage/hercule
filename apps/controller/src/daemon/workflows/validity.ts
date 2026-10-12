import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { AgentObserver } from "../../agents";
import { ConnectionObserver } from "../../connections";
import { type AuditLog, EventKindsLayer } from "../../events";
import type { Notifier } from "../../notifications";
import { EventKindCatalogLayer, PluginObserver, type PluginHost } from "../../plugins";
import { WorkflowValidity, WorkflowValidityLayer } from "../../workflows";
import { absorbFailures } from "../absorbing";

/**
 * Validates every stored workflow again and logs a failure instead of
 * returning it. The ports are called after their change has committed, so
 * the change must still answer as done. A mark this misses is set right at
 * the next change or the next start.
 */
const revalidate = (validity: WorkflowValidity["Service"]): Effect.Effect<void> =>
  absorbFailures(
    "The stored workflows could not be validated again after a change",
    validity.revalidateStoredWorkflows(),
  );

/**
 * Validates every stored workflow again as a step of the boot, and logs a
 * failure instead of returning it. The step runs after the plugins start,
 * because a plugin may have changed while the controller was stopped. A
 * failure must not keep the controller from starting: the marks it missed
 * are set at the next change to a plugin, Agent or Connection, or the next
 * start, and `run.start` validates a workflow again in any case.
 */
export const revalidateStoredWorkflowsOrLog: Effect.Effect<void, never, WorkflowValidity> =
  Effect.flatMap(WorkflowValidity, (validity) =>
    absorbFailures(
      "The stored workflows could not be validated again at start",
      validity.revalidateStoredWorkflows(),
    ),
  );

/**
 * Provides the plugins, agents and connections domains' observer ports from
 * the workflows domain's `WorkflowValidity`, and the validity service itself
 * for the boot step that validates every stored workflow once the plugins
 * have started. It lives in the controller daemon because the workflows
 * domain depends on all three domains, so none of them can reach it without
 * a cycle.
 *
 * Every port validates every stored workflow again, not only those that name
 * the changed plugin, agent or Connection. Finding those would repeat what
 * validation already reads, and validating all of them is one in-memory pass
 * per workflow plus a few indexed reads.
 */
export const WorkflowValidityObserversLayer: Layer.Layer<
  PluginObserver | AgentObserver | ConnectionObserver | WorkflowValidity,
  never,
  SqlClient.SqlClient | AuditLog | Notifier | PluginHost
> = Layer.mergeAll(
  Layer.effect(PluginObserver)(
    Effect.map(WorkflowValidity, (validity) => ({
      pluginStatusChanged: () => revalidate(validity),
    })),
  ),
  Layer.effect(AgentObserver)(
    Effect.map(WorkflowValidity, (validity) => ({
      agentDeleted: () => revalidate(validity),
    })),
  ),
  Layer.effect(ConnectionObserver)(
    Effect.map(WorkflowValidity, (validity) => ({
      connectionDeleted: () => revalidate(validity),
    })),
  ),
).pipe(
  Layer.provideMerge(
    WorkflowValidityLayer.pipe(
      Layer.provide(EventKindsLayer.pipe(Layer.provide(EventKindCatalogLayer))),
    ),
  ),
);

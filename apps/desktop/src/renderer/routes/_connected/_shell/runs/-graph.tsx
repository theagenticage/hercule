import { useMemo, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { buildGraphDrawing, buildRunOverlay } from "@hercule/client-core/graph-model";
import { buildRunNodeCard } from "@hercule/client-core/node-details";
import type { Run, Session, Workflow } from "@hercule/contract";
import {
  agentsQuery,
  pluginsQuery,
  providerAccountsQuery,
  triggersQuery,
  workflowActionsQuery,
} from "../../../../app/queries";
import { WorkflowGraph } from "../../../../screens/workflows/workflow-graph";

/**
 * Reads and draws `run`'s steps as a graph, with where the run is at each
 * node and edge, and a node's card on a click. `sessions` are the run's
 * sessions. `workflow` is the run's workflow, or `undefined` while it is not
 * read yet or after it was deleted; a start trigger's card shows when it
 * fires next only while the workflow is enabled and valid. Open thread on a
 * card calls `onOpenSession`.
 *
 * The route's loader reads the triggers, the Provider Accounts, the
 * plugins, the Agents and the workflow actions.
 */
export function RunGraph({
  client,
  run,
  sessions,
  workflow,
  timezone,
  onOpenSession,
}: {
  readonly client: HerculeClient;
  readonly run: Run;
  readonly sessions: ReadonlyArray<Session>;
  readonly workflow: Pick<Workflow, "enabled" | "invalidSince"> | undefined;
  readonly timezone: string;
  readonly onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const { data: everyTrigger } = useSuspenseQuery(triggersQuery(client));
  const { data: accounts } = useSuspenseQuery(providerAccountsQuery(client));
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { data: agents } = useSuspenseQuery(agentsQuery(client));
  const { data: actions } = useSuspenseQuery(workflowActionsQuery(client));
  // A push of the run keeps `run.plan` the same object, so the graph is not
  // laid out again while the run goes on.
  const drawing = useMemo(
    () => buildGraphDrawing(run.plan, agents, actions),
    [run.plan, agents, actions],
  );
  const overlay = buildRunOverlay(drawing, run, sessions);
  const triggers = everyTrigger.filter((trigger) => trigger.workflowId === run.workflowId);
  return (
    <WorkflowGraph
      drawing={drawing}
      readCard={(nodeId) =>
        buildRunNodeCard(nodeId, {
          triggers,
          agents,
          actions,
          accounts,
          workflow,
          run,
          sessions,
          overlay,
        })
      }
      overlay={overlay}
      plugins={plugins}
      timezone={timezone}
      label={`The steps of ${run.plan.name}`}
      onOpenSession={onOpenSession}
    />
  );
}

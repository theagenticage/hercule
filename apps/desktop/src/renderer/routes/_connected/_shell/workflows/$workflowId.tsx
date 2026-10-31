import { useEffect, useId, useRef, useState, type JSX } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  isNotFound,
  parseWorkflowSourceWithRanges,
  resolveDisplayTimezone,
} from "@hercule/client-core";
import { buildGraphDrawing } from "@hercule/client-core/graph-model";
import { buildNodeCard } from "@hercule/client-core/node-details";
import { computeTimelineDay } from "@hercule/client-core/run-timeline";
import { MAX_TIMELINE_DAYS_BACK } from "@hercule/client-core/timeline-limit";
import { buildWorkflowChips } from "@hercule/client-core/workflow-detail-rows";
import { throwScreenNotFound } from "../../../../app/last-screen";
import {
  agentsQuery,
  pluginsQuery,
  providerAccountsQuery,
  readOnOpen,
  settingsQuery,
  triggersQuery,
  workflowActionsQuery,
  workflowDayRunsQuery,
  workflowQuery,
  workflowRunsQuery,
} from "../../../../app/queries";
import { readFullSearch } from "../../../../screens/list-pane/list-with-open-pane";
import { NotFound } from "../../../../screens/not-found";
import { WorkflowLead } from "../../../../screens/workflows/workflow-detail";
import { WorkflowGraph } from "../../../../screens/workflows/workflow-graph";
import { useTriggerSwitches, useWorkflowSwitch } from "./-switches";
import { WorkflowTabs } from "./-tabs";

/**
 * The search params of an open workflow (spec 17 §Workflows, "The routes"):
 *
 * - `full`: the open workflow fills the pane, and the list is hidden;
 * - `runsView`: the Runs tab shows its runs on a timeline; without it, as a
 *   list;
 * - `daysBack`: the day the timeline shows, counted back from today; without
 *   it, today.
 */
interface WorkflowSearch {
  readonly full?: true | undefined;
  readonly runsView?: "timeline" | undefined;
  readonly daysBack?: number | undefined;
}

/**
 * Returns an open workflow's search params from the URL's. A param with any
 * other value is dropped, so the page shows its default: a `full` that is
 * not `true`, a `runsView` that is not `timeline`, and a `daysBack` that is
 * not a whole number from 1 to `MAX_TIMELINE_DAYS_BACK`, the oldest day the
 * timeline shows.
 *
 * A dropped param is returned as `undefined` rather than left out, because
 * the router lays the returned params over the URL's: a param left out
 * would keep the URL's value.
 */
const validateWorkflowSearch = (search: Record<string, unknown>): WorkflowSearch => ({
  full: readFullSearch(search),
  runsView: search.runsView === "timeline" ? "timeline" : undefined,
  daysBack:
    Number.isSafeInteger(search.daysBack) &&
    (search.daysBack as number) > 0 &&
    (search.daysBack as number) <= MAX_TIMELINE_DAYS_BACK
      ? (search.daysBack as number)
      : undefined,
});

/**
 * An open workflow (spec 17 §Workflows, "The open workflow"). A row of the
 * workflow list links here, and its row is selected while the workflow is
 * open.
 *
 * Its loader reads everything the page draws before it renders:
 *
 * - the workflow, whose source is parsed here to draw the lead, the graph
 *   and the tabs; when no workflow has the id, the route shows
 *   `WorkflowNotFound`;
 * - the Agents and the workflow actions, which name the graph's steps, read
 *   each time a workflow opens because no topic covers them;
 * - the Runs tab's first page of runs, or the day its timeline shows.
 *
 * The triggers, the settings, the plugins and the Provider Accounts are
 * read by the Workflows layout and the shell, and are cached already.
 * Stepping the day or switching the view runs the loader again, with
 * `cause` "stay", and reads only the runs it has not read.
 *
 * Opening another workflow from an open one runs the loader with `cause`
 * "stay" too: the router tells only whether this route was already open, not
 * whether its workflow changed. So the loader reads the Agents and the
 * workflow actions again only when the route opens, and `OpenWorkflowRoute`
 * reads them again when the workflow changes under it.
 */
export const Route = createFileRoute("/_connected/_shell/workflows/$workflowId")({
  staticData: { title: "Workflows" },
  validateSearch: validateWorkflowSearch,
  loaderDeps: ({ search }) => ({ runsView: search.runsView, daysBack: search.daysBack ?? 0 }),
  loader: async ({
    context: { controller, queryClient },
    params: { workflowId },
    deps: { runsView, daysBack },
    location,
    cause,
  }) => {
    const { client } = controller;
    const readRuns = async (): Promise<unknown> => {
      if (runsView !== "timeline") {
        return queryClient.ensureInfiniteQueryData(workflowRunsQuery(client, workflowId));
      }
      const settings = await queryClient.ensureQueryData(settingsQuery(client));
      const timezone = resolveDisplayTimezone(settings.user.timezone);
      const day = computeTimelineDay(new Date(), daysBack, timezone);
      return queryClient.ensureQueryData(workflowDayRunsQuery(client, workflowId, day));
    };
    try {
      await Promise.all([
        queryClient.ensureQueryData(workflowQuery(client, workflowId)),
        queryClient.ensureQueryData(triggersQuery(client)),
        queryClient.ensureQueryData(providerAccountsQuery(client)),
        cause === "stay"
          ? queryClient.ensureQueryData(agentsQuery(client))
          : readOnOpen(queryClient, agentsQuery(client)),
        cause === "stay"
          ? queryClient.ensureQueryData(workflowActionsQuery(client))
          : readOnOpen(queryClient, workflowActionsQuery(client)),
        readRuns(),
      ]);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      throwScreenNotFound(location);
    }
  },
  component: OpenWorkflowRoute,
  notFoundComponent: WorkflowNotFound,
});

/** Renders the screen of a workflow that does not exist, with a link back to the list. */
function WorkflowNotFound(): JSX.Element {
  return (
    <NotFound headline="This workflow was not found.">
      <Link to="/workflows" className="btn btn--accent">
        Workflows
      </Link>
    </NotFound>
  );
}

/**
 * Draws the open workflow afresh for each workflow, so it opens on the Runs
 * tab and settles in again. Widening it to fill the pane keeps it.
 *
 * When another workflow opens from this one, it reads the Agents and the
 * workflow actions again, as the loader does when the route opens (see
 * `Route`). The page draws with the cached ones meanwhile, and draws again
 * when the reads answer.
 */
function OpenWorkflowRoute(): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { client } = controller;
  const queryClient = useQueryClient();
  const { workflowId } = Route.useParams();
  const shownWorkflowId = useRef(workflowId);
  useEffect(() => {
    if (shownWorkflowId.current === workflowId) return;
    shownWorkflowId.current = workflowId;
    void readOnOpen(queryClient, agentsQuery(client));
    void readOnOpen(queryClient, workflowActionsQuery(client));
  }, [client, queryClient, workflowId]);
  return <OpenWorkflow key={workflowId} workflowId={workflowId} />;
}

/**
 * Reads the open workflow and draws it: the lead with its switch, the graph,
 * and the four tabs. It saves the workflow's switch and its triggers' pause
 * switches. When the workflow is deleted while it is open, it shows
 * `WorkflowNotFound`: the `workflow` push reads it again, and the read fails
 * as not found while the cache still holds the workflow.
 */
function OpenWorkflow({ workflowId }: { readonly workflowId: string }): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { client } = controller;
  const search = Route.useSearch();
  const runsView = search.runsView ?? "list";
  const daysBack = search.daysBack ?? 0;

  const { data: workflow, error } = useSuspenseQuery(workflowQuery(client, workflowId));
  const { data: everyTrigger } = useSuspenseQuery(triggersQuery(client));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const { data: agents } = useSuspenseQuery(agentsQuery(client));
  const { data: actions } = useSuspenseQuery(workflowActionsQuery(client));
  const { data: accounts } = useSuspenseQuery(providerAccountsQuery(client));
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);

  const enabled = useWorkflowSwitch(client, workflow);
  const switches = useTriggerSwitches(
    client,
    workflowId,
    everyTrigger.filter((trigger) => trigger.workflowId === workflowId),
  );
  const { triggers } = switches;
  const headingId = useId();
  // The pane is kept in state, not in a ref, so the Runs list draws again
  // once the pane is mounted. React sets a parent's ref only after its
  // children's layout effects ran, so the list's virtualizer would find no
  // pane to measure on its first render, and nothing would make it look again.
  const [pane, setPane] = useState<HTMLElement | null>(null);

  if (isNotFound(error)) return <WorkflowNotFound />;
  const { definition } = parseWorkflowSourceWithRanges(workflow.source);
  if (definition === undefined) {
    // The controller saves only a source that parses, so this is a bug.
    throw new Error(`The saved source of the workflow "${workflowId}" does not parse.`);
  }
  // The workflow with its switch's value, so what it shows follows a toggle
  // before the save answers.
  const shownWorkflow = { ...workflow, enabled: enabled.value };

  return (
    <section ref={setPane} className="open-pane" aria-labelledby={headingId}>
      <div className="pill-room" />
      <WorkflowLead
        headingId={headingId}
        name={definition.name}
        description={definition.description}
        isEnabled={enabled.value}
        error={enabled.error}
        chips={buildWorkflowChips(definition, shownWorkflow, triggers)}
        timezone={timezone}
        onToggle={() => {
          enabled.save(!enabled.value);
        }}
      />
      <WorkflowGraph
        drawing={buildGraphDrawing(definition, agents, actions)}
        readCard={(nodeId) =>
          buildNodeCard(definition, nodeId, {
            triggers,
            agents,
            actions,
            accounts,
            workflow: shownWorkflow,
          })
        }
        plugins={plugins}
        timezone={timezone}
        label={`The steps of ${definition.name}`}
      />
      <WorkflowTabs
        client={client}
        workflowId={workflowId}
        source={workflow.source}
        definition={definition}
        workflow={shownWorkflow}
        switches={switches}
        runsView={runsView}
        daysBack={daysBack}
        timezone={timezone}
        pane={pane}
      />
    </section>
  );
}

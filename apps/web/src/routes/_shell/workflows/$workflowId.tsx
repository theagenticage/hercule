import type { JSX } from "react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { isNotFound } from "@hercule/client-core";
import { EmptyState } from "@hercule/ui";
import { useLiveInvalidation } from "../../../app/live-invalidation";
import { workflowQuery } from "../../../app/queries";
import { prefetchWorkflowCatalog } from "./-catalog";
import { WorkflowEditorPage } from "./-page";
import { validateWorkflowViewSearch } from "./-view";

export const Route = createFileRoute("/_shell/workflows/$workflowId")({
  // The page's own header names the workflow, so the shell's bar stands down.
  staticData: { title: "Workflow", ownsTopBar: true },
  validateSearch: validateWorkflowViewSearch,
  // The workflow and the catalogs that the editor completes from are read
  // before it shows.
  loader: async ({ context: { client, queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(workflowQuery(client, params.workflowId)).catch((error) => {
        // A link to a workflow that was deleted, as from the history or a
        // bookmark, says so. It does not say that the screen failed.
        throw isNotFound(error) ? notFound() : error;
      }),
      prefetchWorkflowCatalog(client, queryClient),
    ]);
  },
  component: StoredWorkflow,
  notFoundComponent: DeletedWorkflow,
});

/** A stored workflow, written from its source as it is stored. */
function StoredWorkflow(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const { workflowId } = Route.useParams();
  const navigate = Route.useNavigate();
  const { view } = Route.useSearch();

  useLiveInvalidation(live, queryClient, "workflow");

  const read = useSuspenseQuery(workflowQuery(client, workflowId));
  // A workflow deleted elsewhere answers not_found when it is read again. The
  // read keeps the workflow it had, so the page keeps the author's text and
  // says that the workflow is gone.
  const isGone = isNotFound(read.error);

  return (
    <WorkflowEditorPage
      // Each workflow has a page of its own: nothing that one workflow's
      // page holds, such as the marks in its text or the undo history,
      // carries over to the next.
      key={workflowId}
      client={client}
      live={live}
      stored={read.data}
      isGone={isGone}
      view={view}
      onViewChange={(next) => void navigate({ search: { view: next }, replace: true })}
    />
  );
}

/** The page of a workflow that the controller does not have. */
function DeletedWorkflow(): JSX.Element {
  return (
    <EmptyState headline="This workflow was deleted.">
      <Link
        to="/workflows"
        className="self-start text-row text-muted underline underline-offset-2 hover:text-ink"
      >
        Go to Workflows
      </Link>
    </EmptyState>
  );
}

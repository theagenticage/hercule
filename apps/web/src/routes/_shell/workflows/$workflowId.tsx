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
  // The page draws its own header with the workflow's name, so the shell
  // hides its top bar.
  staticData: { title: "Workflow", ownsTopBar: true },
  validateSearch: validateWorkflowViewSearch,
  // Loads the workflow and the editor's autocomplete data before the page
  // renders, so the page never waits on them.
  loader: async ({ context: { client, queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(workflowQuery(client, params.workflowId)).catch((error) => {
        // A link to a deleted workflow, for example from the browser history
        // or a bookmark, shows that the workflow was deleted instead of a
        // load error.
        throw isNotFound(error) ? notFound() : error;
      }),
      prefetchWorkflowCatalog(client, queryClient),
    ]);
  },
  component: StoredWorkflow,
  notFoundComponent: DeletedWorkflow,
});

/** Renders the editor page for a saved workflow. */
function StoredWorkflow(): JSX.Element {
  const { client, queryClient, live } = Route.useRouteContext();
  const { workflowId } = Route.useParams();
  const navigate = Route.useNavigate();
  const { view } = Route.useSearch();

  useLiveInvalidation(live, queryClient, "workflow");

  const read = useSuspenseQuery(workflowQuery(client, workflowId));
  // If another client deletes the workflow, the next refetch fails with
  // not_found. The query keeps its last data, so the page keeps the user's
  // text and shows that the workflow is gone.
  const isGone = isNotFound(read.error);

  return (
    <WorkflowEditorPage
      // Keyed by id, so moving to another workflow mounts a fresh page.
      // Otherwise state such as the error marks and the undo history would
      // carry over from the previous workflow.
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

/** Renders the page for a workflow id that the controller does not have. */
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

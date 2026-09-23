import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { prefetchWorkflowCatalog } from "./-catalog";
import { WorkflowEditorPage } from "./-page";
import { validateWorkflowViewSearch } from "./-view";

export const Route = createFileRoute("/_shell/workflows/new")({
  // The page's own header names the workflow, so the shell's bar stands down.
  staticData: { title: "New workflow", ownsTopBar: true },
  validateSearch: validateWorkflowViewSearch,
  // The catalogs that the editor completes from are read before it shows.
  loader: ({ context: { client, queryClient } }) => prefetchWorkflowCatalog(client, queryClient),
  component: NewWorkflow,
});

/** A workflow that is not stored yet, written from the starter source. */
function NewWorkflow(): JSX.Element {
  const { client, live } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  const { view } = Route.useSearch();

  return (
    <WorkflowEditorPage
      client={client}
      live={live}
      stored={undefined}
      isGone={false}
      view={view}
      onViewChange={(next) => void navigate({ search: { view: next }, replace: true })}
    />
  );
}

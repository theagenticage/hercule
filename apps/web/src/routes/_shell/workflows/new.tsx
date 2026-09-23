import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { prefetchWorkflowCatalog } from "./-catalog";
import { WorkflowEditorPage } from "./-page";
import { validateWorkflowViewSearch } from "./-view";

export const Route = createFileRoute("/_shell/workflows/new")({
  // The page draws its own header with the workflow's name, so the shell
  // hides its top bar.
  staticData: { title: "New workflow", ownsTopBar: true },
  validateSearch: validateWorkflowViewSearch,
  // Loads the editor's autocomplete data before the page renders.
  loader: ({ context: { client, queryClient } }) => prefetchWorkflowCatalog(client, queryClient),
  component: NewWorkflow,
});

/** Renders the editor page for a new workflow, starting from the starter source. */
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

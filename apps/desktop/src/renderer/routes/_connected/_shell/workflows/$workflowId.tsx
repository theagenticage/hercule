import { createFileRoute } from "@tanstack/react-router";

/**
 * An open workflow (spec 17 §Workflows, "The open workflow"). A row of the
 * workflow list links here, and its row is selected while the workflow is
 * open. The route renders nothing, so the list stays as it is: the open
 * workflow's page is a ticket of its own (#551).
 */
export const Route = createFileRoute("/_connected/_shell/workflows/$workflowId")({
  staticData: { title: "Workflows" },
  component: () => null,
});

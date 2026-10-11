import { createFileRoute } from "@tanstack/react-router";

/**
 * An open workflow (spec 17 §Workflows, "The open workflow"). A row of the
 * workflow list links here, and its row is selected while the workflow is
 * open. The page itself is not drawn yet, so the route renders nothing and
 * the list stays as it is.
 */
export const Route = createFileRoute("/_connected/_shell/workflows/$workflowId")({
  staticData: { title: "Workflows" },
  component: () => null,
});

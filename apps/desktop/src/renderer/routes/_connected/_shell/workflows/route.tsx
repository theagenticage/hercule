import { createFileRoute } from "@tanstack/react-router";

/**
 * Workflows: the layout route of the workflow list (spec 17 §Workflows).
 *
 * Go › Workflows and the Hercule face's Workflows row lead here. The list
 * itself is not drawn yet, so the route renders nothing.
 */
export const Route = createFileRoute("/_connected/_shell/workflows")({
  staticData: { title: "Workflows" },
  component: () => null,
});

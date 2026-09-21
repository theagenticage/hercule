import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hercule/ui";

export const Route = createFileRoute("/_shell/workflows")({
  staticData: { title: "Workflows" },
  component: Workflows,
});

function Workflows(): JSX.Element {
  return (
    <EmptyState
      headline="No workflows yet."
      lead="A workflow is a stored recipe written as YAML: what starts it, the steps it runs, and where they run. Triggers make it standing work."
    />
  );
}

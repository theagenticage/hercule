import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hercule/ui";

export const Route = createFileRoute("/_shell/runs")({
  staticData: { title: "Runs" },
  component: Runs,
});

function Runs(): JSX.Element {
  return (
    <EmptyState
      headline="No runs yet."
      lead="A run is one execution of a workflow. Runs appear here when a trigger fires or you start one by hand."
    />
  );
}

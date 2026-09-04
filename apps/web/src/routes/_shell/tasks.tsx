import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hydra/ui";

export const Route = createFileRoute("/_shell/tasks")({
  staticData: { title: "Tasks" },
  component: Tasks,
});

function Tasks(): JSX.Element {
  return (
    <EmptyState
      headline="No tasks yet."
      lead="Triage proposes tasks from what comes in, and you can add one by hand. A task is intent; a run or a thread does the work."
    />
  );
}

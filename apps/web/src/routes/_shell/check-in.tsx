import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hydra/ui";

export const Route = createFileRoute("/_shell/check-in")({
  staticData: { title: "Check-in" },
  component: CheckIn,
});

function CheckIn(): JSX.Element {
  return (
    <EmptyState
      headline="Nothing in motion yet."
      lead="Check-in is where you see what happened since you last looked: decisions waiting on you, work in progress, and what finished. Start a thread or let a workflow run and it fills in."
      fine="Everything on this screen comes from threads and workflows you start."
    />
  );
}

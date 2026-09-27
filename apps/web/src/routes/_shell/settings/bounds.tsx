import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hercule/ui";

export const Route = createFileRoute("/_shell/settings/bounds")({
  staticData: { title: "Bounds" },
  component: Bounds,
});

function Bounds(): JSX.Element {
  return (
    <EmptyState
      className="mt-0"
      headline="No trigger has a bound to show yet."
      lead="A spawn bound caps how often a trigger may start runs. Every workflow trigger is listed here with its bound, its current window, and whether it is paused."
    />
  );
}

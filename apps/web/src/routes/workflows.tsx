import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/workflows")({
  staticData: { title: "Workflows" },
  component: Workflows,
});

function Workflows(): JSX.Element {
  return <h1>Workflows</h1>;
}

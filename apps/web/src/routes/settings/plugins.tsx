import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/plugins")({
  staticData: { title: "Plugins" },
  component: Plugins,
});

function Plugins(): JSX.Element {
  return <h1>Plugins</h1>;
}

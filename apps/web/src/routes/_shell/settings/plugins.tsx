import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "../../../shell";

export const Route = createFileRoute("/_shell/settings/plugins")({
  staticData: { title: "Plugins" },
  component: Plugins,
});

function Plugins(): JSX.Element {
  return (
    <EmptyState
      headline="No plugins are installed."
      lead="Plugins bring channels, event sources, providers and workflow actions. Each one declares what it contributes, and Hydra generates its configuration form from that."
    />
  );
}

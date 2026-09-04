import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hydra/ui";

export const Route = createFileRoute("/_shell/settings/secrets")({
  staticData: { title: "Secrets" },
  component: Secrets,
});

function Secrets(): JSX.Element {
  return (
    <EmptyState
      headline="No secrets are stored."
      lead="Secrets are the tokens and keys connections and workflows use. Hydra keeps their values out of every read and shows only where each one is used."
    />
  );
}

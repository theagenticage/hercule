import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hydra/ui";

export const Route = createFileRoute("/_shell/settings/system")({
  staticData: { title: "System" },
  component: System,
});

function System(): JSX.Element {
  return (
    <EmptyState
      headline="The controller's settings are not editable yet."
      lead="Retention windows, the daily backup, HTTPS and the access-mode fallback policy are set on this screen."
    />
  );
}

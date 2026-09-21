import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hercule/ui";

export const Route = createFileRoute("/_shell/settings/identities")({
  staticData: { title: "Identities" },
  component: Identities,
});

function Identities(): JSX.Element {
  return (
    <EmptyState
      headline="No platform identity is paired."
      lead="An identity links a Discord or Slack account to you, so Hercule knows whose answers to take. Pairing mints a one-time code you send the bot."
    />
  );
}

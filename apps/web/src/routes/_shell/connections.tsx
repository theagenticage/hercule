import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hydra/ui";
import { ConnectRows } from "../../screens/connect-rows";

export const Route = createFileRoute("/_shell/connections")({
  staticData: { title: "Connections" },
  component: Connections,
});

function Connections(): JSX.Element {
  return (
    <EmptyState
      headline="Nothing connected yet."
      lead="Connections are the accounts Hydra reads and speaks through. Events come from GitHub and Gmail; chat comes from Discord and Slack."
    >
      <ConnectRows
        reason="Connecting an account is not built yet."
        offers={[
          { name: "GitHub", gist: "paste a token · files into a topic" },
          { name: "Gmail", gist: "Google sign-in · files into a topic" },
          { name: "Discord", gist: "a bot in your server" },
          { name: "Slack", gist: "a bot in your workspace" },
        ]}
      />
    </EmptyState>
  );
}

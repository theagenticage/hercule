import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hydra/ui";
import { ConnectRows } from "../../screens/connect-rows";

export const Route = createFileRoute("/_shell/intake")({
  staticData: { title: "Intake", sinceMarker: "lastChecked.intake" },
  component: Intake,
});

function Intake(): JSX.Element {
  return (
    <EmptyState
      headline="Nothing has come in yet."
      lead="Intake is your morning brief: what your connections brought in since you last checked, and what triage made of it. Connect something for it to read."
      fine="Each connection files into a topic you pick at setup - Code, Business, Personal, Ops or your own. Triage then proposes work here; you accept, start or dismiss it."
    >
      <ConnectRows
        reason="Connecting an account is not built yet."
        offers={[
          {
            name: "GitHub",
            gist: "issues, pull requests and mentions across the repos you watch · paste a token",
          },
          { name: "Gmail", gist: "one mailbox, read every 30 seconds · Google sign-in" },
        ]}
      />
    </EmptyState>
  );
}

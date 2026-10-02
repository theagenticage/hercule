import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hercule/ui";
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
      fine="When your connections send something in, triage turns it into proposed work here. You accept, start or dismiss it."
    >
      <ConnectRows
        reason="Connecting an account is not built yet."
        offers={[
          {
            name: "GitHub",
            gist: "issues, pull requests and mentions across the repos you watch · GitHub sign-in or a pasted token",
          },
          { name: "Gmail", gist: "one mailbox, read every 30 seconds · Google sign-in" },
        ]}
      />
    </EmptyState>
  );
}

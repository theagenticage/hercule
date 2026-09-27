import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hercule/ui";

export const Route = createFileRoute("/_shell/settings/permission-profiles")({
  staticData: { title: "Permission profiles" },
  component: PermissionProfiles,
});

function PermissionProfiles(): JSX.Element {
  return (
    <EmptyState
      className="mt-0"
      headline="Permission profiles are not editable yet."
      lead="A profile is the standing set of things a session may do without asking. Hercule ships unrestricted, worker and assistant."
    />
  );
}

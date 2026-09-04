import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/permission-profiles")({
  staticData: { title: "Permission profiles" },
  component: PermissionProfiles,
});

function PermissionProfiles(): JSX.Element {
  return <h1>Permission profiles</h1>;
}

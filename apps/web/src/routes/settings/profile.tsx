import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/profile")({
  staticData: { title: "Profile" },
  component: Profile,
});

function Profile(): JSX.Element {
  return <h1>Profile</h1>;
}

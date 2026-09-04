import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/notifications")({
  staticData: { title: "Notifications" },
  component: Notifications,
});

function Notifications(): JSX.Element {
  return <h1>Notifications</h1>;
}

import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/system")({
  staticData: { title: "System" },
  component: System,
});

function System(): JSX.Element {
  return <h1>System</h1>;
}

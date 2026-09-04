import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/secrets")({
  staticData: { title: "Secrets" },
  component: Secrets,
});

function Secrets(): JSX.Element {
  return <h1>Secrets</h1>;
}

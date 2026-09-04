import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/assistants")({
  staticData: { title: "Assistants" },
  component: Assistants,
});

function Assistants(): JSX.Element {
  return <h1>Assistants</h1>;
}

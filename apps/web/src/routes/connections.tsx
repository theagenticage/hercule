import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/connections")({
  staticData: { title: "Connections" },
  component: Connections,
});

function Connections(): JSX.Element {
  return <h1>Connections</h1>;
}

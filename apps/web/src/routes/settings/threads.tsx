import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/threads")({
  staticData: { title: "Threads" },
  component: Threads,
});

function Threads(): JSX.Element {
  return <h1>Threads</h1>;
}

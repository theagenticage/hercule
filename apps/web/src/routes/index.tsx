import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  staticData: { title: "Sessions" },
  component: Sessions,
});

function Sessions(): JSX.Element {
  return <h1>Sessions</h1>;
}

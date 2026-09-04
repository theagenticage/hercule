import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/bounds")({
  staticData: { title: "Bounds" },
  component: Bounds,
});

function Bounds(): JSX.Element {
  return <h1>Bounds</h1>;
}

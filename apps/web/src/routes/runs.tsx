import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/runs")({
  staticData: { title: "Runs" },
  component: Runs,
});

function Runs(): JSX.Element {
  return <h1>Runs</h1>;
}

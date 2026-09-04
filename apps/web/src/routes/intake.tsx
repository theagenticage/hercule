import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/intake")({
  staticData: { title: "Intake" },
  component: Intake,
});

function Intake(): JSX.Element {
  return <h1>Intake</h1>;
}

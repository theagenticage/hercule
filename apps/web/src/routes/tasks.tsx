import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks")({
  staticData: { title: "Tasks" },
  component: Tasks,
});

function Tasks(): JSX.Element {
  return <h1>Tasks</h1>;
}

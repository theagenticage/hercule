import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/check-in")({
  staticData: { title: "Check-in" },
  component: CheckIn,
});

function CheckIn(): JSX.Element {
  return <h1>Check-in</h1>;
}

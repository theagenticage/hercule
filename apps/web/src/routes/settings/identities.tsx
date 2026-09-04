import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/identities")({
  staticData: { title: "Identities" },
  component: Identities,
});

function Identities(): JSX.Element {
  return <h1>Identities</h1>;
}

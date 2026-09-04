import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/fleet")({
  staticData: { title: "Fleet" },
  component: Fleet,
});

function Fleet(): JSX.Element {
  return <h1>Fleet</h1>;
}

import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hydra/ui";

export const Route = createFileRoute("/_shell/settings/assistants")({
  staticData: { title: "Assistants" },
  component: Assistants,
});

function Assistants(): JSX.Element {
  return (
    <EmptyState
      headline="No assistant has been created yet."
      lead="An assistant is a conversation with memory, bound to the channels you give it. Its memory, heartbeat and reply style are edited here."
    />
  );
}

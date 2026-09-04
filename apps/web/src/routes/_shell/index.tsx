import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button, EmptyState } from "@hydra/ui";

export const Route = createFileRoute("/_shell/")({
  staticData: { title: "Sessions" },
  component: Sessions,
});

/**
 * The home screen, and the rest of onboarding: what it says is what the user
 * does next. Until a runner joins there is nothing to start a thread on, so the
 * button that starts one is disabled with its reason rather than hidden.
 */
function Sessions(): JSX.Element {
  return (
    <EmptyState
      headline="No runner has been detected on this machine."
      lead="A thread runs on a machine. Start a runner here and Hydra will look for the harnesses installed on it - Claude Code, Codex, pi - and offer to log in to them."
      fine={
        <>
          Run{" "}
          <code className="rounded-[4px] bg-line-soft px-1.5 py-px font-mono text-fine">
            hydra runner
          </code>{" "}
          on this machine, or join another one from Fleet.
        </>
      }
    >
      <div className="-ml-2 flex flex-wrap gap-0.5">
        <Button variant="primary" disabled>
          Create new thread
        </Button>
      </div>
    </EmptyState>
  );
}

import type { JSX } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState } from "../../shell";
import { HOME_PATH } from "../../app/entry-guard";

/**
 * Any path inside the app that names no screen. It is a screen of the shell
 * rather than a bare page, so a mistyped address leaves the navigation where
 * it was and the next click is one away.
 */
export const Route = createFileRoute("/_shell/$")({
  staticData: { title: "Not found" },
  component: NotFoundScreen,
});

function NotFoundScreen(): JSX.Element {
  return (
    <EmptyState
      headline="No screen here"
      lead="That address does not name anything in Hydra."
      fine="Pick a screen from the sidebar, or go back to where you were."
    >
      <Link
        to={HOME_PATH}
        className="text-row text-muted underline underline-offset-2 hover:text-ink"
      >
        Go to Sessions
      </Link>
    </EmptyState>
  );
}

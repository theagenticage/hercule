import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hydra/ui";
import { HomeLink, NOT_FOUND_HEADLINE } from "../../screens/fallbacks";

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
      headline={NOT_FOUND_HEADLINE}
      lead="That address does not name anything in Hydra. Pick a screen from the sidebar, or go back to where you were."
    >
      <HomeLink />
    </EmptyState>
  );
}

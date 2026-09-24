import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hercule/ui";
import { HomeLink, NOT_FOUND_HEADLINE } from "../../screens/fallbacks";

/**
 * The screen for any path inside the app that matches no other screen. It is
 * rendered inside the shell rather than as a bare page, so after a mistyped
 * address the sidebar stays in place and the next screen is one click away.
 */
export const Route = createFileRoute("/_shell/$")({
  staticData: { title: "Not found" },
  component: NotFoundScreen,
});

function NotFoundScreen(): JSX.Element {
  return (
    <EmptyState
      headline={NOT_FOUND_HEADLINE}
      lead="That address does not name anything in Hercule. Pick a screen from the sidebar, or go back to where you were."
    >
      <HomeLink />
    </EmptyState>
  );
}

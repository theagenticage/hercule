import type { JSX } from "react";
import { Link, useMatches } from "@tanstack/react-router";
import { EmptyState } from "../shell";
import { CenteredScreen } from "../routes/-centered-screen";
import { HOME_PATH } from "./entry-guard";

/**
 * What the router shows when a screen cannot be shown.
 *
 * A render that throws must not take the app with it: without a boundary the
 * router replaces the whole tree with its own bare text, and the navigation
 * that would lead somewhere else goes with it. The message is shown rather
 * than swallowed, so the person reading it can say what happened.
 *
 * Where it is drawn follows where the failure is. Inside the app shell the
 * sidebar and the top bar are still standing and only the content column is
 * empty, so the screen is a screen of the shell, the way a mistyped address
 * is. Outside it - the entry guard itself failing, before any of that is
 * mounted - there is nothing to keep, so it is the whole page.
 */
export function RenderFailure({ error }: { readonly error: Error }): JSX.Element {
  const inShell = useMatches().some((match) => match.routeId.startsWith("/_shell"));

  const message = (
    <p className="text-fine text-fail" role="alert">
      {error.message}
    </p>
  );

  return inShell ? (
    <EmptyState
      headline="This screen did not load"
      lead="Something went wrong rendering it. The rest of Hydra is still here."
    >
      {message}
      <HomeLink />
    </EmptyState>
  ) : (
    <CenteredScreen title="This screen did not load" lead="Something went wrong rendering it.">
      {message}
      <div className="mt-5">
        <HomeLink />
      </div>
    </CenteredScreen>
  );
}

/** What both not-found screens are headed with. */
export const NOT_FOUND_HEADLINE = "No screen here";

/**
 * A path the router could not answer at all.
 *
 * The pathless splat inside the shell answers every address that parses, which
 * leaves the ones that do not: a malformed percent escape (`/%zz`) fails to
 * decode before any route is matched, so there is no shell to draw this in.
 */
export function NotFound(): JSX.Element {
  return (
    <CenteredScreen title={NOT_FOUND_HEADLINE} lead="That address does not name anything in Hydra.">
      <HomeLink />
    </CenteredScreen>
  );
}

/** The way back that every fallback screen offers. */
export function HomeLink(): JSX.Element {
  return (
    <Link
      to={HOME_PATH}
      className="text-row text-muted underline underline-offset-2 hover:text-ink"
    >
      Go to Sessions
    </Link>
  );
}

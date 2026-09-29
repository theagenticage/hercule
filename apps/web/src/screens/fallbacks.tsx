import type { JSX } from "react";
import { Link, useParentMatches } from "@tanstack/react-router";
import { EmptyState } from "@hercule/ui";
import { HOME_PATH } from "../app/entry-guard";
import { CenteredScreen } from "./centered-screen";

/**
 * The screen the router shows when a screen fails to render.
 *
 * A render that throws must not take down the whole app. Without this
 * boundary, the router replaces the whole tree with its own bare text, and
 * the navigation goes with it. The error message is shown, not hidden, so the
 * user can report what happened.
 *
 * Where the screen appears depends on where the failure is:
 *
 * - Inside the app shell, the sidebar and top bar still work and only the
 *   content column is empty. So the screen renders inside the shell, like the
 *   not-found screen for a mistyped address.
 * - Outside the shell, for example when the entry guard itself fails before
 *   the shell is mounted, there is nothing to keep, so the screen takes the
 *   whole page.
 */
export function RenderFailure({ error }: { readonly error: Error }): JSX.Element {
  // The router renders this component inside the failed route's match, so
  // the parent matches are the routes above the one that failed. The shell
  // among them means the sidebar is still on screen. When the shell itself
  // failed, it is not among them, and nothing is left standing.
  const inShell = useParentMatches({
    select: (parents) => parents.some((match) => match.routeId === "/_shell"),
  });

  const message = (
    <p className="text-fine text-fail" role="alert">
      {error.message}
    </p>
  );

  return inShell ? (
    <EmptyState
      headline="This screen did not load"
      lead="Something went wrong rendering it. The rest of Hercule is still here."
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

/** The headline of both not-found screens. */
export const NOT_FOUND_HEADLINE = "No screen here";

/**
 * The screen for a path the router cannot match at all.
 *
 * The catch-all route inside the shell matches every address that parses.
 * This screen covers the ones that do not: a malformed percent escape
 * (`/%zz`) fails to decode before any route is matched, so there is no shell
 * to render inside.
 */
export function NotFound(): JSX.Element {
  return (
    <CenteredScreen
      title={NOT_FOUND_HEADLINE}
      lead="That address does not name anything in Hercule."
    >
      <HomeLink />
    </CenteredScreen>
  );
}

/** The link back to Sessions that every fallback screen offers. */
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

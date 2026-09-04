import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { CenteredScreen } from "../routes/-centered-screen";
import { HOME_PATH } from "./entry-guard";

/**
 * What the router shows when a screen cannot be shown.
 *
 * A render that throws must not take the app with it: without a boundary the
 * router replaces the whole tree with its own bare text, and the navigation
 * that would lead somewhere else goes with it. Both fallbacks are Hydra
 * screens with a way back, and the message is shown rather than swallowed so
 * the person reading it can say what happened.
 */
export function RenderFailure({ error }: { readonly error: Error }): JSX.Element {
  return (
    <CenteredScreen
      title="This screen did not load"
      lead="Something went wrong rendering it. The rest of Hydra is still here."
    >
      <p className="text-fine text-fail" role="alert">
        {error.message}
      </p>
      <Link
        to={HOME_PATH}
        className="mt-5 inline-block text-row text-muted underline underline-offset-2 hover:text-ink"
      >
        Go to Sessions
      </Link>
    </CenteredScreen>
  );
}

/** A path no screen answers to. */
export function NotFound(): JSX.Element {
  return (
    <CenteredScreen title="No screen here" lead="That address does not name anything in Hydra.">
      <Link
        to={HOME_PATH}
        className="text-row text-muted underline underline-offset-2 hover:text-ink"
      >
        Go to Sessions
      </Link>
    </CenteredScreen>
  );
}

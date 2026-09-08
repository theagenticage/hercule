import type { JSX } from "react";
import { ButtonLink } from "@hydra/ui";

/**
 * Create new thread, wherever it appears as a plain primary affordance: the
 * Sessions home's ready state and All sessions. The sidebar's own carries a
 * `+` and a card look of its own, so it is not built from this.
 *
 * `/threads/new` is the composer in new-thread mode, a route another slice of
 * this ticket builds in its own worktree - so this links by path rather than
 * a typed `Link`.
 */
export function CreateThreadLink(): JSX.Element {
  return (
    <ButtonLink href="/threads/new" variant="primary">
      Create new thread
    </ButtonLink>
  );
}

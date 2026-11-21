import type { JSX } from "react";
import type { DraftView } from "@hercule/client-core";
import type { ThreadServersRow } from "@hercule/client-core/mcp-servers";
import type { Session } from "@hercule/contract";
import { describePlusLabel, PlusFace } from "./plus-face";
import { useDraftRow, useStartedThreadRow } from "./thread-server-rows";

/**
 * Renders the composer's `+` of the started thread `session` as it looks until
 * the menu's code has loaded: the same button with the same red dot, which
 * does nothing yet. The menu replaces it within a moment, so the `+` never
 * changes place or look (see `PlusMenu`).
 */
export function StartedThreadPlusPlaceholder({
  session,
}: {
  readonly session: Session;
}): JSX.Element {
  const row = useStartedThreadRow(session);
  return <PlusPlaceholder row={row} />;
}

/** Renders the `+` of the Draft Thread `view` until the menu's code has loaded, like `StartedThreadPlusPlaceholder`. */
export function DraftPlusPlaceholder({ view }: { readonly view: DraftView }): JSX.Element {
  const row = useDraftRow(view);
  return <PlusPlaceholder row={row} />;
}

function PlusPlaceholder({ row }: { readonly row: ThreadServersRow }): JSX.Element {
  return (
    <button
      type="button"
      className="icon-btn plus-button"
      aria-label={describePlusLabel(row)}
      aria-haspopup="dialog"
      aria-expanded={false}
      aria-disabled="true"
    >
      <PlusFace row={row} />
    </button>
  );
}

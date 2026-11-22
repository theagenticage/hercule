import type { JSX } from "react";
import { describePlusLabel, PlusFace } from "./plus-face";
import { useThreadServers } from "./thread-servers";

/**
 * Renders the composer's `+` as it looks until the menu's code has loaded:
 * the same button with the same red dot, which does nothing yet. The menu
 * replaces it within a moment, so the `+` never changes place or look (see
 * `PlusMenu`). The dot comes from the open thread's servers, which are read
 * already (see `ThreadServersProvider`).
 */
export function PlusPlaceholder(): JSX.Element {
  const { row } = useThreadServers().described;
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

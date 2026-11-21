import type { JSX } from "react";
import { PlusIcon } from "../../icons/plus";

/**
 * Renders the `+` as it looks until the menu's code has loaded: the same
 * button, which does nothing yet. The composer's menu replaces it within a
 * moment, so the `+` never changes place or look (see `PlusMenu`).
 */
export function PlusPlaceholder(): JSX.Element {
  return (
    <button type="button" className="icon-btn plus-button" aria-label="Add" aria-disabled="true">
      <PlusIcon />
    </button>
  );
}

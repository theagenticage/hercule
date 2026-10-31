import type { JSX } from "react";
import type { NewModelRow } from "@hercule/client-core";
import { CloseIcon } from "../../icons/close";

/**
 * Renders the row of a model the controller announced as new: a "New" pill,
 * the model's name and when it arrived, drawn like the lines around it. The
 * row is not a choice: clicking its body does nothing, and only its two
 * buttons act.
 *
 * - `actions` gives the buttons. "Add" calls `onAdd`, and "Not now" (a ×)
 *   calls `onDismiss`. While `busy` is true, which is while a save of this
 *   row runs, both are `aria-disabled` and fade (`data-unready`), and a press
 *   does nothing. They are not `disabled`, so the pressed button keeps the
 *   keyboard focus. Without `actions` the row has no buttons, as in a preview
 *   that only shows what the menu looks like.
 */
export function NewModelLine({
  row,
  actions = null,
}: {
  readonly row: NewModelRow;
  readonly actions?: {
    readonly onAdd: () => void;
    readonly onDismiss: () => void;
    readonly busy: boolean;
  } | null;
}): JSX.Element {
  return (
    <div className="line line--new">
      <span className="pk-new">New</span>
      <span className="grow">
        <b>{row.name}</b>
        {` · ${row.arrivalText}`}
      </span>
      {actions === null ? null : (
        <>
          <button
            type="button"
            className="link line-action"
            aria-label={`Add ${row.name}`}
            aria-disabled={actions.busy || undefined}
            data-unready={actions.busy ? "" : undefined}
            onClick={actions.busy ? undefined : actions.onAdd}
          >
            Add
          </button>
          <button
            type="button"
            className="line-dismiss"
            aria-label={`Not now: ${row.name}`}
            title="Not now"
            aria-disabled={actions.busy || undefined}
            data-unready={actions.busy ? "" : undefined}
            onClick={actions.busy ? undefined : actions.onDismiss}
          >
            <CloseIcon size={12} />
          </button>
        </>
      )}
    </div>
  );
}

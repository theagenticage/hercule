import { useState, type JSX, type Ref } from "react";
import type { NewModelRow } from "@hercule/client-core";
import "./models.css";

/**
 * Renders the "New" row of a model the controller announced for an account's
 * section: a "New" pill, the model's name, when it arrived, and the buttons
 * "Add" and "Not now". Their accessible names say which model they act on.
 * The row is not a model row: it cannot be dragged or moved, and it is not in
 * the section's list of entries.
 *
 * `onAdd` and `onDismiss` save the user's choice and resolve when the save is
 * over, whether it worked or not (a failed save shows above the sections).
 * While one runs, both buttons wait: they are `aria-disabled` and dimmed, not
 * `disabled`, so a focused button keeps the focus if the save fails. When the
 * save worked, the profile no longer announces the model and the row goes.
 * `addButtonRef` receives the "Add" button, so the section can move the focus
 * to it when another row goes.
 */
export function SectionNewModel({
  row,
  addButtonRef,
  onAdd,
  onDismiss,
}: {
  readonly row: NewModelRow;
  readonly addButtonRef: Ref<HTMLButtonElement>;
  readonly onAdd: () => Promise<void>;
  readonly onDismiss: () => Promise<void>;
}): JSX.Element {
  const [saving, setSaving] = useState(false);
  const run = (save: () => Promise<void>): void => {
    if (saving) return;
    setSaving(true);
    // `save` never rejects, so the row can always take its buttons back.
    void save().then(() => {
      setSaving(false);
    });
  };
  return (
    <div className="pm-new" role="group" aria-label={`New: ${row.name}`}>
      <span className="pm-new-pill">New</span>
      <b>{row.name}</b>
      <small>{row.arrivalText}</small>
      <span className="pm-spacer" />
      <button
        ref={addButtonRef}
        type="button"
        className="btn btn--sm"
        aria-label={`Add ${row.name}`}
        aria-disabled={saving || undefined}
        data-unready={saving ? "" : undefined}
        onClick={() => {
          run(onAdd);
        }}
      >
        Add
      </button>
      <button
        type="button"
        className="btn btn--sm btn--quiet"
        aria-label={`Not now: ${row.name}`}
        aria-disabled={saving || undefined}
        data-unready={saving ? "" : undefined}
        onClick={() => {
          run(onDismiss);
        }}
      >
        Not now
      </button>
    </div>
  );
}

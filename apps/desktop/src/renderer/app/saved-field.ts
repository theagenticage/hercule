/**
 * One stored value whose control saves on every change (spec 17 §Settings,
 * The frame, Saving): a setting, or a field of a listed record. `Change` is
 * what a save sends, which is the whole value unless the field saves only
 * the part of it that changed.
 */
export interface SavedField<Value, Change = Value> {
  /** The value the control shows: the one being saved while a save runs, else the stored one. */
  readonly value: Value;
  /** Why the last save failed, or `null` when it did not. */
  readonly error: string | null;
  /** Saves `change` on the controller. */
  readonly save: (change: Change) => void;
}

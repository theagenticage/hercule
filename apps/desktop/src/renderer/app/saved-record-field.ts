import { useId } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
  type DataTag,
  type QueryKey,
} from "@tanstack/react-query";
import { readErrorMessage } from "@hercule/client-core";
import type { SavedField } from "./saved-field";

/** What `useSavedRecordField` needs to know about the field and the record it belongs to. */
export interface SavedRecordFieldOptions<
  Record extends { readonly id: string },
  Value,
  Change,
  Payload extends object,
> {
  /** The key of the cached list that holds the record, such as the one `profilesQuery` reads. */
  readonly listKey: DataTag<QueryKey, ReadonlyArray<Record>, Error>;
  /** Names what the record is, such as `"assistant"`. Saves of records of one kind and id share one mutation scope. */
  readonly recordKind: string;
  /** The id of the record the field belongs to. */
  readonly id: string;
  /** The saved value of the field. */
  readonly stored: Value;
  /** Returns the value a change makes of the shown one. */
  readonly applyChange: (value: Value, change: Change) => Value;
  /**
   * Builds the update payload that applies the change to `latest`, the record
   * as the cache holds it when the save starts. An empty payload saves nothing.
   */
  readonly buildPayload: (latest: Record, change: Change) => Payload;
  /** Sends the update of the record `id` to the controller, and returns the record it stored. */
  readonly update: (id: string, payload: Payload) => Promise<Record>;
}

/**
 * Returns one field of a record in a cached list, whose control saves on
 * every change (spec 17 §Settings, The frame, Saving).
 *
 * - `stored` is the saved value.
 * - `applyChange` returns the value a change makes of the shown one. While
 *   saves run, the control shows every change still saving applied to
 *   `stored` in order, so a change made while an earlier one saves does not
 *   hide the earlier one.
 * - `buildPayload` builds the update payload that applies the change to
 *   `latest`, the record as the cache holds it when the save starts. An empty
 *   payload saves nothing.
 *
 * A field that holds several values, such as an assistant's heartbeat, saves
 * only the values the user changed, applied to `latest`. A save then never
 * puts back a value another writer, or an earlier save, changed in the
 * meantime.
 *
 * - A failed save puts the control back to `stored` and returns the error,
 *   which the row shows under itself until the next save. Each field has its
 *   own save, so a failure shows under its own row only.
 * - Every save of one record shares one mutation scope, so its saves run one
 *   after another, in the order they were made, and each one builds on what
 *   the save before it stored.
 * - A save of a record that is gone from the list, because it was deleted,
 *   saves nothing.
 * - A successful save puts the record the controller returns in the cached
 *   list, so every screen that shows the list shows it at once, and then
 *   reads the list again. That read replaces any read still running, which
 *   could answer with the list from before the save.
 */
export function useSavedRecordField<
  Record extends { readonly id: string },
  Value,
  Change,
  Payload extends object,
>(options: SavedRecordFieldOptions<Record, Value, Change, Payload>): SavedField<Value, Change> {
  const { listKey, recordKind, id, stored, applyChange, buildPayload, update } = options;
  const queryClient = useQueryClient();
  // A key of this field's own, so the changes still saving are this field's
  // and not those of another field of the same record.
  const mutationKey = ["saved-record-field", useId()];
  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (each) => each.state.variables as Change,
  });
  const mutation = useMutation({
    mutationKey,
    scope: { id: `${recordKind}:${id}` },
    mutationFn: async (change: Change): Promise<Record | null> => {
      const latest = queryClient.getQueryData(listKey)?.find((each) => each.id === id);
      if (latest === undefined) return null;
      const payload = buildPayload(latest, change);
      if (Object.keys(payload).length === 0) return null;
      return update(id, payload);
    },
    onSuccess: async (updated) => {
      if (updated === null) return;
      queryClient.setQueryData(listKey, (records) =>
        records?.map((each) => (each.id === updated.id ? updated : each)),
      );
      await queryClient.invalidateQueries({ queryKey: listKey });
    },
  });
  return {
    value: pending.reduce(applyChange, stored),
    error: mutation.error === null ? null : `Could not save: ${readErrorMessage(mutation.error)}`,
    save: mutation.mutate,
  };
}

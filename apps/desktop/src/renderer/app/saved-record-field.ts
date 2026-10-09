import { useId, useState } from "react";
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
interface SavedRecordFieldOptions<
  ListedRecord extends { readonly id: string },
  Value,
  Change,
  Payload extends object,
> {
  /** The key of the cached list that holds the record, such as the one `profilesQuery` reads. */
  readonly listKey: DataTag<QueryKey, ReadonlyArray<ListedRecord>, Error>;
  /** The id of the record the field belongs to. Ids are unique across record kinds. */
  readonly id: string;
  /** The saved value of the field. */
  readonly stored: Value;
  /** Returns the value a change makes of the shown one. */
  readonly applyChange: (value: Value, change: Change) => Value;
  /**
   * Builds the update payload that applies the change to `latest`, the record
   * as it is when the save starts. An empty payload saves nothing.
   */
  readonly buildPayload: (latest: ListedRecord, change: Change) => Payload;
  /** Sends the update of the record `id` to the controller, and returns the record it stored. */
  readonly update: (id: string, payload: Payload) => Promise<ListedRecord>;
  /**
   * Reads the record `id` from the controller. When given, a save builds its
   * payload on this read instead of on the cached list. A record with no live
   * topic keeps nothing current in the cache, and a payload built on a stale
   * cache could put back a value another writer changed.
   */
  readonly readLatest?: (id: string) => Promise<ListedRecord>;
}

/** A field saved by `useSavedRecordField`: the failed change is returned with its error. */
export interface SavedRecordField<Value, Change> extends SavedField<Value, Change> {
  /** The change whose save failed, which `error` explains, or `null` when no save failed. */
  readonly failedChange: Change | null;
}

/**
 * Returns one field of a record in a cached list, whose control saves on
 * every change (spec 17 §Settings, The frame, Saving).
 *
 * - While saves run, `value` is every change still saving applied to
 *   `stored` in order, so a change made while an earlier one saves does not
 *   hide the earlier one.
 * - A field that holds several values, such as an assistant's heartbeat,
 *   saves only the values the user changed, built onto the record as it is
 *   when the save starts. A save then does not put back a value that an
 *   earlier save changed. It puts back a value another writer changed only
 *   if that write lands between the save's read of the record and its update.
 *   `profile.update` replaces a profile's whole grant list, so that window
 *   remains for grants until issue #500 gives the contract a way to add or
 *   remove a single grant.
 * - A failed save puts the control back to `stored`. `error` says why, and
 *   `failedChange` is the change that failed, so a field that shows several
 *   controls can show the error under the right one. Both stay until the
 *   next `save`, also when a save queued behind the failed one succeeds. Each
 *   field has its own saves, so a failure shows under its own field only.
 * - Every save of one record shares one mutation scope, so its saves run one
 *   after another, in the order they were made, and each one builds on what
 *   the save before it stored.
 * - A save of a record that is gone from the list, because it was deleted,
 *   saves nothing.
 * - A successful save puts the record the controller returns in the cached
 *   list, so every screen that shows the list shows the record at once, and
 *   then reads the list again. The returned record can be older than the
 *   cache: a live update can bring in another writer's newer change while
 *   the answer is on its way. The new read starts after the save, and
 *   replaces any read that started before it, so the list ends as the
 *   controller has it. The save counts as running until that read answers,
 *   so the control never shows the old value in between, and a save queued
 *   behind it builds on the list that read returned.
 */
export function useSavedRecordField<
  ListedRecord extends { readonly id: string },
  Value,
  Change,
  Payload extends object,
>(
  options: SavedRecordFieldOptions<ListedRecord, Value, Change, Payload>,
): SavedRecordField<Value, Change> {
  const { listKey, id, stored, applyChange, buildPayload, update, readLatest } = options;
  const queryClient = useQueryClient();
  // A key of this field's own, so the changes still saving are this field's
  // and not those of another field of the same record.
  const mutationKey = ["saved-record-field", useId()];
  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (each) => each.state.variables as Change,
  });
  // `useMutation` reports only the latest `mutate`, so a failure of an earlier
  // save would go unseen while a later one is queued. And the mutation cache
  // drops a failed mutation nothing observes, with the app's `gcTime` of 0. So
  // each failure is kept here when it happens, and the newest one is shown.
  const [failure, setFailure] = useState<{ change: Change; error: Error } | null>(null);
  const mutation = useMutation({
    mutationKey,
    scope: { id: `record:${id}` },
    mutationFn: async (change: Change): Promise<ListedRecord | null> => {
      const cached = queryClient.getQueryData(listKey)?.find((each) => each.id === id);
      if (cached === undefined) return null;
      const latest = readLatest === undefined ? cached : await readLatest(id);
      const payload = buildPayload(latest, change);
      if (Object.keys(payload).length === 0) return null;
      return update(id, payload);
    },
    onError: (error, change) => {
      setFailure({ change, error });
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
    error: failure === null ? null : `Could not save: ${readErrorMessage(failure.error)}`,
    failedChange: failure === null ? null : failure.change,
    save: (change) => {
      setFailure(null);
      mutation.mutate(change);
    },
  };
}

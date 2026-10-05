import { useMutation, useQueryClient } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { SettingsPatch } from "@hercule/contract";
import { settingsQuery } from "../../../../app/queries";

/** One setting that saves when its control changes. */
export interface SavedSetting<Value> {
  /** The value the control shows: the one being saved while a save runs, else `stored`. */
  readonly value: Value;
  /** Why the last save failed, or `null` when it did not. */
  readonly error: string | null;
  /** Saves `value` on the controller. */
  readonly save: (value: Value) => void;
}

/**
 * Returns one setting of the controller's settings, whose control saves on
 * every change (spec 17 §Settings, The frame, Saving). `stored` is the saved
 * value, and `buildPatch` builds the `settings.update` payload that saves a
 * new one.
 *
 * - While a save runs, the control already shows the new value.
 * - A successful save puts the settings the controller returns in the cache,
 *   so every screen that reads them shows the new value at once.
 * - A failed save puts the control back to `stored` and returns the error,
 *   which the row shows under itself until the next save.
 *
 * Each setting has its own save, so a failure shows under its own row only.
 *
 * Two things could put an older value back in the cache after a save:
 *
 * - A read of the settings could answer after the save, with a value the
 *   controller read before it stored the save. The read may have started
 *   before the save or while it ran, for example the read that runs in the
 *   background each time the section opens. So when a save succeeds, it
 *   first cancels any read of the settings still running, and only then
 *   writes its answer to the cache. The save counts as running until the
 *   cache holds its answer, so the control never shows the old value in
 *   between.
 * - Two saves could answer out of order. So every settings save shares one
 *   mutation scope, which runs them one after another, in the order they
 *   were made.
 */
export function useSavedSetting<Value>(
  client: HerculeClient,
  stored: Value,
  buildPatch: (value: Value) => SettingsPatch,
): SavedSetting<Value> {
  const queryClient = useQueryClient();
  const { queryKey } = settingsQuery(client);
  const mutation = useMutation({
    scope: { id: "settings" },
    mutationFn: (value: Value) => client.settings.update({ payload: buildPatch(value) }),
    onSuccess: async (updated) => {
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, updated);
    },
  });
  return {
    value: mutation.isPending ? mutation.variables : stored,
    error: mutation.error === null ? null : `Could not save: ${readErrorMessage(mutation.error)}`,
    save: mutation.mutate,
  };
}

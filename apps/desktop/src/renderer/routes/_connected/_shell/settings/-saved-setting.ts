import { useMutation, useQueryClient } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { SettingsPatch } from "@hercule/contract";
import { settingsQuery } from "../../../../app/queries";
import type { SavedField } from "../../../../app/saved-field";

/**
 * Returns one setting of the controller's settings, whose control saves on
 * every change (spec 17 §Settings, The frame, Saving). `stored` is the saved
 * value, and `buildPatch` builds the `settings.update` payload that saves a
 * new one.
 *
 * - While a save runs, the control already shows the new value.
 * - A successful save puts the settings the controller returns in the cache,
 *   so every screen that reads them shows the new value at once, and then
 *   reads the settings again.
 * - A failed save puts the control back to `stored` and returns the error,
 *   which the row shows under itself until the next save.
 *
 * Each setting has its own save, so a failure shows under its own row only.
 *
 * Two things could leave an older value in the cache after a save:
 *
 * - The settings the save returns, or a read that started before the save
 *   (for example the read that runs in the background each time the section
 *   opens), could be older than a change another writer made meanwhile. So
 *   the read after a save starts once the save is stored, and replaces any
 *   read still running, and the cache ends as the controller has it. The
 *   save counts as running until that read answers, so the control never
 *   shows the old value in between.
 * - Two saves could answer out of order. So every settings save shares one
 *   mutation scope, which runs them one after another, in the order they
 *   were made.
 */
export function useSavedSetting<Value>(
  client: HerculeClient,
  stored: Value,
  buildPatch: (value: Value) => SettingsPatch,
): SavedField<Value> {
  const queryClient = useQueryClient();
  const { queryKey } = settingsQuery(client);
  const mutation = useMutation({
    scope: { id: "settings" },
    mutationFn: (value: Value) => client.settings.update({ payload: buildPatch(value) }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKey, updated);
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  return {
    value: mutation.isPending ? mutation.variables : stored,
    error: mutation.error === null ? null : `Could not save: ${readErrorMessage(mutation.error)}`,
    save: mutation.mutate,
  };
}

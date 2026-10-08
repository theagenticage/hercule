import { useMutation } from "@tanstack/react-query";
import { readErrorMessage } from "@hercule/client-core";
import type { Appearance } from "../../../../../ipc/contract";
import type { AppearanceStore } from "../../../../app/appearance";
import type { SavedField } from "../../../../app/saved-field";

/**
 * Returns the save and the last save's error of one row of Settings >
 * Appearance, whose controls save on every change (spec 17 §Settings, The
 * frame, Saving). The row's value comes from `useAppearance`, because every
 * row shows the one Appearance `store` holds.
 *
 * - A save shows its change at once, and `store` saves it after the saves
 *   made before it.
 * - A failed save takes the change off the screen, so the row shows the
 *   saved value again, and returns the error, which the row shows under
 *   itself until its next save. Each row has its own save, so a failure
 *   shows under its own row only.
 */
export function useSavedAppearance(
  store: AppearanceStore,
): Pick<SavedField<Appearance, Partial<Appearance>>, "error" | "save"> {
  const mutation = useMutation({ mutationFn: store.save });
  return {
    error: mutation.error === null ? null : `Could not save: ${readErrorMessage(mutation.error)}`,
    save: mutation.mutate,
  };
}

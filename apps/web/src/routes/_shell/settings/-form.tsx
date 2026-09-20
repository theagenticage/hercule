import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HydraClient } from "@hercule/client-core";
import type { SettingsPatch } from "@hercule/contract";
import { messageOf } from "../../../screens/save-status";
import { settingsQuery } from "../../../app/queries";

/**
 * Writing a settings patch and saying what happened.
 *
 * The answer the API sends back is the whole store, so it replaces the cached
 * copy outright: no screen refetches to find out what it just wrote.
 */
export function useSaveSettings(client: HydraClient): {
  readonly save: (patch: SettingsPatch) => void;
  readonly saving: boolean;
  readonly saved: boolean;
  readonly failure: string | null;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (patch: SettingsPatch) => client.settings.update({ payload: patch }),
    onSuccess: (updated) => {
      queryClient.setQueryData(settingsQuery(client).queryKey, updated);
    },
  });

  return {
    save: mutation.mutate,
    saving: mutation.isPending,
    saved: mutation.isSuccess,
    failure: mutation.error === null ? null : messageOf(mutation.error),
  };
}

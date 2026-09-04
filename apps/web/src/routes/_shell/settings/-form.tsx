import type { JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HydraClient } from "@hydra/client-core";
import type { SettingsPatch } from "@hydra/contract";
import { settingsQuery } from "../../../app/queries";

/** A rejection that is not an Error still has to say something. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

/** What the last write did, where the user can see it. */
export function SaveStatus({
  saved,
  failure,
}: {
  readonly saved: boolean;
  readonly failure: string | null;
}): JSX.Element | null {
  if (failure !== null) {
    return (
      <p className="text-fine text-fail" role="alert">
        {failure}
      </p>
    );
  }
  if (!saved) return null;
  return (
    <p className="text-fine text-muted" role="status">
      Saved.
    </p>
  );
}

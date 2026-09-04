import { useState, type JSX } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { HydraClient } from "@hydra/client-core";
import type { SettingsPatch } from "@hydra/contract";
import { settingsQuery } from "../../../app/queries";

/**
 * Writing a settings patch and saying what happened.
 *
 * The answer the API sends back is the whole store, so it replaces the cached
 * copy outright: no screen refetches to find out what it just wrote.
 */
export function useSaveSettings(
  client: HydraClient,
  queryClient: QueryClient,
): {
  readonly save: (patch: SettingsPatch) => Promise<void>;
  readonly saving: boolean;
  readonly saved: boolean;
  readonly failure: string | null;
} {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async (patch: SettingsPatch): Promise<void> => {
    setSaving(true);
    setSaved(false);
    setFailure(null);
    try {
      const updated = await client.settings.update({ payload: patch });
      queryClient.setQueryData(settingsQuery(client).queryKey, updated);
      setSaved(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return { save, saving, saved, failure };
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

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  buildModelProfileUpdateOptions,
  readErrorMessage,
  type HerculeClient,
  type NewModelEdit,
  type NewModelRow,
} from "@hercule/client-core";
import { modelProfilesQuery } from "../../app/queries";
import type { NewModelRefusal, NewModelSaving } from "./model-list";

const isSameRow = (a: NewModelSaving, b: NewModelSaving): boolean =>
  a.profileId === b.profileId && a.providerAccountId === b.providerAccountId && a.model === b.model;

/**
 * Returns what the model menu needs to save its New rows: `add` takes the
 * row's model into a profile, `dismiss` hides it there for good, `saving`
 * lists the rows whose save is running, and `refusal` is the last save the
 * controller refused. `clearRefusal` forgets a refusal, for when the menu
 * closes. A save that is running is never forgotten, so closing and reopening
 * the menu mid-save still shows the row busy and, if the save fails, why.
 *
 * The saves are those of `buildModelProfileUpdateOptions`: one after another,
 * each built from the newest cached profile. The controller's answer replaces
 * the profile in the cache at once; the `provider` live topic keeps the cache
 * current after that, and the menu redraws without the row.
 *
 * The state of each save is kept here, not read from the mutation, because a
 * mutation observer follows only the latest call and resetting it lets go of
 * one that is still running.
 */
export function useNewModelSave(client: HerculeClient) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState<readonly NewModelSaving[]>([]);
  const [refusal, setRefusal] = useState<NewModelRefusal | null>(null);
  const save = useMutation(
    buildModelProfileUpdateOptions(client, queryClient, modelProfilesQuery(client).queryKey),
  );

  const run = async (
    profileId: string,
    row: NewModelRow,
    action: NewModelEdit["action"],
  ): Promise<void> => {
    const key: NewModelSaving = {
      profileId,
      providerAccountId: row.providerAccountId,
      model: row.model,
    };
    // A press on a row that is saving does nothing.
    if (saving.some((each) => isSameRow(each, key))) return;
    setRefusal(null);
    setSaving((current) => [...current, key]);
    try {
      await save.mutateAsync({
        profileId,
        newModelEdit: { action, providerAccountId: row.providerAccountId, model: row.model },
      });
    } catch (error) {
      setRefusal({
        ...key,
        message: `The change was not saved. ${readErrorMessage(error)}`,
      });
    } finally {
      setSaving((current) => current.filter((each) => !isSameRow(each, key)));
    }
  };

  return {
    saving,
    refusal,
    clearRefusal: (): void => {
      setRefusal(null);
    },
    add: (profileId: string, row: NewModelRow): void => {
      void run(profileId, row, "add");
    },
    dismiss: (profileId: string, row: NewModelRow): void => {
      void run(profileId, row, "dismiss");
    },
  };
}

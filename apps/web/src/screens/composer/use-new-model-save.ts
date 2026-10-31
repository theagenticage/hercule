import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  addNewModel,
  dismissNewModel,
  readErrorMessage,
  updateModelProfile,
  type HerculeClient,
  type NewModelRow,
} from "@hercule/client-core";
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import { modelProfilesQuery } from "../../app/queries";
import type { NewModelRefusal, NewModelSaving } from "./model-list";

/** What one save of a New row changes, and which row it is for. */
interface NewModelSaveRequest {
  readonly profileId: string;
  readonly row: NewModelRow;
  readonly buildChange: (profile: ModelProfile) => ModelProfileUpdateInput;
}

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
 * Every save shares the "model-profile" mutation scope, so saves run one
 * after another. The profile a save changes is read from the cache when the
 * save's turn comes, not when the user pressed the button, so a save never
 * writes over one that ran before it. The controller's answer replaces the
 * profile in the cache at once; the `provider` live topic keeps the cache
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
  const save = useMutation({
    scope: { id: "model-profile" },
    mutationFn: ({ profileId, buildChange }: NewModelSaveRequest) => {
      const cached = queryClient
        .getQueryData(modelProfilesQuery(client).queryKey)
        ?.find((each) => each.id === profileId);
      if (cached === undefined) {
        throw new Error("This profile was deleted. Pick another profile.");
      }
      return updateModelProfile(client, cached, buildChange);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(modelProfilesQuery(client).queryKey, (list) =>
        list?.map((each) => (each.id === saved.id ? saved : each)),
      );
    },
  });

  const run = async (request: NewModelSaveRequest): Promise<void> => {
    const { profileId, row } = request;
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
      await save.mutateAsync(request);
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
      void run({
        profileId,
        row,
        buildChange: (profile) => addNewModel(profile, row.providerAccountId, row.model),
      });
    },
    dismiss: (profileId: string, row: NewModelRow): void => {
      void run({
        profileId,
        row,
        buildChange: (profile) => dismissNewModel(profile, row.providerAccountId, row.model),
      });
    },
  };
}

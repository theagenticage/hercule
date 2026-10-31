import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  addNewModelToProfile,
  dismissNewModel,
  readErrorMessage,
  updateModelProfile,
  type HerculeClient,
  type NewModelRow,
} from "@hercule/client-core";
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import { modelProfilesQuery } from "../../app/queries";
import type { NewModelRefusal } from "./model-list";

/** What one save of a New row changes, and which row it is for. */
interface NewModelSaveRequest {
  readonly profileId: string;
  readonly row: NewModelRow;
  readonly buildChange: (profile: ModelProfile) => ModelProfileUpdateInput;
}

/**
 * Returns what the model menu needs to save its New rows: `add` takes the
 * row's model into a profile, `dismiss` hides it there for good, and
 * `saving` and `refusal` say how the last save went. `reset` forgets a
 * refusal, for when the menu closes.
 *
 * Every save shares the "model-profile" mutation scope, so saves run one
 * after another. The profile a save changes is read from the cache when the
 * save's turn comes, not when the user pressed the button, so a save never
 * writes over one that ran before it. The controller's answer replaces the
 * profile in the cache at once; the `provider` live topic keeps the cache
 * current after that, and the menu redraws without the row.
 */
export function useNewModelSave(client: HerculeClient) {
  const queryClient = useQueryClient();
  const save = useMutation({
    scope: { id: "model-profile" },
    mutationFn: ({ profileId, buildChange }: NewModelSaveRequest) => {
      const cached = queryClient
        .getQueryData(modelProfilesQuery(client).queryKey)
        ?.find((each) => each.id === profileId);
      if (cached === undefined) throw new Error("The profile is gone.");
      return updateModelProfile(client, cached, buildChange);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(modelProfilesQuery(client).queryKey, (list) =>
        list?.map((each) => (each.id === saved.id ? saved : each)),
      );
    },
  });
  const refusal: NewModelRefusal | null =
    save.isError && save.variables !== undefined
      ? {
          profileId: save.variables.profileId,
          providerAccountId: save.variables.row.providerAccountId,
          message: readErrorMessage(save.error),
        }
      : null;
  return {
    saving: save.isPending,
    refusal,
    reset: save.reset,
    add: (profileId: string, row: NewModelRow): void => {
      save.mutate({
        profileId,
        row,
        buildChange: (profile) => addNewModelToProfile(profile, row.providerAccountId, row.model),
      });
    },
    dismiss: (profileId: string, row: NewModelRow): void => {
      save.mutate({
        profileId,
        row,
        buildChange: (profile) => dismissNewModel(profile, row.providerAccountId, row.model),
      });
    },
  };
}

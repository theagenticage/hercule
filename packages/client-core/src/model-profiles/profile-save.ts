/**
 * Saves one change to a Model Profile through the app's query cache. The web
 * app and the desktop app both save this way, so the rules for it live here
 * once. The caller passes the options to its `useMutation`.
 */
import type { DataTag, QueryClient, QueryKey } from "@tanstack/query-core";
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import type { HerculeClient } from "../client";

/** The key of the cached list of Model Profiles, as the app's own query declares it. */
export type ModelProfilesQueryKey = DataTag<QueryKey, readonly ModelProfile[], Error>;

/** What the user did to a model announced as new: take it into the profile, or hide it there for good. */
export interface NewModelEdit {
  readonly action: "add" | "dismiss";
  readonly providerAccountId: string;
  readonly model: string;
}

/**
 * One save: the id of the profile, and the change to make to it. The change is
 * either `buildChange`, which builds it from the profile as it is when the
 * save runs, or `newModelEdit`, which names a change to a "New" row. The
 * composer saves the second kind, which names the change instead of holding
 * its code, so the first screen does not carry the edits.
 */
export type ModelProfileSave =
  | {
      readonly profileId: string;
      readonly buildChange: (profile: ModelProfile) => ModelProfileUpdateInput;
    }
  | { readonly profileId: string; readonly newModelEdit: NewModelEdit };

/**
 * Returns the options of the mutation that saves one change to a Model
 * Profile (`ModelProfileSave`).
 *
 * Every save of every caller shares the "model-profile" mutation scope, so
 * saves run one after the other. The profile is read from the cache when a
 * save's turn comes, not when the user acted, so a save never writes over one
 * that ran before it. The save is sent by `updateModelProfile`, which builds
 * the change again on a fresh read after a `conflict`. The controller's
 * answer replaces the profile in the cache at once. The mutation fails with
 * the reason `readCachedModelProfile` gives, or with the controller's refusal.
 *
 * The code that sends a save is imported when the first save runs, so the
 * first screen does not carry it.
 */
export const buildModelProfileUpdateOptions = (
  client: HerculeClient,
  queryClient: QueryClient,
  profilesKey: ModelProfilesQueryKey,
) => ({
  scope: { id: "model-profile" },
  mutationFn: async (save: ModelProfileSave): Promise<ModelProfile> => {
    const { runModelProfileSave } = await import("./run-profile-save");
    return runModelProfileSave(client, queryClient, profilesKey, save);
  },
  onSuccess: (saved: ModelProfile): void => {
    queryClient.setQueryData(profilesKey, (list) =>
      list?.map((each) => (each.id === saved.id ? saved : each)),
    );
  },
});

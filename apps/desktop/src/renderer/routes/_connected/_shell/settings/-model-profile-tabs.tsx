import { useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  buildModelProfileCopyName,
  countModelProfileEntries,
  readErrorMessage,
  renameModelProfile,
  updateModelProfile,
  type HerculeClient,
} from "@hercule/client-core";
import type { ModelProfile } from "@hercule/contract";
import { modelProfilesQuery } from "../../../../app/queries";
import { ProfileTabs } from "../../../../screens/settings/providers/profile-tabs";
import { DeleteModelProfileDialog } from "./-delete-model-profile-dialog";
import { addCachedModelProfile, replaceCachedModelProfile } from "./-model-profile-cache";
import { useOpenModelProfile } from "./-open-model-profile";

/**
 * Renders the Models section's profile tabs and what their ⌄ menu opens:
 * Rename saves the new name with `modelProfile.update`, Duplicate calls
 * `modelProfile.create` with the profile as the copy's source and opens the
 * copy's tab, and Delete… opens the confirmation. `onNew` opens the
 * New profile dialog.
 *
 * Rename and Duplicate wait in line behind the saves of profiles that are
 * running (the "model-profile" mutation scope), and a rename is built from the
 * newest copy of the profile the page holds, so neither writes over a change
 * the user made just before. A rename the controller refuses shows its message
 * above the tabs, in the tab being edited; a failed Duplicate shows above the
 * tabs.
 */
export function ModelProfileTabs({
  client,
  onNew,
}: {
  readonly client: HerculeClient;
  readonly onNew: () => void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const { profile, profiles, openProfile } = useOpenModelProfile(client);
  const [deleting, setDeleting] = useState<ModelProfile | null>(null);

  const rename = useMutation({
    scope: { id: "model-profile" },
    mutationFn: ({ id, name }: { readonly id: string; readonly name: string }) => {
      const newest = queryClient
        .getQueryData(modelProfilesQuery(client).queryKey)
        ?.find((each) => each.id === id);
      if (newest === undefined) throw new Error("The profile is gone.");
      return updateModelProfile(client, newest, (current) => renameModelProfile(current, name));
    },
    onSuccess: (saved) => {
      replaceCachedModelProfile(queryClient, client, saved);
    },
  });
  const duplicate = useMutation({
    scope: { id: "model-profile" },
    mutationFn: (source: ModelProfile) =>
      client.modelProfile.create({
        payload: {
          name: buildModelProfileCopyName(profiles, source.name),
          copyFromId: source.id,
        },
      }),
    onSuccess: (created) => {
      addCachedModelProfile(queryClient, client, created);
      openProfile(created.id);
    },
  });

  if (profile === undefined) return null;
  return (
    <>
      {duplicate.isError ? (
        <p className="pm-err" role="alert">
          {`Could not duplicate ${profile.name}. ${readErrorMessage(duplicate.error)}`}
        </p>
      ) : null}
      <ProfileTabs
        tabs={profiles.map((each) => ({
          id: each.id,
          name: each.name,
          count: countModelProfileEntries(each),
        }))}
        openId={profile.id}
        onOpen={(id) => {
          duplicate.reset();
          openProfile(id);
        }}
        onNew={onNew}
        onRename={(id, name) =>
          rename.mutateAsync({ id, name }).then(
            () => null,
            (error: unknown) => readErrorMessage(error),
          )
        }
        onDuplicate={(id) => {
          const source = profiles.find((each) => each.id === id);
          if (source !== undefined) duplicate.mutate(source);
        }}
        onDelete={(id) => {
          setDeleting(profiles.find((each) => each.id === id) ?? null);
        }}
      />
      {deleting === null ? null : (
        <DeleteModelProfileDialog
          profile={deleting}
          onDeleted={() => {
            // The first profile left, which is what the page opens when the
            // URL names none.
            const first = profiles.find((each) => each.id !== deleting.id);
            if (first !== undefined) openProfile(first.id);
          }}
          onClose={() => {
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}

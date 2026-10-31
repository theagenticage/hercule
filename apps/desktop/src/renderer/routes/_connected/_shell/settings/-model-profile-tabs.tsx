import { useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  buildModelProfileCopyName,
  countProfileEntries,
  readErrorMessage,
  renameModelProfile,
  updateModelProfile,
  type HerculeClient,
} from "@hercule/client-core";
import type { ModelProfile } from "@hercule/contract";
import { ProfileTabs } from "../../../../screens/settings/providers/profile-tabs";
import { DeleteModelProfileDialog } from "./-delete-model-profile-dialog";
import {
  addCachedModelProfile,
  readCachedModelProfile,
  readCachedModelProfiles,
  replaceCachedModelProfile,
} from "./-model-profile-cache";
import { useOpenModelProfile } from "./-open-model-profile";

/**
 * Renders the Models section's profile tabs and what their ⌄ menu opens:
 * Rename saves the new name with `modelProfile.update`, Duplicate calls
 * `modelProfile.create` with the profile as the copy's source and opens the
 * copy's tab, and Delete… opens the confirmation. `onNew` opens the
 * New profile dialog.
 *
 * Rename and Duplicate wait in line behind the saves of profiles that are
 * running (the "model-profile" mutation scope), and each is built from the
 * newest copy of the profiles the page holds when its turn comes, so neither
 * writes over a change the user made just before, and two quick Duplicates
 * name their copies "Main copy" and "Main copy 2". A rename the controller refuses shows its message
 * above the tabs, in the tab being edited, or, when the user has opened
 * another tab since, as "<name> was not renamed: <message>" above the tabs
 * until the next tab is opened; a blank name is refused without
 * asking the controller; a failed Duplicate shows above the tabs.
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
  // A rename the controller refused after the user had left its tab.
  const [leftRenameError, setLeftRenameError] = useState<string | null>(null);

  const rename = useMutation({
    scope: { id: "model-profile" },
    mutationFn: ({ id, name }: { readonly id: string; readonly name: string }) => {
      const newest = readCachedModelProfile(queryClient, client, id);
      return updateModelProfile(client, newest, (current) => renameModelProfile(current, name));
    },
    onSuccess: (saved) => {
      replaceCachedModelProfile(queryClient, client, saved);
    },
  });
  const duplicate = useMutation({
    scope: { id: "model-profile" },
    // The source and the copy's name are read when the save starts, not when
    // the user clicked: an earlier Duplicate or rename ahead in the line has
    // changed the list by then.
    mutationFn: (sourceId: string) => {
      const source = readCachedModelProfile(queryClient, client, sourceId);
      return client.modelProfile.create({
        payload: {
          name: buildModelProfileCopyName(
            readCachedModelProfiles(queryClient, client),
            source.name,
          ),
          copyFromId: source.id,
        },
      });
    },
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
      {leftRenameError === null ? null : (
        <p className="pm-err" role="alert">
          {leftRenameError}
        </p>
      )}
      <ProfileTabs
        tabs={profiles.map((each) => ({
          id: each.id,
          name: each.name,
          count: countProfileEntries(each),
        }))}
        openId={profile.id}
        onOpen={(id) => {
          duplicate.reset();
          setLeftRenameError(null);
          openProfile(id);
        }}
        onNew={onNew}
        onRename={(id, name) =>
          // A blank name is refused here in plain words: the schema's own
          // message for it is about string lengths.
          name.trim() === ""
            ? Promise.resolve("A profile needs a name.")
            : rename.mutateAsync({ id, name }).then(
                () => null,
                (error: unknown) => readErrorMessage(error),
              )
        }
        onRenameRefusedLater={(profileName, message) => {
          setLeftRenameError(`${profileName} was not renamed: ${message}`);
        }}
        onDuplicate={(id) => {
          duplicate.mutate(id);
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

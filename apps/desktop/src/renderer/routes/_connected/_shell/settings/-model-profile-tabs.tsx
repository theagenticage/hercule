import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  buildModelProfileCopyName,
  countProfileEntries,
  readErrorMessage,
  renameModelProfile,
  type HerculeClient,
} from "@hercule/client-core";
import type { ModelProfile } from "@hercule/contract";
import { ProfileTabs } from "../../../../screens/settings/providers/profile-tabs";
import { DeleteModelProfileDialog } from "./-delete-model-profile-dialog";
import {
  addCachedModelProfile,
  readCachedModelProfile,
  readCachedModelProfiles,
  useModelProfileUpdate,
} from "../../../../app/model-profile-cache";
import { useOpenModelProfile } from "./-open-model-profile";

/** A rename that was asked for and has not been answered, which its tab shows as the profile's name. */
interface PendingRename {
  readonly key: number;
  readonly profileId: string;
  readonly name: string;
}

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
 * name their copies "Main copy" and "Main copy 2".
 *
 * A rename does not hold the editor: the tab shows the new name from the
 * moment the user confirms it until the save is over. A rename the controller
 * refuses shows "<name> was not renamed: <message>" above the tabs, with the
 * tab showing the stored name again, until the next tab is opened or the next
 * rename starts. A failed Duplicate shows above the tabs.
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
  const update = useModelProfileUpdate(client);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [pendingRenames, setPendingRenames] = useState<readonly PendingRename[]>([]);
  const nextRenameKey = useRef(0);

  const rename = (profileId: string, name: string, storedName: string): void => {
    const key = nextRenameKey.current++;
    setRenameError(null);
    setPendingRenames((pending) => [...pending, { key, profileId, name }]);
    update
      .mutateAsync({ profileId, buildChange: (current) => renameModelProfile(current, name) })
      .catch((error: unknown) => {
        setRenameError(`${storedName} was not renamed: ${readErrorMessage(error)}`);
      })
      .finally(() => {
        setPendingRenames((pending) => pending.filter((each) => each.key !== key));
      });
  };

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
      {renameError === null ? null : (
        <p className="pm-err" role="alert">
          {renameError}
        </p>
      )}
      <ProfileTabs
        tabs={profiles.map((each) => ({
          id: each.id,
          name:
            pendingRenames.findLast((pending) => pending.profileId === each.id)?.name ?? each.name,
          count: countProfileEntries(each),
        }))}
        openId={profile.id}
        onOpen={(id) => {
          duplicate.reset();
          setRenameError(null);
          openProfile(id);
        }}
        onNew={onNew}
        onRename={(id, name) => {
          rename(id, name, profiles.find((each) => each.id === id)?.name ?? name);
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

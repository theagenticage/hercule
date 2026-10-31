import { useRef, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  formatNameList,
  isInvalidState,
  isNotFound,
  listProjectsOfModelProfile,
  queryKeys,
  readErrorMessage,
} from "@hercule/client-core";
import type { ModelProfile } from "@hercule/contract";
import { projectsQuery } from "../../../../app/queries";
import { ConfirmDialog } from "../../../../screens/confirm-dialog";
import { removeCachedModelProfile } from "./-model-profile-cache";

/**
 * Renders the dialog that asks before the Model Profile `profile` is deleted
 * (spec 17 §Settings, Providers, Models). It says the profile's menu goes and
 * the accounts and the other profiles stay, and names the projects that use
 * the profile, which then start on the thread default.
 *
 * Delete calls `modelProfile.delete`. A `not_found` reply counts as success,
 * because the profile is gone either way. On success the profile leaves the
 * cached list, the projects are read again because the controller cleared
 * their choice and projects have no live topic, and `onDeleted` is called.
 *
 * The controller refuses to delete the last profile. Asking again changes
 * nothing, so the dialog then shows the controller's message and offers only
 * Cancel. Any other failure is shown and the dialog keeps Delete.
 *
 * The delete is queued behind the saves of profiles that are running, so a
 * change the user made just before is not lost to a profile that is gone.
 * `onClose` is called whenever the dialog closes, also after a delete.
 */
export function DeleteModelProfileDialog({
  profile,
  onDeleted,
  onClose,
}: {
  readonly profile: ModelProfile;
  readonly onDeleted: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const projects = listProjectsOfModelProfile(
    useSuspenseQuery(projectsQuery(client)).data,
    profile.id,
  );
  const remove = useMutation({
    scope: { id: "model-profile" },
    mutationFn: async () => {
      try {
        await client.modelProfile.delete({ params: { id: profile.id } });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    onSuccess: async () => {
      dialogRef.current?.close();
      removeCachedModelProfile(queryClient, client, profile.id);
      onDeleted();
      // Read again, so a read that started before the delete cannot bring
      // the profile back, and the projects lose the profile they named.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.modelProfiles() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
      ]);
    },
  });
  const refused = remove.error !== null && isInvalidState(remove.error);
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={`Delete ${profile.name}?`}
      actionLabel={remove.isPending ? "Deleting…" : "Delete"}
      actionClass="danger"
      closeLabel={refused ? "Cancel" : "Keep it"}
      initialFocus="close"
      pending={remove.isPending}
      refusal={refused ? readErrorMessage(remove.error) : null}
      error={
        remove.error === null || refused
          ? null
          : `Could not delete: ${readErrorMessage(remove.error)}`
      }
      onConfirm={() => {
        remove.mutate();
      }}
      onClose={onClose}
    >
      <p>Its menu goes. Your accounts and the other profiles stay.</p>
      {projects.length === 0 ? null : (
        <p>
          {`${formatNameList(
            projects.map(({ name }) => name),
            "and",
          )} ${projects.length === 1 ? "uses" : "use"} it, and then ${
            projects.length === 1 ? "starts" : "start"
          } on the thread default.`}
        </p>
      )}
    </ConfirmDialog>
  );
}

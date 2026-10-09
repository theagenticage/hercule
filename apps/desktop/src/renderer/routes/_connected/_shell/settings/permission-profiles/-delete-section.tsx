import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { describeProfileInUse, readErrorMessage } from "@hercule/client-core";
import type { Profile } from "@hercule/contract";
import { agentsQuery, profilesQuery } from "../../../../../app/queries";
import { ConfirmDialog } from "../../../../../screens/confirm-dialog";
import type { PosedProfileAgent } from "../../../../../screens/settings/permission-profiles/profile-agent-face";
import { SettingRow } from "../../../../../screens/settings/setting-row";

/**
 * Renders the Delete section of the profile `profile`, which is shown as
 * `profileName` (spec 17 §Settings, Permission profiles):
 *
 * - A shipped profile has no button, only a line that explains why.
 * - A profile that `agents` carry has a disabled button, and a hint that
 *   names those agents.
 * - Any other profile has a button that asks for a confirmation in a dialog
 *   before anything is deleted. The controller can still refuse, for
 *   example while a live session uses the profile. The dialog then stays
 *   open and shows why, and the profiles and agents are read again, so the
 *   page shows what the controller knows.
 *
 * Once the controller has deleted the profile, it is removed from the cached
 * list, which takes the profile's page away.
 */
export function DeleteSection({
  profile,
  profileName,
  agents,
}: {
  readonly profile: Profile;
  readonly profileName: string;
  readonly agents: ReadonlyArray<PosedProfileAgent>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => client.profile.delete({ params: { id: profile.id } }),
    onSuccess: async () => {
      dialogRef.current?.close();
      const { queryKey } = profilesQuery(client);
      queryClient.setQueryData(queryKey, (list) => list?.filter(({ id }) => id !== profile.id));
      // Read again, so a read that started before the delete cannot bring
      // the profile back.
      await queryClient.invalidateQueries({ queryKey });
    },
    // The refusal may mean the lists on screen are out of date: an agent that
    // now uses the profile, or a profile that is already gone.
    onError: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentsQuery(client).queryKey }),
        queryClient.invalidateQueries({ queryKey: profilesQuery(client).queryKey }),
      ]);
    },
  });
  const inUseHint = describeProfileInUse(agents);
  return (
    <section className="set-sec">
      <h2>{`Delete ${profileName}`}</h2>
      {profile.shipped ? (
        <div className="profile-fixed">
          {`${profileName} is shipped with Hercule, so it cannot be deleted. Edit its grants instead.`}
        </div>
      ) : (
        <SettingRow
          label="Delete profile"
          hint={inUseHint ?? "Removes it and its grants."}
          control={(labels) => (
            <button
              type="button"
              className="btn btn--danger"
              // A profile that is in use cannot be deleted. The hint gives the reason.
              disabled={inUseHint !== null}
              {...labels}
              onClick={() => {
                remove.reset();
                setConfirming(true);
              }}
            >
              Delete…
            </button>
          )}
        />
      )}
      {confirming && (
        <ConfirmDialog
          dialogRef={dialogRef}
          title={`Delete ${profileName}?`}
          actionLabel={remove.isPending ? "Deleting…" : "Delete"}
          actionClass="danger"
          pending={remove.isPending}
          error={
            remove.error === null ? null : `Could not delete: ${readErrorMessage(remove.error)}`
          }
          onConfirm={() => {
            remove.mutate();
          }}
          onClose={() => setConfirming(false)}
        >
          <p>{`This removes ${profileName} and its grants. This cannot be undone.`}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { describeProfileDeleteBlock, readErrorMessage } from "@hercule/client-core";
import type { Profile } from "@hercule/contract";
import { profilesQuery } from "../../../../../app/queries";
import { GlassDialog } from "../../../../../screens/glass-dialog";
import type { PosedProfileUser } from "../../../../../screens/settings/permission-profiles/profile-user-face";
import { SettingRow } from "../../../../../screens/settings/setting-row";

/**
 * Renders the Delete section of a profile (spec 17 §Settings, Permission
 * profiles):
 *
 * - A shipped profile has no button, only a line that says why.
 * - A profile that `users` carry has a disabled button, and a hint that
 *   names its users.
 * - Any other profile has a button that asks for a confirmation in a dialog
 *   before anything is deleted. The controller can still refuse, for
 *   example while a live session uses the profile, and the dialog then
 *   stays open and shows why.
 *
 * Once the controller has deleted the profile, it is removed from the cached
 * list, which takes the profile's page away.
 */
export function DeleteSection({
  profile,
  users,
}: {
  readonly profile: Profile;
  readonly users: ReadonlyArray<PosedProfileUser>;
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
  });
  const usedBy = describeProfileDeleteBlock(users);
  return (
    <section className="set-sec">
      <h2>Delete {profile.name}</h2>
      {profile.shipped ? (
        <div className="profile-fixed">
          {profile.name} is shipped with Hercule, so it cannot be deleted. Edit its grants instead.
        </div>
      ) : (
        <SettingRow
          label="Delete profile"
          hint={usedBy ?? "Removes it and its grants. This cannot be undone."}
          control={(labels) => (
            <button
              type="button"
              className="btn btn--danger"
              // A profile that is in use cannot be deleted. The hint says why.
              disabled={usedBy !== null}
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
        <GlassDialog
          dialogRef={dialogRef}
          className="profile-dialog"
          label={`Delete ${profile.name}?`}
          onClose={() => setConfirming(false)}
        >
          <div className="pop-h">
            <b>Delete {profile.name}?</b>
          </div>
          <div className="pop-sec profile-dialog-body">
            <p>This removes {profile.name} and its grants. This cannot be undone.</p>
            {remove.error !== null && (
              <p className="fl-err" role="alert">
                Could not delete: {readErrorMessage(remove.error)}
              </p>
            )}
            <div className="profile-dialog-acts">
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => dialogRef.current?.close()}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                aria-disabled={remove.isPending}
                onClick={() => {
                  if (!remove.isPending) remove.mutate();
                }}
              >
                {remove.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </GlassDialog>
      )}
    </section>
  );
}

import { useRef, useState, type JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import {
  applyGrantChange,
  describeUnrestrictedGrantChange,
  isUnrestrictedProfile,
  readGrantFamily,
  type GrantChange,
} from "@hercule/client-core";
import {
  GRANT_FAMILIES,
  MAX_PROFILE_GRANTS,
  type Grant,
  type GrantFamily,
  type Profile,
} from "@hercule/contract";
import { ConfirmDialog } from "../../../../../screens/confirm-dialog";
import { GrantFamilyRow } from "../../../../../screens/settings/permission-profiles/grant-family-row";
import { useSavedProfileField } from "./-saved-profile-field";

/**
 * Renders the Grants section of the profile `profile`, which is shown as
 * `profileName`: how many of the grants it holds, and one row per grant
 * family with a toggle for each verb. Each press saves at once, with
 * `profile.update` carrying the whole grant list.
 *
 * The profile's grants are one saved field, so the count follows a press as
 * soon as it is made, and not only once the controller has saved it. A
 * failed save puts the toggle back and shows the error under the row of the
 * grant whose save failed.
 *
 * The shipped `unrestricted` profile asks first: a press opens a dialog, and
 * only Change saves.
 */
export function GrantsSection({
  profile,
  profileName,
}: {
  readonly profile: Profile;
  readonly profileName: string;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const grants = useSavedProfileField(
    client,
    profile.id,
    profile.grants,
    applyGrantChange,
    (latest, change: GrantChange) => ({ grants: applyGrantChange(latest.grants, change) }),
  );
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [changeToConfirm, setChangeToConfirm] = useState<GrantChange | null>(null);
  const unrestricted = isUnrestrictedProfile(profile);
  const heldGrants = new Set<Grant>(grants.value);
  const failedFamily =
    grants.failedChange === null ? null : readGrantFamily(grants.failedChange.grant);
  return (
    <section className="set-sec">
      <h2>
        Grants
        <small>{`${heldGrants.size} of ${MAX_PROFILE_GRANTS}`}</small>
      </h2>
      <p>
        What a session on this profile may do through the API. A change reaches its sessions on
        their next call.
      </p>
      {unrestricted && (
        <p className="profile-note">
          Unrestricted is meant to hold every grant, so a session on it can do anything you can.
          Give it only to work you would do yourself.
        </p>
      )}
      {(Object.keys(GRANT_FAMILIES) as GrantFamily[]).map((family) => (
        <GrantFamilyRow
          key={family}
          family={family}
          heldGrants={heldGrants}
          error={family === failedFamily ? grants.error : null}
          onToggle={(change) => {
            if (unrestricted) setChangeToConfirm(change);
            else grants.save(change);
          }}
        />
      ))}
      {changeToConfirm !== null && (
        <ConfirmDialog
          dialogRef={dialogRef}
          title={`Change ${profileName}?`}
          actionLabel="Change"
          actionClass="accent"
          onConfirm={() => {
            grants.save(changeToConfirm);
            dialogRef.current?.close();
          }}
          onClose={() => {
            setChangeToConfirm(null);
          }}
        >
          <p>{describeUnrestrictedGrantChange(profileName, changeToConfirm)}</p>
          <p>
            {`Threads run on ${profileName} unless you pick another profile, so the change reaches them on their next call.`}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

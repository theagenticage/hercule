import { useState, type JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import { isUnrestrictedProfile, setGrantHeld } from "@hercule/client-core";
import {
  GRANT_FAMILIES,
  MAX_PROFILE_GRANTS,
  type Grant,
  type GrantFamily,
  type Profile,
} from "@hercule/contract";
import { ConfirmGrantChangeDialog } from "../../../../../screens/settings/permission-profiles/confirm-grant-change-dialog";
import { GrantFamilyRow } from "../../../../../screens/settings/permission-profiles/grant-family-row";
import { useSavedProfileField } from "./-saved-profile-field";

/** One grant put into a profile or taken out of it. */
interface GrantChange {
  readonly grant: Grant;
  readonly held: boolean;
}

/**
 * Renders the Grants section of a profile: how many of the grants it holds,
 * and one row per grant family with a toggle for each verb. Each press saves
 * at once, with `profile.update` carrying the whole grant list.
 *
 * The profile's grants are one saved field, so the count follows a press
 * before its save answers. A failed save puts the toggle back and shows the
 * error under the row of the grant that was pressed last, which is the save
 * that failed.
 *
 * The shipped `unrestricted` profile asks first: a press opens a dialog, and
 * only Change saves.
 */
export function GrantsSection({ profile }: { readonly profile: Profile }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const grants = useSavedProfileField(
    client,
    profile.id,
    profile.grants,
    (value, change: GrantChange) => setGrantHeld(value, change.grant, change.held),
    // Built onto the profile as the cache holds it when the save starts, so a
    // save never puts back a grant that an earlier save or another writer changed.
    (latest, change) => ({ grants: setGrantHeld(latest.grants, change.grant, change.held) }),
  );
  const [lastFamily, setLastFamily] = useState<GrantFamily | null>(null);
  const [asking, setAsking] = useState<GrantChange | null>(null);
  const unrestricted = isUnrestrictedProfile(profile);
  const held = new Set<Grant>(grants.value);
  const save = (change: GrantChange): void => {
    setLastFamily(change.grant.split(".")[0] as GrantFamily);
    grants.save(change);
  };
  return (
    <section className="set-sec">
      <h2>
        Grants
        <small>{`${held.size} of ${MAX_PROFILE_GRANTS}`}</small>
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
          held={held}
          error={family === lastFamily ? grants.error : null}
          onToggle={(grant, nowHeld) => {
            const change = { grant, held: nowHeld };
            if (unrestricted) setAsking(change);
            else save(change);
          }}
        />
      ))}
      {asking !== null && (
        <ConfirmGrantChangeDialog
          profileName={profile.name}
          grant={asking.grant}
          held={asking.held}
          onConfirm={() => {
            save(asking);
          }}
          onClose={() => {
            setAsking(null);
          }}
        />
      )}
    </section>
  );
}

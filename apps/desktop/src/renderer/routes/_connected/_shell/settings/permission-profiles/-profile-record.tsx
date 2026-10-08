import type { JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import type { Profile } from "@hercule/contract";
import { SettingsHeaderTitle } from "../../../../../screens/settings/settings-frame";
import { SettingRow } from "../../../../../screens/settings/setting-row";
import { UsedBySection } from "../../../../../screens/settings/permission-profiles/used-by-section";
import type { PosedProfileUser } from "../../../../../screens/settings/permission-profiles/profile-user-face";
import { useTextDraft } from "../../../../../screens/settings/use-text-draft";
import { DeleteSection } from "./-delete-section";
import { GrantsSection } from "./-grants-section";
import { useSavedProfileField } from "./-saved-profile-field";
import "../../../../../screens/settings/permission-profiles/permission-profiles.css";

/**
 * Renders the page of one profile: its name, its grants, the agents and
 * assistants that use it, and Delete. Each change to the name or a grant
 * saves as soon as it is made.
 *
 * The header's title is the profile's name, so it follows a rename as soon as
 * the rename is made.
 */
export function ProfileRecord({
  profile,
  users,
}: {
  readonly profile: Profile;
  readonly users: ReadonlyArray<PosedProfileUser>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const name = useSavedProfileField(
    client,
    profile.id,
    profile.name,
    (_value, next: string) => next,
    (_latest, next) => ({ name: next }),
  );
  const nameInput = useTextDraft(name.value, name.save);
  return (
    <div className="profile-record">
      <SettingsHeaderTitle
        parent={{ title: "Permission profiles", to: "/settings/permission-profiles" }}
        title={name.value}
      />
      <section className="set-sec">
        <h2>Profile</h2>
        <SettingRow
          label="Name"
          hint="Shown wherever a profile is picked."
          error={name.error}
          control={(labels) => (
            <span className="field">
              <input type="text" {...labels} {...nameInput} />
            </span>
          )}
        />
      </section>
      <GrantsSection profile={profile} />
      <UsedBySection profileName={name.value} users={users} />
      <DeleteSection profile={profile} users={users} />
    </div>
  );
}

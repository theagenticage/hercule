import type { JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import { MAX_PROFILE_NAME_LENGTH, type Profile } from "@hercule/contract";
import { SettingsHeaderTitle } from "../../../../../screens/settings/settings-frame";
import { SettingRow } from "../../../../../screens/settings/setting-row";
import { UsedBySection } from "../../../../../screens/settings/permission-profiles/used-by-section";
import type { PosedProfileAgent } from "../../../../../screens/settings/permission-profiles/profile-agent-face";
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
 * The name is one saved field, and every part of the page shows its value,
 * so the header, Used by, Delete and the grant confirmation follow a rename
 * as soon as it is made, and never show two names at once. A name that is
 * empty or only spaces is not saved: the field shows the saved name again.
 */
export function ProfileRecord({
  profile,
  agents,
}: {
  readonly profile: Profile;
  readonly agents: ReadonlyArray<PosedProfileAgent>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const name = useSavedProfileField(
    client,
    profile.id,
    profile.name,
    (_value, next: string) => next,
    (_latest, next) => ({ name: next }),
  );
  const nameInput = useTextDraft(name.value, (text) => {
    if (text.trim() !== "") name.save(text);
  });
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
              <input type="text" maxLength={MAX_PROFILE_NAME_LENGTH} {...labels} {...nameInput} />
            </span>
          )}
        />
      </section>
      <GrantsSection profile={profile} profileName={name.value} />
      <UsedBySection profileName={name.value} agents={agents} />
      <DeleteSection profile={profile} profileName={name.value} agents={agents} />
    </div>
  );
}

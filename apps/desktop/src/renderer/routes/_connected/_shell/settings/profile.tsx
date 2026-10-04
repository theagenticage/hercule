import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  buildIdOptions,
  FALLBACK_TIMEZONE,
  filterGitHubConnections,
  listTimezoneChoices,
} from "@hercule/client-core";
import { rememberSettingsSection } from "../../../../app/last-settings-section";
import { connectionsQuery, readOnOpen, settingsQuery, userQuery } from "../../../../app/queries";
import { signOut } from "../../../../app/sign-out";
import { UserAvatar } from "../../../../faces";
import { SettingRow } from "../../../../screens/settings/setting-row";
import { useSavedSetting } from "./-saved-setting";

/**
 * Settings > Profile: the user's avatar and name, their time zone, their
 * default GitHub account, and Sign out (spec 17 §Settings, Profile). The
 * time zone and the GitHub account save as soon as they are picked.
 *
 * The loader reads the settings each time the section opens, because no live
 * topic keeps them current: another client may have changed them. The user
 * and the Connections are the shell's reads, which the live connection keeps
 * current.
 */
export const Route = createFileRoute("/_connected/_shell/settings/profile")({
  staticData: { title: "Profile" },
  loader: ({ context: { controller, queryClient } }) =>
    readOnOpen(queryClient, settingsQuery(controller.client)),
  onEnter: () => {
    rememberSettingsSection("/settings/profile");
  },
  component: Profile,
});

function Profile(): JSX.Element {
  const { controller } = Route.useRouteContext();
  const router = useRouter();
  const { username } = useSuspenseQuery(userQuery(controller.client)).data;
  return (
    <>
      <div className="head">
        <UserAvatar name={username} size={64} />
        <h2>{username}</h2>
      </div>
      <section className="set-sec">
        <TimezoneRow />
        <DefaultGitHubAccountRow />
        <SettingRow
          label="Sign out"
          hint="This Mac keeps you signed in until you sign out."
          control={(labels) => (
            <button
              type="button"
              className="btn"
              {...labels}
              onClick={() => {
                signOut(controller, router);
              }}
            >
              Sign out
            </button>
          )}
        />
      </section>
    </>
  );
}

/** Renders the time zone row: the zone every time on screen is shown in. */
function TimezoneRow(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const timezone = useSavedSetting(
    client,
    settings.user.timezone ?? FALLBACK_TIMEZONE,
    (zone: string) => ({ user: { timezone: zone } }),
  );
  return (
    <SettingRow
      label="Time zone"
      hint="Schedules, ages and every time on screen are read in this zone."
      error={timezone.error}
      control={(labels) => (
        <span className="field field--select">
          <select
            {...labels}
            value={timezone.value}
            onChange={(event) => timezone.save(event.target.value)}
          >
            {listTimezoneChoices(timezone.value).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </span>
      )}
    />
  );
}

/**
 * Renders the row that picks the user's default GitHub account: the
 * Connection a thread or an assistant acts through when its workspace names
 * none. "None" saves `null`, because the setting is nullable and the
 * contract's `Id` refuses an empty string.
 */
function DefaultGitHubAccountRow(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const connections = useSuspenseQuery(connectionsQuery(client)).data;
  const account = useSavedSetting(
    client,
    settings.user["github.defaultConnectionId"] ?? null,
    (id: string | null) => ({ user: { "github.defaultConnectionId": id } }),
  );
  const options = buildIdOptions(
    filterGitHubConnections(connections).map(({ id, label }) => ({ id, label })),
    account.value,
  );
  return (
    <SettingRow
      label="Default GitHub account"
      hint="A thread working in a checkout acts through that repo's own Connection. Every other thread, and every assistant, acts through this account."
      error={account.error}
      control={(labels) => (
        <span className="field field--select">
          <select
            {...labels}
            value={account.value ?? ""}
            onChange={(event) =>
              account.save(event.target.value === "" ? null : event.target.value)
            }
          >
            <option value="">None</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </span>
      )}
    />
  );
}

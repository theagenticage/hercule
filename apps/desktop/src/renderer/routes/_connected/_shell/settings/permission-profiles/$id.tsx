import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import { rememberSettingsSection } from "../../../../../app/last-settings-section";
import {
  agentsQuery,
  assistantsQuery,
  profilesQuery,
  readOnOpen,
} from "../../../../../app/queries";
import { ProfileRecord } from "./-profile-record";
import { useProfileUsers } from "./-profile-users";

/**
 * Settings > Permission profiles, the page of one profile: its name, its
 * grants, who uses it, and Delete. Every change saves as soon as it is made
 * (spec 17 §Settings, Permission profiles). The header reads "Settings /
 * Permission profiles / <name>", with the list linked.
 *
 * An id that names no profile goes back to the list, once the read has
 * answered. The section remembers its list, never one profile's page.
 *
 * The loader reads what the list reads, because the page shows the profile's
 * users: the profiles and the agents on every open, and the assistants from
 * the shell's read.
 */
export const Route = createFileRoute("/_connected/_shell/settings/permission-profiles/$id")({
  staticData: { title: "Permission profiles" },
  loader: async ({ context: { controller, queryClient }, params: { id } }) => {
    const { client } = controller;
    const [profiles] = await Promise.all([
      readOnOpen(queryClient, profilesQuery(client)),
      readOnOpen(queryClient, agentsQuery(client)),
      queryClient.ensureQueryData(assistantsQuery(client)),
    ]);
    if (!profiles.some((profile) => profile.id === id)) {
      // The router redirects when a `redirect` is thrown. The thrown value is
      // a plain descriptor rather than an Error.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: "/settings/permission-profiles", replace: true });
    }
  },
  onEnter: () => {
    rememberSettingsSection("/settings/permission-profiles");
  },
  component: PermissionProfile,
});

function PermissionProfile(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const { id } = Route.useParams();
  const profile = useSuspenseQuery(profilesQuery(client)).data.find((each) => each.id === id);
  const usersByProfile = useProfileUsers();
  // The profile is gone from the cache once Delete has deleted it, and the
  // page goes back to the list.
  if (profile === undefined) return <Navigate to="/settings/permission-profiles" replace />;
  return (
    <ProfileRecord
      // A new record per profile, so no field keeps another profile's edit or error.
      key={profile.id}
      profile={profile}
      users={usersByProfile.get(profile.id) ?? []}
    />
  );
}

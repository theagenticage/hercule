import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { rememberSettingsSection } from "../../../../../app/last-settings-section";
import { agentsQuery, assistantsQuery, profilesQuery } from "../../../../../app/queries";
import { useAgentsByProfile } from "./-agents-by-profile";
import { ProfileRecord } from "./-profile-record";

/**
 * Settings > Permission profiles, the page of one profile: its name, its
 * grants, who uses it, and Delete. Every change saves as soon as it is made
 * (spec 17 §Settings, Permission profiles). The header reads "Settings /
 * Permission profiles / <name>", with the list linked.
 *
 * An id that names no profile, or a profile that has just been deleted, goes
 * back to the list. The section remembers its list, never one profile's page.
 *
 * The loader reads what the list reads, because the page shows the agents
 * that use the profile. The page is reached from the list, which has just
 * read the profiles and the agents, so the loader uses what the cache holds
 * and reads only what it lacks, as when the app opens at this address.
 */
export const Route = createFileRoute("/_connected/_shell/settings/permission-profiles/$id")({
  staticData: { title: "Permission profiles" },
  loader: async ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    await Promise.all([
      queryClient.ensureQueryData(profilesQuery(client)),
      queryClient.ensureQueryData(agentsQuery(client)),
      queryClient.ensureQueryData(assistantsQuery(client)),
    ]);
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
  const agentsByProfile = useAgentsByProfile();
  // The profile is gone from the cache once Delete has deleted it, and the
  // page goes back to the list.
  if (profile === undefined) return <Navigate to="/settings/permission-profiles" replace />;
  return (
    <ProfileRecord
      // A new record per profile, so no field keeps another profile's edit or error.
      key={profile.id}
      profile={profile}
      agents={agentsByProfile.get(profile.id) ?? []}
    />
  );
}

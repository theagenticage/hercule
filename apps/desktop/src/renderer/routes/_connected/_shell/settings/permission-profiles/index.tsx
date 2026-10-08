import type { JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { chooseNewProfileName, readErrorMessage, sortProfiles } from "@hercule/client-core";
import { rememberSettingsSection } from "../../../../../app/last-settings-section";
import {
  agentsQuery,
  assistantsQuery,
  profilesQuery,
  readOnOpen,
} from "../../../../../app/queries";
import { PlusIcon } from "../../../../../icons/plus";
import { ProfileList } from "../../../../../screens/settings/permission-profiles/profile-list";
import { SettingsHeaderActions } from "../../../../../screens/settings/settings-frame";
import { useAgentsByProfile } from "./-agents-by-profile";

/**
 * Settings > Permission profiles, the list: one row per profile, shipped
 * profiles first, each leading to the profile's page. The header's New
 * profile button creates a profile with no grants and opens its page (spec 17
 * §Settings, Permission profiles).
 *
 * The profiles and the agents have no live topic, so the loader reads them
 * each time the section opens. A failed create reads the profiles again. The assistants are the shell's read, which the
 * live connection keeps current.
 */
export const Route = createFileRoute("/_connected/_shell/settings/permission-profiles/")({
  staticData: { title: "Permission profiles" },
  loader: async ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    await Promise.all([
      readOnOpen(queryClient, profilesQuery(client)),
      readOnOpen(queryClient, agentsQuery(client)),
      queryClient.ensureQueryData(assistantsQuery(client)),
    ]);
  },
  onEnter: () => {
    rememberSettingsSection("/settings/permission-profiles");
  },
  component: PermissionProfiles,
});

function PermissionProfiles(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profiles = useSuspenseQuery(profilesQuery(client)).data;
  const agentsByProfile = useAgentsByProfile();

  const create = useMutation({
    mutationFn: () =>
      client.profile.create({ payload: { name: chooseNewProfileName(profiles), grants: [] } }),
    onSuccess: async (created) => {
      // Added to the cached list first, so the profile's page finds it.
      const { queryKey } = profilesQuery(client);
      queryClient.setQueryData(queryKey, (list) =>
        list === undefined ? list : [...list, created],
      );
      await navigate({ to: "/settings/permission-profiles/$id", params: { id: created.id } });
      // Read again, so a read that started before the create cannot leave
      // the list without the new profile.
      await queryClient.invalidateQueries({ queryKey });
    },
    // A refusal, such as a name that is taken, may mean the list on screen is
    // out of date. Reading it again lets a retry choose a name that is free.
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: profilesQuery(client).queryKey });
    },
  });

  return (
    <>
      <SettingsHeaderActions>
        <button
          type="button"
          className="btn btn--sm"
          aria-disabled={create.isPending}
          onClick={() => {
            if (!create.isPending) create.mutate();
          }}
        >
          <PlusIcon size={14} />
          New profile
        </button>
      </SettingsHeaderActions>
      {create.error !== null && (
        <p className="set-err" role="alert">
          {`Could not create the profile: ${readErrorMessage(create.error)}`}
        </p>
      )}
      <ProfileList
        entries={sortProfiles(profiles).map((profile) => ({
          profile,
          agents: agentsByProfile.get(profile.id) ?? [],
        }))}
      />
    </>
  );
}

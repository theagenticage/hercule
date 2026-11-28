import { useMemo, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  buildModelMenu,
  resolveDisplayTimezone,
  type HerculeClient,
  type ThreadCatalogs,
} from "@hercule/client-core";
import type { ModelProfile } from "@hercule/contract";
import {
  harnessesQuery,
  modelProfilesQuery,
  pluginsQuery,
  providerAccountsQuery,
  providersQuery,
  runnersQuery,
  settingsQuery,
} from "../../../../app/queries";
import { ProfilePreview } from "../../../../screens/settings/providers/profile-preview";

/**
 * Renders the preview of the open Model Profile `profile`: the composer's
 * model menu for a new thread that has picked nothing, with `profile`
 * unfolded, built by `buildModelMenu` from the same records the composer
 * reads. The menu is built again only when one of those records changes, not
 * when the pointer moves.
 *
 * `highlightedAccountId`, `onEnterLane` and `onLeaveLane` link the preview's
 * lanes to the page's sections (see `ProfilePreview`).
 *
 * Everything it reads is a shell read that the live connection keeps current,
 * so showing the preview sends no request. The Providers route's loader makes
 * sure the settings, whose time zone sets the dates on the "New" rows, are
 * cached.
 */
export function ModelProfilePreview({
  client,
  profile,
  highlightedAccountId,
  onEnterLane,
  onLeaveLane,
}: {
  readonly client: HerculeClient;
  readonly profile: ModelProfile;
  readonly highlightedAccountId: string | null;
  readonly onEnterLane: (providerAccountId: string) => void;
  readonly onLeaveLane: (providerAccountId: string) => void;
}): JSX.Element {
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const modelProfiles = useSuspenseQuery(modelProfilesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );

  const menu = useMemo(() => {
    const catalogs: ThreadCatalogs = {
      accounts,
      providers,
      harnesses,
      modelProfiles,
      runners,
      thisMacRunnerId: null,
    };
    return buildModelMenu(
      catalogs,
      { providerAccountId: null, harnessId: null, model: null, runnerId: null, projectId: null },
      {
        kind: "draft",
        filter: "",
        recent: [],
        openedProfileId: profile.id,
        lastOpenProfileId: null,
        runnerId: null,
        now: new Date(),
        timezone,
      },
    );
  }, [accounts, providers, harnesses, modelProfiles, runners, profile.id, timezone]);

  return (
    <ProfilePreview
      menu={menu}
      profileName={profile.name}
      providers={providers}
      plugins={plugins}
      highlightedAccountId={highlightedAccountId}
      onEnterLane={onEnterLane}
      onLeaveLane={onLeaveLane}
    />
  );
}

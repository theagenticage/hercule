import { useMemo, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { buildModelMenu, type HerculeClient, type ThreadCatalogs } from "@hercule/client-core";
import type { ModelProfile } from "@hercule/contract";
import {
  harnessesQuery,
  modelProfilesQuery,
  pluginsQuery,
  providerAccountsQuery,
  providersQuery,
  runnersQuery,
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
 * so showing the preview sends no request.
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
      },
    );
  }, [accounts, providers, harnesses, modelProfiles, runners, profile.id]);

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

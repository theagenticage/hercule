import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { findModelProfileOrFirst, type HerculeClient } from "@hercule/client-core";
import { isId, type ModelProfile } from "@hercule/contract";
import { modelProfilesQuery } from "../../../../app/queries";

const PROVIDERS_ROUTE = "/_connected/_shell/settings/providers";

/** The search parameters of Settings > Providers. */
export interface ProvidersSearch {
  /** The id of the Model Profile whose tab is open on Models. */
  readonly profile?: string;
}

/** Returns the search parameters of Settings > Providers from the URL's. A `profile` that is not an id is dropped. */
export const validateProvidersSearch = (search: Record<string, unknown>): ProvidersSearch =>
  isId(search.profile) ? { profile: search.profile } : {};

/**
 * Returns the Model Profile open on Settings > Providers, every profile, and
 * a function that opens another one. The open profile is the one the URL's
 * `profile` names, or the first profile when the URL names none or names a
 * profile that was deleted. Anything on the page that acts on "the open
 * profile" reads it here, so they all agree on which one it is.
 *
 * `profile` is `undefined` only when there is no profile at all. The profiles
 * are the shell's read, which the live connection keeps current.
 */
export function useOpenModelProfile(client: HerculeClient): {
  readonly profile: ModelProfile | undefined;
  readonly profiles: readonly ModelProfile[];
  readonly openProfile: (id: string) => void;
} {
  const profiles = useSuspenseQuery(modelProfilesQuery(client)).data;
  const { profile: openId } = useSearch({ from: PROVIDERS_ROUTE });
  const navigate = useNavigate();
  return {
    profile: findModelProfileOrFirst(profiles, openId),
    profiles,
    // Switching tabs replaces the history entry, so Back leaves the page.
    openProfile: (id) => {
      void navigate({ to: "/settings/providers", search: { profile: id }, replace: true });
    },
  };
}

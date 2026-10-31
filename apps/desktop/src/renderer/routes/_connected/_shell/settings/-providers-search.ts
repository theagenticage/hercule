import { isId } from "@hercule/contract";

/** The search parameters of Settings > Providers. */
export interface ProvidersSearch {
  /** The id of the Model Profile whose tab is open on Models. */
  readonly profile?: string;
}

/** Returns the search parameters of Settings > Providers from the URL's. A `profile` that is not an id is dropped. */
export const validateProvidersSearch = (search: Record<string, unknown>): ProvidersSearch =>
  isId(search.profile) ? { profile: search.profile } : {};

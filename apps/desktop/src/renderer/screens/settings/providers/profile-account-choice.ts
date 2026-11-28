import type { ProviderAccountIdentityLine } from "@hercule/client-core";

/**
 * One Provider Account that a Model Profile does not hold yet, as the
 * "Add an account to <profile>" menu and the empty profile's tiles offer it.
 */
export interface ProfileAccountChoice {
  readonly providerAccountId: string;
  /** The account's name, such as "Anthropic · Work". */
  readonly name: string;
  /** The id of the plugin whose mark the provider wears; `null` when no provider is registered for it any more. */
  readonly pluginId: string | null;
  /** Who is signed in and the plan, shown small under the name. */
  readonly identity: ProviderAccountIdentityLine;
}

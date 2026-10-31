/**
 * What a client says about a Provider Account (spec 06 §15.3): its name, and
 * how it signs in. Every screen reads these from here, so no two screens name
 * the same account differently.
 */
import type { AccountKind, Provider, ProviderAccount } from "@hercule/contract";
import type { CredentialField } from "./connection-types";

/** The part of an account that decides its name. */
type NamedAccount = Pick<ProviderAccount, "providerId" | "label">;

/**
 * Returns the name of the account: its provider's display name, then " · "
 * and its label when it has one, such as "Anthropic" or "Anthropic · work".
 * When no provider is registered under the account's provider id any more, the
 * id stands in for the display name.
 */
export const buildProviderAccountName = (
  providers: readonly Provider[],
  account: NamedAccount,
): string => {
  const providerName =
    providers.find((provider) => provider.id === account.providerId)?.displayName ??
    account.providerId;
  return account.label === null ? providerName : `${providerName} · ${account.label}`;
};

/**
 * Returns the account's name when the user has more than one account at the
 * account's provider, or `null` when it is the only one. A single account
 * does not need a name to tell it apart.
 */
export const findAccountNameIfAmbiguous = (
  accounts: readonly ProviderAccount[],
  providers: readonly Provider[],
  account: ProviderAccount,
): string | null =>
  accounts.filter((each) => each.providerId === account.providerId).length > 1
    ? buildProviderAccountName(providers, account)
    : null;

/** Returns the Account Kind the account was created as, or `undefined` when its provider no longer declares it. */
export const findAccountKind = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId" | "kind">,
): AccountKind | undefined =>
  providers
    .find((provider) => provider.id === account.providerId)
    ?.kinds.find((kind) => kind.id === account.kind);

/**
 * Checks whether the account signs in on each machine: its kind has a
 * `harness-login` setup step. Such an account is signed in on a runner by
 * `providerAccount.signIn`; any other kind has a credential the controller
 * keeps and every runner uses.
 */
export const requiresSignInPerMachine = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId" | "kind">,
): boolean =>
  findAccountKind(providers, account)?.setup.some((step) => step.kind === "harness-login") ?? false;

/**
 * Returns the fields the user types in to set the account's credential, from
 * its kind's `credentials` setup steps, such as the `apiKey` field. Returns
 * none for a kind that signs in on each machine.
 */
export const listAccountCredentialFields = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId" | "kind">,
): readonly CredentialField[] =>
  (findAccountKind(providers, account)?.setup ?? []).flatMap((step) =>
    step.kind === "credentials" ? step.fields : [],
  );

/** The line under an account's name, in the two parts the card keeps apart so a long identity can be cut short. */
export interface AccountIdentityLine {
  /** The identity the account is signed in as, such as "rogier@acme.com", or the kind's title when none is known. */
  readonly text: string;
  /** The plan the vendor reports, such as "Max", or `null` when no identity or no plan is known. */
  readonly plan: string | null;
}

/**
 * Returns the line under an account's name: who is signed in and the plan,
 * such as "rogier@acme.com" and "Max", when the account knows its identity.
 * Otherwise `text` is the title of the account's kind, such as "API key", or
 * the kind's id when the provider no longer declares it.
 */
export const describeAccountIdentity = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId" | "kind" | "identity" | "planLabel">,
): AccountIdentityLine =>
  account.identity === null
    ? { text: findAccountKind(providers, account)?.title ?? account.kind, plan: null }
    : { text: account.identity, plan: account.planLabel };

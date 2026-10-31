/**
 * What a client says about a Provider Account (spec 06 §15.3): its name, and
 * how it signs in. Every screen reads these from here, so no two screens name
 * the same account differently.
 */
import type {
  AccountKind,
  CapabilitySnapshot,
  Harness,
  Provider,
  ProviderAccount,
} from "@hercule/contract";
import type { CredentialField } from "./connection-types";

/** The part of an account that decides its name. */
type NamedProviderAccount = Pick<ProviderAccount, "providerId" | "label">;

/**
 * Returns the name of the account: its provider's display name, then " · "
 * and its label when it has one, such as "Anthropic" or "Anthropic · work".
 * When no provider is registered under the account's provider id any more, the
 * id stands in for the display name.
 */
export const buildProviderAccountName = (
  providers: readonly Provider[],
  account: NamedProviderAccount,
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
export const findProviderAccountNameIfAmbiguous = (
  accounts: readonly ProviderAccount[],
  providers: readonly Provider[],
  account: ProviderAccount,
): string | null =>
  accounts.filter((each) => each.providerId === account.providerId).length > 1
    ? buildProviderAccountName(providers, account)
    : null;

/**
 * Returns the id of the plugin that registered the account's Provider, or
 * `null` when no registered Provider matches the account's provider id any
 * more. The id comes from the Provider itself, never from its qualified id.
 */
export const findProviderPluginId = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId">,
): string | null =>
  providers.find((provider) => provider.id === account.providerId)?.pluginId ?? null;

/**
 * Returns the harness a thread, an Agent or an assistant runs in on `account`:
 * the harness it names, or the account's default harness when it names none.
 */
export const resolveThreadHarnessId = (
  account: Pick<ProviderAccount, "defaultHarnessId">,
  harnessId: string | null | undefined,
): string => harnessId ?? account.defaultHarnessId;

/**
 * Returns the account's snapshot in its default harness on the runner
 * `runnerId`, or `undefined` when that runner has not probed it. Callers decide
 * what the snapshot's `auth` means for them.
 */
export const findDefaultHarnessSnapshot = (
  account: Pick<ProviderAccount, "defaultHarnessId" | "snapshots">,
  runnerId: string,
): CapabilitySnapshot | undefined =>
  account.snapshots.find(
    (snapshot) => snapshot.harnessId === account.defaultHarnessId && snapshot.runnerId === runnerId,
  );

/**
 * Returns the account's snapshots in its default harness that found it signed
 * in, one for each runner. The list is empty when no runner has the account
 * signed in there.
 */
export const listSignedInDefaultHarnessSnapshots = (
  account: Pick<ProviderAccount, "defaultHarnessId" | "snapshots">,
): readonly CapabilitySnapshot[] =>
  account.snapshots.filter(
    (snapshot) => snapshot.harnessId === account.defaultHarnessId && snapshot.auth.status === "ok",
  );

/** Returns the Account Kind the account was created as, or `undefined` when its provider no longer declares it. */
export const findProviderAccountKind = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId" | "kind">,
): AccountKind | undefined =>
  providers
    .find((provider) => provider.id === account.providerId)
    ?.kinds.find((kind) => kind.id === account.kind);

/**
 * Checks whether the account has a login on each machine: the harness that
 * runs it keeps the login in its Harness Home, because the harness declares no
 * `credentialVariable` for the account's kind (spec 06 section 2). Such an
 * account is signed in on a runner by `providerAccount.signIn`. Any other
 * account has a credential the controller keeps and every machine uses, however
 * the user obtains it.
 *
 * The harness is the one named by `harnessId`, or the account's default
 * harness. Returns `false` when that harness is not registered or does not
 * declare the account's provider and kind.
 */
export const requiresSignInPerMachine = (
  harnesses: readonly Harness[],
  account: Pick<ProviderAccount, "providerId" | "kind" | "defaultHarnessId">,
  harnessId?: string | null,
): boolean => {
  const kind = harnesses
    .find((harness) => harness.id === resolveThreadHarnessId(account, harnessId))
    ?.runs.find((support) => support.providerId === account.providerId)
    ?.kinds.find((each) => each.kind === account.kind);
  return kind !== undefined && kind.credentialVariable === undefined;
};

/**
 * Returns the fields the user types in to set the account's credential, from
 * its kind's `credentials` setup steps, such as the `apiKey` field. Returns
 * none for a kind that signs in on each machine.
 */
export const listProviderAccountCredentialFields = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId" | "kind">,
): readonly CredentialField[] =>
  (findProviderAccountKind(providers, account)?.setup ?? []).flatMap((step) =>
    step.kind === "credentials" ? step.fields : [],
  );

/** The line under an account's name, in the two parts the card keeps apart so a long identity can be cut short. */
export interface ProviderAccountIdentityLine {
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
export const describeProviderAccountIdentity = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId" | "kind" | "identity" | "planLabel">,
): ProviderAccountIdentityLine =>
  account.identity === null
    ? { text: findProviderAccountKind(providers, account)?.title ?? account.kind, plan: null }
    : { text: account.identity, plan: account.planLabel };

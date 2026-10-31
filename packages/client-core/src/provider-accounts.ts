/**
 * What a client says about a Provider Account (spec 06 §15.3): its name, and
 * how it signs in. Every screen reads these from here, so no two screens name
 * the same account differently.
 */
import type {
  AccountKind,
  AccountSetupStep,
  CapabilitySnapshot,
  Provider,
  ProviderAccount,
  ProviderAccountReadinessState,
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

/**
 * Returns whether `account` can run in `harnessId` on the runner `runnerId`,
 * as the controller worked it out when it sent the account. Returns
 * `harness-missing` when the account has no row for that pair: the account's
 * kind or the harness does not allow the combination, or the runner is
 * retired or unknown. Online or draining is not part of the answer; the
 * caller reads that from the runner.
 */
export const findProviderAccountReadiness = (
  account: Pick<ProviderAccount, "readiness">,
  harnessId: string,
  runnerId: string,
): ProviderAccountReadinessState =>
  account.readiness.find((row) => row.harnessId === harnessId && row.runnerId === runnerId)
    ?.state ?? "harness-missing";

/** Returns the Account Kind the account was created as, or `undefined` when its provider no longer declares it. */
export const findProviderAccountKind = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId" | "kind">,
): AccountKind | undefined =>
  providers
    .find((provider) => provider.id === account.providerId)
    ?.kinds.find((kind) => kind.id === account.kind);

/** How a `harness-login` step gets the account its credential: a login on one machine, or a token made once. */
export type HarnessLoginMethod = Extract<AccountSetupStep, { kind: "harness-login" }>["method"];

/**
 * Returns how the account's kind gets its credential through its harness's
 * login, or `null` when the kind has no `harness-login` step, as a key kind
 * does: its user types the credential in. The login is the one that
 * `providerAccount.signIn` starts.
 */
export const findHarnessLoginMethod = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId" | "kind">,
): HarnessLoginMethod | null => {
  const step = findProviderAccountKind(providers, account)?.setup.find(
    (each) => each.kind === "harness-login",
  );
  return step?.kind === "harness-login" ? step.method : null;
};

/**
 * Checks whether the account's login lives on each machine: its kind has a
 * `harness-login` step with the `sign-in` method, so the harness keeps the
 * login in its Harness Home and `providerAccount.signIn` signs in one machine
 * at a time. Any other account has a credential the controller keeps and every
 * machine uses: a key the user types in, or a token Hercule made
 * (`create-token`). Returns `false` when the provider no longer declares the
 * account's kind.
 */
export const signsInPerMachine = (
  providers: readonly Provider[],
  account: Pick<ProviderAccount, "providerId" | "kind">,
): boolean => findHarnessLoginMethod(providers, account) === "sign-in";

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

/**
 * Turns a stored Model Profile into the `ModelProfile` a client reads: every
 * entry gets its harness, its name, its options and whether it can run now.
 * It is pure. The service reads the accounts (with their readiness and
 * snapshots), the Model Catalogs, the connected runners, the providers and the
 * harnesses once for all profiles, and passes them in, so resolving an entry
 * never queries.
 */
import {
  findSnapshotModel,
  isModelMissingFromHarness,
  type EntryProblem,
  type ModelCatalog,
  type DismissedNewModel,
  type ModelProfile,
  type ModelProfileEntry,
  type NewModel,
  type ProviderAccount,
  type ProviderAccountReadinessState,
  type ResolvedModelProfileAccount,
  type ResolvedModelProfileEntry,
} from "@hercule/contract";
import {
  decideProviderAccountHarness,
  findCredentialSecretName,
  type RegisteredHarness,
  type RegisteredProvider,
} from "../plugins";
import {
  computeArrivedModels,
  describeProviderAccount,
  findRunDescriptor,
  type CatalogWithFirstRead,
} from "../provider-accounts";
import { describeHarnessLacksModel } from "./harness-evidence";
import { findNamedHarnessId, type StoredSection } from "./profile-body";
import type { StoredModelProfile } from "./repository";

/** A runner that is online and not draining, so a session can start on it now. */
export interface ConnectedRunner {
  readonly id: string;
  readonly name: string;
}

/** Everything resolving needs, read once. */
export interface ResolutionWorld {
  readonly accounts: ReadonlyArray<ProviderAccount>;
  readonly catalogs: ReadonlyArray<CatalogWithFirstRead>;
  readonly connectedRunners: ReadonlyArray<ConnectedRunner>;
  readonly providers: ReadonlyArray<RegisteredProvider>;
  readonly harnesses: ReadonlyArray<RegisteredHarness>;
}

/**
 * The runner states that stop an account, from the one a user can fix most
 * directly to the one that needs the most work. When the connected runners
 * differ, the entry reports the first of these that any of them is in.
 */
const MOST_ACTIONABLE_FIRST = [
  "not-signed-in",
  "token-expired",
  "credential-missing",
  "harness-too-old",
  "harness-missing",
] as const satisfies ReadonlyArray<Exclude<ProviderAccountReadinessState, "ready">>;

/** Joins machine names for a message: `Laptop`, `Laptop and Server`, `Laptop, Server and Desk`. */
const joinNames = (names: ReadonlyArray<string>): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * Describes why an account cannot run in the harness on the connected runners
 * that are in `state`. The sentence names the account, the harness or the
 * machines, and says where to fix it. `holdsToken` tells a token from a key,
 * for a missing or an expired credential. `not-signed-in` is only reached by
 * an account that signs in on each machine, because the controller keeps the
 * credential of the others.
 */
const describeRunnerProblem = (
  state: (typeof MOST_ACTIONABLE_FIRST)[number],
  accountName: string,
  harnessName: string,
  machines: ReadonlyArray<string>,
  holdsToken: boolean,
): string => {
  switch (state) {
    case "not-signed-in":
      return `${accountName} is not signed in on ${joinNames(machines)}. Sign in from Settings › Providers.`;
    case "token-expired":
      return holdsToken
        ? `${accountName}'s token has expired. Make a new one in Settings › Providers.`
        : `${accountName}'s key has expired. Add a new key in Settings › Providers.`;
    case "credential-missing":
      return holdsToken
        ? `${accountName} has no token. Make one in Settings › Providers.`
        : `${accountName} has no key. Add one in Settings › Providers.`;
    case "harness-too-old":
      return `${harnessName} on ${joinNames(machines)} is older than this version of Hercule supports. Update it there.`;
    case "harness-missing":
      return `${harnessName} is not installed on ${joinNames(machines)}. Install it there.`;
  }
};

/**
 * Returns the account a stored section or entry names. An account leaves its
 * profiles in the transaction that deletes it, so a stored profile always has
 * its accounts and this throws only on a broken database.
 */
const findStoredAccount = (world: ResolutionWorld, providerAccountId: string): ProviderAccount => {
  const account = world.accounts.find((one) => one.id === providerAccountId);
  if (account === undefined) {
    throw new Error(`a Model Profile holds the missing account ${providerAccountId}`);
  }
  return account;
};

const resolveEntry = (
  entry: ModelProfileEntry,
  section: StoredSection,
  world: ResolutionWorld,
): ResolvedModelProfileEntry => {
  const account = findStoredAccount(world, entry.providerAccountId);
  const resolvedHarnessId = findNamedHarnessId(entry, section) ?? account.defaultHarnessId;
  const catalog = world.catalogs.find((one) => one.providerAccountId === account.id);
  const catalogItem = catalog?.models.find((one) => one.slug === entry.model);
  const snapshotModel = findSnapshotModel(account, resolvedHarnessId, entry.model);
  // The options and the image input are those the harness runs the model with,
  // which for a model the harness does not list is the catalog's declaration.
  const runDescriptor = findRunDescriptor(
    world.providers.find((one) => one.id === account.providerId),
    world.harnesses.find((one) => one.id === resolvedHarnessId),
    snapshotModel,
    catalogItem,
  );
  return {
    ...entry,
    resolvedHarnessId,
    name: catalogItem?.name ?? snapshotModel?.name ?? entry.model,
    options: runDescriptor?.options ?? [],
    imageInput: runDescriptor?.imageInput ?? null,
    problem: findEntryProblem(entry, account, resolvedHarnessId, catalog, world),
  };
};

/**
 * Returns what stops the entry from running now, or `null`. The first of
 * these that holds:
 *
 * 1. `model-left-catalog`: the account's catalog was read and lacks the model.
 * 2. The account's kind cannot use the harness: `harness-missing` when this
 *    build carries no such harness, otherwise `harness-not-allowed`.
 * 3. A problem with the account on every connected runner: `no-runner` when
 *    none is connected, otherwise the most actionable state the runners are
 *    in. Any runner that is `ready` clears it.
 * 4. `harness-lacks-model`: the harness lists its own models and a successful
 *    probe of the account in it does not list this one. No probe is no
 *    evidence, so it says nothing then.
 */
const findEntryProblem = (
  entry: ModelProfileEntry,
  account: ProviderAccount,
  harnessId: string,
  catalog: ModelCatalog | undefined,
  world: ResolutionWorld,
): EntryProblem | null => {
  const accountName = describeProviderAccount(account, world.providers);
  const harness = world.harnesses.find((one) => one.id === harnessId);
  const harnessName = harness?.displayName ?? harnessId;

  if (
    catalog !== undefined &&
    catalog.readAt !== null &&
    !catalog.models.some((one) => one.slug === entry.model)
  ) {
    return {
      reason: "model-left-catalog",
      message: `${accountName} no longer lists ${entry.model}.`,
    };
  }

  // Whether the account's kind may use the harness does not depend on any
  // runner, so it is judged before the runners are.
  const choice = decideProviderAccountHarness(world.providers, world.harnesses, account, harnessId);
  if (choice._tag === "refused") {
    return {
      // A harness this build does not carry is missing; one it carries but
      // the account may not use is not allowed.
      reason: harness === undefined ? "harness-missing" : "harness-not-allowed",
      message: `${accountName} cannot run in ${harnessName}: ${choice.reason}.`,
    };
  }

  if (world.connectedRunners.length === 0) {
    return {
      reason: "no-runner",
      message: `No machine is connected, so ${accountName} cannot run now. Start a runner.`,
    };
  }
  const connectedIds = new Set(world.connectedRunners.map((runner) => runner.id));
  const rows = account.readiness.filter(
    (row) => row.harnessId === harnessId && connectedIds.has(row.runnerId),
  );
  if (!rows.some((row) => row.state === "ready")) {
    const state = MOST_ACTIONABLE_FIRST.find((one) => rows.some((row) => row.state === one));
    if (state !== undefined) {
      const machines = world.connectedRunners
        .filter((runner) => rows.some((row) => row.runnerId === runner.id && row.state === state))
        .map((runner) => runner.name);
      const secretName = findCredentialSecretName(choice.kind);
      return {
        reason: state,
        message: describeRunnerProblem(
          state,
          accountName,
          harnessName,
          machines,
          secretName === "token",
        ),
      };
    }
  }

  if (isModelMissingFromHarness(account, harness, entry.model)) {
    return {
      reason: "harness-lacks-model",
      message: describeHarnessLacksModel(harnessName, entry.model, accountName),
    };
  }
  return null;
};

/**
 * Returns the models to announce as new in a section: the models that arrived
 * in its account's Default Selection (`computeArrivedModels`) except those
 * that
 *
 * - the section holds in any harness,
 * - the profile has dismissed, or
 * - the section's harness is known not to list (the rule a write is refused
 *   by), so Add would fail. They are announced once the harness lists them.
 *
 * A section that still waits for its first catalog read announces nothing.
 * Computed on every read, so nothing is stored and a model stops being
 * announced as soon as the profile holds or dismisses it.
 */
const findNewModels = (
  section: StoredSection,
  dismissed: ReadonlyArray<DismissedNewModel>,
  world: ResolutionWorld,
): ReadonlyArray<NewModel> => {
  if (section.entries === null) return [];
  const account = findStoredAccount(world, section.providerAccountId);
  const provider = world.providers.find((one) => one.id === account.providerId);
  const catalog = world.catalogs.find((one) => one.providerAccountId === account.id);
  if (provider === undefined || catalog === undefined) return [];
  const harnessId = section.harnessId ?? account.defaultHarnessId;
  const harness = world.harnesses.find((one) => one.id === harnessId);
  const held = new Set(section.entries.map((entry) => entry.model));
  return computeArrivedModels(provider, catalog).filter(
    (arrived) =>
      !held.has(arrived.model) &&
      !dismissed.some(
        (one) => one.providerAccountId === account.id && one.model === arrived.model,
      ) &&
      !isModelMissingFromHarness(account, harness, arrived.model),
  );
};

const resolveSection = (
  section: StoredSection,
  dismissed: ReadonlyArray<DismissedNewModel>,
  world: ResolutionWorld,
): ResolvedModelProfileAccount => ({
  providerAccountId: section.providerAccountId,
  harnessId: section.harnessId,
  resolvedHarnessId:
    section.harnessId ?? findStoredAccount(world, section.providerAccountId).defaultHarnessId,
  selectionPending: section.entries === null,
  entries: (section.entries ?? []).map((entry) => resolveEntry(entry, section, world)),
  newModels: findNewModels(section, dismissed, world),
});

/** Returns the profile as a client reads it: every entry resolved against `world`. */
export const resolveProfile = (
  stored: StoredModelProfile,
  world: ResolutionWorld,
): ModelProfile => ({
  id: stored.id,
  name: stored.name,
  revision: stored.revision,
  accounts: stored.body.accounts.map((section) =>
    resolveSection(section, stored.body.dismissedNewModels, world),
  ),
  defaultEntry: stored.body.defaultEntry,
  dismissedNewModels: stored.body.dismissedNewModels,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
});

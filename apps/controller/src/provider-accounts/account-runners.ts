/**
 * Decides on which runners a Provider Account can run in a harness now
 * (spec 03 section 5.1, spec 06 section 15.5), and which models to show for
 * it. Session placement, resuming, agent steps, the default thread account
 * and text generation all ask this one module, so they cannot disagree.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { ProviderAccountReadiness, ProviderAccountReadinessState } from "@hercule/contract";
import type { ModelDescriptor, RunnerFacts } from "@hercule/protocol";
import { buildVersionKey, harnessRepository } from "../harnesses";
import {
  decideProviderAccountHarness,
  findAccountKind,
  PluginHost,
  type RegisteredHarness,
  type RegisteredProvider,
} from "../plugins";
import { runnerRepository } from "../runners";
import { Secrets } from "../secrets";
import { AccountUsage } from "../usage";
import {
  providerAccountRepository,
  type StoredProviderAccount,
  type StoredSnapshot,
} from "./repository";
import {
  decideCredentialState,
  decideHarnessOnRunner,
  describeProviderAccount,
  findCredentialProblem,
  findHarnessProblem,
  isIdentityCompatible,
  type CredentialState,
  type HarnessOnRunner,
} from "./runnability";

/**
 * Where a Provider Account can run in one harness.
 *
 * - `runnerIds` lists the runners that can run it, in the order the runners
 *   were added. A runner that is offline, draining or reserved is listed too:
 *   whether it can take work now is the caller's question.
 * - `subject` names the account and the harness for a message, such as
 *   "Anthropic · work in Claude Code".
 * - `noRunnerMessage` is null when `runnerIds` is not empty. Otherwise it says
 *   what is missing, in words a user can act on.
 */
export interface AccountRunners {
  readonly runnerIds: ReadonlyArray<string>;
  readonly subject: string;
  readonly noRunnerMessage: string | null;
}

/**
 * Returns the message for a caller that needs the account to run on one
 * particular runner and it cannot: the reason no runner can run it when that
 * is the case, else a message about that runner.
 */
export const buildRunnerRefusal = (available: AccountRunners): string =>
  available.noRunnerMessage ??
  `${available.subject} cannot run on that machine: the harness must be installed there and, ` +
    "for a subscription account, signed in on that machine";

/**
 * Returns the models the harness itself listed for an account, from its
 * snapshots: the model list in the `ok` snapshot of `runnerId` when that
 * runner has one, else the list in the most recently probed `ok` snapshot of
 * any runner, else an empty list.
 *
 * This is what the harness can run, and where a model's options and image
 * input come from (spec 06 section 16.4). Which models the account may use is
 * its Model Catalog, not this list.
 *
 * `snapshots` are the account's snapshots in that harness. A key or token
 * account can run on a runner that was never probed, so the fallback keeps it
 * usable. Pass no `runnerId` to get the most recent list.
 */
export const findModels = (
  snapshots: ReadonlyArray<StoredSnapshot>,
  runnerId?: string,
): ReadonlyArray<ModelDescriptor> => {
  const signedIn = snapshots.filter((snapshot) => snapshot.auth.status === "ok");
  const own = signedIn.find((snapshot) => snapshot.runnerId === runnerId);
  if (own !== undefined) return own.models;
  const newest = signedIn.reduce<StoredSnapshot | undefined>(
    (best, snapshot) => (best === undefined || snapshot.probedAt > best.probedAt ? snapshot : best),
    undefined,
  );
  return newest?.models ?? [];
};

/** One account and one harness: the pair whose runners a caller asks for. */
export interface AccountHarnessPair {
  readonly providerAccountId: string;
  readonly harnessId: string;
}

/**
 * An active read of one account's usage that is due to be tried (spec 06
 * section 18.2):
 *
 * - `endpoint`: the controller reads it from the provider with the account's key.
 * - `harness`: the controller probes the account in `harnessId` on `runnerId`
 *   and asks for usage.
 */
export type UsageRead =
  | { readonly _tag: "endpoint"; readonly providerAccountId: string }
  | {
      readonly _tag: "harness";
      readonly providerAccountId: string;
      readonly harnessId: string;
      readonly runnerId: string;
    };

/** What `decideStates` reads once and `decide` and `describeReadiness` then share. */
interface RunnabilityWorld {
  readonly providers: ReadonlyArray<RegisteredProvider>;
  readonly harnesses: ReadonlyArray<RegisteredHarness>;
  readonly storedAccounts: ReadonlyArray<StoredProviderAccount>;
  readonly storedSecrets: ReadonlyMap<string, ReadonlyArray<{ readonly name: string }>>;
  readonly fleet: ReadonlyArray<{ readonly id: string; readonly facts: RunnerFacts | null }>;
  readonly versions: ReadonlyMap<string, string>;
  readonly signedIn: ReadonlyArray<{
    readonly providerAccountId: string;
    readonly harnessId: string;
    readonly runnerId: string;
    readonly identity: string | null;
  }>;
  readonly nowMillis: number;
}

/** Whether one account can run in one harness on each runner, and what blocks it. */
interface PairStates {
  readonly states: ReadonlyArray<{
    readonly runnerId: string;
    readonly state: ProviderAccountReadinessState;
  }>;
  /** Why the account's key or token cannot be used, or null. The same on every runner. */
  readonly credentialProblem: string | null;
  readonly verdicts: ReadonlyArray<HarnessOnRunner>;
}

/**
 * Decides, for every runner in the fleet, whether the account can run in the
 * harness there, and returns the state of each. This is the one place the
 * rule is applied; `ProviderAccountRunners` builds both its runner lists and
 * the readiness rows of the public record from it.
 *
 * The account's own credential decides first, because a missing key is the
 * same on every machine and installing the harness does not mend it. Then the
 * harness on the runner, then, for an account that signs in on each machine,
 * whether that runner is signed in as the account's person.
 */
const decideStates = (
  world: RunnabilityWorld,
  account: StoredProviderAccount,
  choice: Extract<ReturnType<typeof decideProviderAccountHarness>, { _tag: "chosen" }>,
): PairStates => {
  const { harness, support, provider, kind } = choice;
  const secretName = support.credentialSecretName;
  let credentialState: CredentialState = "usable";
  let credentialProblem: string | null = null;
  if (secretName !== undefined) {
    const stored = (world.storedSecrets.get(account.id) ?? []).some(
      (ref) => ref.name === secretName,
    );
    credentialState = decideCredentialState(account, stored, world.nowMillis);
    credentialProblem = findCredentialProblem(account, provider, kind, stored, world.nowMillis);
  }
  const verdicts = world.fleet.map(({ id, facts }) =>
    decideHarnessOnRunner(
      facts,
      harness,
      world.versions.get(buildVersionKey(harness.id, id)) ?? null,
    ),
  );
  const signedInRunners =
    secretName === undefined
      ? new Set(
          world.signedIn
            .filter(
              (one) =>
                one.providerAccountId === account.id &&
                one.harnessId === harness.id &&
                isIdentityCompatible(account.identity, one.identity),
            )
            .map((one) => one.runnerId),
        )
      : undefined;
  const states = world.fleet.map(({ id }, index) => {
    const verdict = verdicts[index]!;
    const state: ProviderAccountReadinessState =
      credentialState === "missing"
        ? "credential-missing"
        : credentialState === "expired"
          ? "token-expired"
          : verdict === "missing"
            ? "harness-missing"
            : verdict === "below-floor"
              ? "harness-too-old"
              : signedInRunners === undefined || signedInRunners.has(id)
                ? "ready"
                : "not-signed-in";
    return { runnerId: id, state };
  });
  return { states, credentialProblem, verdicts };
};

const make = Effect.gen(function* () {
  const accounts = yield* providerAccountRepository;
  const runners = yield* runnerRepository;
  const reportedVersions = yield* harnessRepository;
  const host = yield* PluginHost;
  const secrets = yield* Secrets;
  const accountUsage = yield* AccountUsage;

  /**
   * Reads the accounts, the fleet's facts, the reported harness versions, the
   * stored secrets and the sign-ins once, however many accounts and harnesses
   * are asked about afterwards.
   */
  const readWorld: Effect.Effect<RunnabilityWorld, SqlError> = Effect.gen(function* () {
    const storedAccounts = yield* accounts.list();
    return {
      providers: yield* host.providers(),
      harnesses: yield* host.harnesses(),
      storedAccounts,
      storedSecrets: yield* secrets.refs(
        "provider-account",
        storedAccounts.map((account) => account.id),
      ),
      fleet: yield* runners.listFacts(),
      versions: yield* reportedVersions.readReportedVersions(),
      signedIn: yield* accounts.listSignedIn(),
      nowMillis: yield* Clock.currentTimeMillis,
    };
  });

  /** Lists where one pair can run (see `listMany` of the service below). */
  const decide = (world: RunnabilityWorld, pair: AccountHarnessPair): AccountRunners => {
    const { providerAccountId, harnessId } = pair;
    const account = world.storedAccounts.find((one) => one.id === providerAccountId);
    if (account === undefined) {
      return {
        runnerIds: [],
        subject: "that provider account",
        noRunnerMessage: "that provider account no longer exists",
      };
    }
    const accountName = describeProviderAccount(account, world.providers);
    const choice = decideProviderAccountHarness(
      world.providers,
      world.harnesses,
      account,
      harnessId,
    );
    if (choice._tag === "refused") {
      return {
        runnerIds: [],
        subject: `${accountName} in ${harnessId}`,
        noRunnerMessage: `${accountName} cannot run in ${harnessId}: ${choice.reason}`,
      };
    }
    const subject = `${accountName} in ${choice.harness.displayName}`;
    const none = (noRunnerMessage: string): AccountRunners => ({
      runnerIds: [],
      subject,
      noRunnerMessage,
    });

    const { states, credentialProblem, verdicts } = decideStates(world, account, choice);
    if (credentialProblem !== null) return none(credentialProblem);
    const harnessProblem = findHarnessProblem(choice.harness, verdicts);
    if (harnessProblem !== null) return none(harnessProblem);
    const runnerIds = states
      .filter(({ state }) => state === "ready")
      .map(({ runnerId }) => runnerId);
    if (runnerIds.length === 0) {
      return none(
        `${accountName} is not signed in on any connected machine; sign in from Settings › Providers`,
      );
    }
    return { runnerIds, subject, noRunnerMessage: null };
  };

  const listMany = (
    pairs: ReadonlyArray<AccountHarnessPair>,
  ): Effect.Effect<ReadonlyArray<AccountRunners>, SqlError> =>
    pairs.length === 0
      ? Effect.succeed([])
      : Effect.map(readWorld, (world) => pairs.map((pair) => decide(world, pair)));

  return {
    /**
     * Lists the runners that can run each account in its harness, from what
     * is stored, in the order of `pairs`. It never probes a runner. A runner
     * can run a pair when:
     *
     * - the harness can run on it (`decideHarnessOnRunner`): installed, with an
     *   adapter in the runner's build, and not below this build's floor;
     * - the account works there: an account whose kind holds a key or token
     *   works on every such runner, as long as its secret is stored and a
     *   token has not expired (`findCredentialProblem`). It needs no snapshot,
     *   because the controller sends the secret with every frame. Any other
     *   account works where its snapshot for this harness says the runner is
     *   signed in as the account's person (`isIdentityCompatible`). A snapshot
     *   of someone else, stored before the account's identity was pinned,
     *   does not count.
     *
     * It does not look at models. It does not fail for an account that is
     * gone or a pair that cannot run: the result then lists no runner, with
     * the reason in `noRunnerMessage`. The stored data is read once for all
     * pairs, so ask for many accounts at once rather than in a loop.
     */
    listMany,

    /**
     * Lists the active usage reads to try now: one per account whose kind
     * declares `usage` with `readBy: "endpoint"`, and one per account whose
     * kind declares `readBy: "harness"` and that an online runner can run in
     * that harness (the first such runner; `listMany` already requires a
     * sign-in on that runner for an account whose login lives on the machine).
     * An account of the second kind with no such runner is left out, so
     * nothing is sent and the caller claims nothing. An account whose kind
     * reads usage from its sessions only, or declares no usage, is not listed.
     *
     * Only accounts whose read is due are listed (`AccountUsage.listDueAccounts`).
     * The rest are left out before the fleet is looked at, so the many ticks
     * at which nothing is due cost one read of the accounts and no more. Reads
     * the accounts and the fleet once, however many accounts there are.
     */
    listUsageReads: (): Effect.Effect<ReadonlyArray<UsageRead>, SqlError> =>
      Effect.gen(function* () {
        const providers = yield* host.providers();
        // `harnessId` is null for an account read with its key.
        const candidates: Array<{ id: string; harnessId: string | null }> = [];
        for (const account of yield* accounts.list()) {
          const usage = findAccountKind(providers, account)?.usage;
          if (usage?.readBy === "endpoint") candidates.push({ id: account.id, harnessId: null });
          else if (usage?.readBy === "harness") {
            candidates.push({ id: account.id, harnessId: usage.harnessId });
          }
        }
        const due = new Set(yield* accountUsage.listDueAccounts(candidates.map(({ id }) => id)));
        const reads: Array<UsageRead> = [];
        const harnessPairs: Array<AccountHarnessPair> = [];
        for (const { id, harnessId } of candidates) {
          if (!due.has(id)) continue;
          if (harnessId === null) reads.push({ _tag: "endpoint", providerAccountId: id });
          else harnessPairs.push({ providerAccountId: id, harnessId });
        }
        if (harnessPairs.length === 0) return reads;
        const online = new Set(yield* runners.connected());
        const available = yield* listMany(harnessPairs);
        harnessPairs.forEach(({ providerAccountId, harnessId }, index) => {
          const runnerId = available[index]!.runnerIds.find((id) => online.has(id));
          if (runnerId !== undefined) {
            reads.push({ _tag: "harness", providerAccountId, harnessId, runnerId });
          }
        });
        return reads;
      }),

    /** Lists the runners that can run one account in one harness (`listMany` with a single pair). */
    list: (providerAccountId: string, harnessId: string): Effect.Effect<AccountRunners, SqlError> =>
      Effect.map(readWorld, (world) => decide(world, { providerAccountId, harnessId })),

    /**
     * Lists, for each of the given accounts, whether it can run in each
     * harness on each runner. The map has an entry for every account that
     * exists, in the order of `accountIds`; an account that is gone has none.
     *
     * A row is made for each harness the account may run in (its kind lists
     * the harness and the harness runs its provider and kind, as
     * `decideProviderAccountHarness` decides) on each runner that is not
     * retired. The rows are the same decision `listMany` makes: a runner is
     * `ready` exactly when `listMany` lists it. Whether the runner is online
     * is not part of the state.
     *
     * The stored data is read once, however many accounts there are.
     */
    listReadiness: (
      accountIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<ProviderAccountReadiness>>, SqlError> =>
      Effect.map(readWorld, (world) => {
        const result = new Map<string, ReadonlyArray<ProviderAccountReadiness>>();
        for (const account of world.storedAccounts) {
          if (!accountIds.includes(account.id)) continue;
          result.set(
            account.id,
            world.harnesses.flatMap((harness) => {
              const choice = decideProviderAccountHarness(
                world.providers,
                world.harnesses,
                account,
                harness.id,
              );
              return choice._tag === "refused"
                ? []
                : decideStates(world, account, choice).states.map(({ runnerId, state }) => ({
                    harnessId: harness.id,
                    runnerId,
                    state,
                  }));
            }),
          );
        }
        return result;
      }),
  };
});

/**
 * Answers on which runners a Provider Account can run in a harness now
 * (`list` and `listMany`). It is a service so every caller reads the facts, the versions,
 * the secrets and the snapshots the same way.
 */
export class ProviderAccountRunners extends Context.Service<
  ProviderAccountRunners,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/ProviderAccountRunners") {}

export const ProviderAccountRunnersLayer: Layer.Layer<
  ProviderAccountRunners,
  never,
  SqlClient.SqlClient | PluginHost | Secrets | AccountUsage
> = Layer.effect(ProviderAccountRunners)(make);

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
import type { ModelDescriptor } from "@hercule/protocol";
import { buildVersionKey, harnessRepository } from "../harnesses";
import { decideProviderAccountHarness, PluginHost } from "../plugins";
import { runnerRepository } from "../runners";
import { Secrets } from "../secrets";
import { providerAccountRepository, type StoredSnapshot } from "./repository";
import {
  decideHarnessOnRunner,
  describeProviderAccount,
  findCredentialProblem,
  findHarnessProblem,
  isIdentityCompatible,
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
 * Returns the models to offer for an account in a harness, as the stand-in
 * for the Model Catalog until that exists: the model list in the `ok`
 * snapshot of `runnerId` when that runner has one, else the list in the most
 * recently probed `ok` snapshot of any runner, else an empty list.
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

const make = Effect.gen(function* () {
  const accounts = yield* providerAccountRepository;
  const runners = yield* runnerRepository;
  const reportedVersions = yield* harnessRepository;
  const host = yield* PluginHost;
  const secrets = yield* Secrets;

  /**
   * Lists where each pair can run (see `listMany` of the service below). It
   * reads the accounts, the fleet's facts, the reported harness versions, the
   * stored secrets and the sign-ins once, however many pairs there are.
   */
  const listMany = (
    pairs: ReadonlyArray<AccountHarnessPair>,
  ): Effect.Effect<ReadonlyArray<AccountRunners>, SqlError> =>
    Effect.gen(function* () {
      if (pairs.length === 0) return [];
      const providers = yield* host.providers();
      const harnesses = yield* host.harnesses();
      const storedAccounts = yield* accounts.list();
      const storedSecrets = yield* secrets.refs(
        "provider-account",
        storedAccounts.map((account) => account.id),
      );
      const fleet = yield* runners.listFacts();
      const versions = yield* reportedVersions.readReportedVersions();
      const signedIn = yield* accounts.listSignedIn();
      const nowMillis = yield* Clock.currentTimeMillis;

      const decide = ({ providerAccountId, harnessId }: AccountHarnessPair): AccountRunners => {
        const account = storedAccounts.find((one) => one.id === providerAccountId);
        if (account === undefined) {
          return {
            runnerIds: [],
            subject: "that provider account",
            noRunnerMessage: "that provider account no longer exists",
          };
        }
        const accountName = describeProviderAccount(account, providers);
        const choice = decideProviderAccountHarness(providers, harnesses, account, harnessId);
        if (choice._tag === "refused") {
          return {
            runnerIds: [],
            subject: `${accountName} in ${harnessId}`,
            noRunnerMessage: `${accountName} cannot run in ${harnessId}: ${choice.reason}`,
          };
        }
        const { harness, support } = choice;
        const subject = `${accountName} in ${harness.displayName}`;
        const none = (noRunnerMessage: string): AccountRunners => ({
          runnerIds: [],
          subject,
          noRunnerMessage,
        });

        // The account's own state decides first: a missing key is the same on
        // every machine, and installing the harness does not mend it.
        const secretName = support.credentialSecretName;
        if (secretName !== undefined) {
          const held = storedSecrets.get(account.id) ?? [];
          const problem = findCredentialProblem(
            account,
            providers,
            held.some((ref) => ref.name === secretName),
            nowMillis,
          );
          if (problem !== null) return none(problem);
        }

        const verdicts = fleet.map(({ id, facts }) => ({
          id,
          verdict: decideHarnessOnRunner(
            facts,
            harness,
            versions.get(buildVersionKey(harness.id, id)) ?? null,
          ),
        }));
        const harnessProblem = findHarnessProblem(
          harness,
          verdicts.map(({ verdict }) => verdict),
        );
        if (harnessProblem !== null) return none(harnessProblem);
        const upToDate = verdicts.filter(({ verdict }) => verdict === "runnable");
        if (secretName !== undefined) {
          return { runnerIds: upToDate.map(({ id }) => id), subject, noRunnerMessage: null };
        }

        const signedInRunners = new Set(
          signedIn
            .filter(
              (one) =>
                one.providerAccountId === account.id &&
                one.harnessId === harness.id &&
                isIdentityCompatible(account.identity, one.identity),
            )
            .map((one) => one.runnerId),
        );
        const runnerIds = upToDate.map(({ id }) => id).filter((id) => signedInRunners.has(id));
        if (runnerIds.length === 0) {
          return none(
            `${accountName} is not signed in on any connected machine; sign in from Settings › Providers`,
          );
        }
        return { runnerIds, subject, noRunnerMessage: null };
      };

      return pairs.map(decide);
    });

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

    /** Lists the runners that can run one account in one harness (`listMany` with a single pair). */
    list: (providerAccountId: string, harnessId: string): Effect.Effect<AccountRunners, SqlError> =>
      Effect.map(listMany([{ providerAccountId, harnessId }]), ([only]) => only!),
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
  SqlClient.SqlClient | PluginHost | Secrets
> = Layer.effect(ProviderAccountRunners)(make);

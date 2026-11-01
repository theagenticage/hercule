/**
 * The finite operations behind probing Provider Accounts: which account and
 * harness pairs a runner could be probed for, and storing what a runner
 * reported for one.
 *
 * The controller daemon sends the probes and runs the sweeps (it is the only
 * module that talks to runners); it asks this domain what to probe and hands
 * it each result to store. A sweep gathers facts rather than performing an
 * operation: it checks no grant, and the system is the actor for every row it
 * writes.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createNotFoundError,
  type CapabilitySnapshot,
  type InvalidState,
  type NotFound,
} from "@hercule/contract";
import type { ProbeResult } from "@hercule/protocol";
import { afterCommit, announce, nowIso, withTransaction } from "../db";
import { PromotionState } from "../promotion";
import { runnerRepository } from "../runners";
import { decideProviderAccountHarness, PluginHost } from "../plugins";
import { Secrets } from "../secrets";
import { AccountUsage } from "../usage";
import { describeSnapshot } from "./describe-snapshot";
import { ModelCatalogs } from "./model-catalogs";
import { providerAccountRepository, type StoredProviderAccount } from "./repository";
import { decideHarnessOnRunner, findCredentialProblem, isIdentityCompatible } from "./runnability";

type StoreError = SqlError | Schema.SchemaError | InvalidState;

const NO_SUCH_PROVIDER_ACCOUNT = "no such provider account";

/**
 * Returns the result to store, judged against the person the account belongs
 * to. A result that carries an identity different from the account's becomes
 * `unauthenticated`, with a message that names both people. It keeps the
 * reported identity, so a client can show who is signed in on that runner.
 * Every other result is returned unchanged.
 */
const judgeIdentity = (result: ProbeResult, accountIdentity: string | null): ProbeResult => {
  const reported = result.auth.identity;
  if (
    result.auth.status !== "ok" ||
    reported === undefined ||
    accountIdentity === null ||
    isIdentityCompatible(accountIdentity, reported)
  ) {
    return result;
  }
  return {
    ...result,
    auth: {
      ...result.auth,
      status: "unauthenticated",
      message: `Signed in as ${reported}; this account is ${accountIdentity}. Sign in again as ${accountIdentity}.`,
    },
  };
};

/** One account in one harness on one runner: what a single probe asks about. */
export interface ProbePair {
  readonly runnerId: string;
  readonly providerAccountId: string;
  readonly harnessId: string;
}

/**
 * What the controller knew when it started a read of an account (a probe or
 * a request to the provider's API): the time, and which credential the
 * account had. The outcome is judged against both, so a read that started
 * before a new credential never overwrites what describes the new one.
 */
export interface ReadStamp {
  readonly sentAt: string;
  readonly credentialGeneration: number;
}

/**
 * The `ReadStamp` of a probe, plus whether the probe asked for usage. The
 * answer is judged against all three.
 */
export interface ProbeStamp extends ReadStamp {
  /** Whether the probe asked the runner for the account's usage. Usage in the answer to a probe that did not ask is not stored. */
  readonly readUsage: boolean;
}

/**
 * What came of handing a probe's answer to be stored:
 *
 * - `stored`: the snapshot as stored.
 * - `superseded`: the snapshot was out of date (the account got a new
 *   credential or a sign-in after the probe was sent, or a newer probe of the
 *   pair was already stored), so it was not written. It says nothing about
 *   the account as it is now. A probe sent as a catalog read can still have
 *   been recorded as one: see `recordProbe`.
 * - `unanswered`: nothing was stored, because the runner did not answer in
 *   time or the controller is sealed after a promotion.
 */
export type ProbeOutcome =
  | { readonly _tag: "stored"; readonly snapshot: CapabilitySnapshot }
  | { readonly _tag: "superseded" }
  | { readonly _tag: "unanswered" };

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const accounts = yield* providerAccountRepository;
  const runners = yield* runnerRepository;
  const promotion = yield* PromotionState;
  const host = yield* PluginHost;
  const secrets = yield* Secrets;
  const accountUsage = yield* AccountUsage;
  const catalogs = yield* ModelCatalogs;
  // A wake needs no payload, and one unread change already says that a
  // snapshot was stored, so the PubSub keeps only the latest.
  const snapshotWrites = yield* PubSub.sliding<void>(1);
  // Same reasoning as `snapshotWrites`, for a stored or cleared credential expiry.
  const credentialExpiryWrites = yield* PubSub.sliding<void>(1);
  // The millisecond of the last stamp handed out. Two probes of one pair that
  // share a millisecond could not be put in order by their stamps.
  let lastStampMillis = 0;

  /**
   * Returns the pairs to probe: for every given account, every harness the
   * account can run in (`decideProviderAccountHarness` allows it), on every
   * given runner where the harness is present and has an adapter
   * (`decideHarnessOnRunner`, called without a version: the version floor
   * decides where a session is placed, not where a probe goes, and a probe is
   * how a harness that was upgraded past the floor is seen again). An
   * account whose kind holds a key or token that cannot be used
   * (`findCredentialProblem`) is left out, because `HarnessAccounts.prepare`
   * would refuse it. Fails only when the runners or the stored Secrets cannot
   * be read.
   */
  const listPairs = (
    runnerIds: ReadonlyArray<string>,
    over: ReadonlyArray<StoredProviderAccount>,
  ): Effect.Effect<ReadonlyArray<ProbePair>, SqlError> =>
    Effect.gen(function* () {
      const providers = yield* host.providers();
      const harnesses = yield* host.harnesses();
      const factsByRunner = new Map(
        (yield* runners.listFacts()).map((runner) => [runner.id, runner.facts]),
      );
      const nowMillis = yield* Clock.currentTimeMillis;
      const secretNames = yield* secrets.refs(
        "provider-account",
        over.map((account) => account.id),
      );
      return over.flatMap((account) => {
        const stored = new Set((secretNames.get(account.id) ?? []).map((ref) => ref.name));
        const runnable = harnesses.filter((harness) => {
          const choice = decideProviderAccountHarness(providers, harnesses, account, harness.id);
          if (choice._tag === "refused") return false;
          const { provider, kind, support } = choice;
          const { credentialSecretName } = support;
          return (
            credentialSecretName === undefined ||
            findCredentialProblem(
              account,
              provider,
              kind,
              stored.has(credentialSecretName),
              nowMillis,
            ) === null
          );
        });
        return runnerIds.flatMap((runnerId) =>
          runnable
            .filter(
              (harness) =>
                decideHarnessOnRunner(factsByRunner.get(runnerId) ?? null, harness, null) ===
                "runnable",
            )
            .map((harness) => ({
              runnerId,
              providerAccountId: account.id,
              harnessId: harness.id,
            })),
        );
      });
    });

  const buildReadStamp = (
    providerAccountId: string,
  ): Effect.Effect<ReadStamp, SqlError | NotFound> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      lastStampMillis = Math.max(now, lastStampMillis + 1);
      const sentAt = new Date(lastStampMillis).toISOString();
      const found = yield* accounts.one(providerAccountId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(createNotFoundError(NO_SUCH_PROVIDER_ACCOUNT));
      }
      return { sentAt, credentialGeneration: found.value.credentialGeneration };
    });

  return {
    /**
     * Reads what to send with a probe of the account: the `ReadStamp`, and
     * `readUsage`, whether the probe asks for usage. Fails as
     * `buildReadStamp` does.
     */
    readProbeStamp: (
      providerAccountId: string,
      readUsage: boolean,
    ): Effect.Effect<ProbeStamp, SqlError | NotFound> =>
      Effect.map(buildReadStamp(providerAccountId), (stamp) => ({ ...stamp, readUsage })),

    /**
     * Returns the stamp for a read of the account that starts now: the time
     * and the account's credential generation. Build it before the credential
     * is decrypted for the read, so a credential that changes in between only
     * makes the outcome look older than it is, never newer. The times this
     * service hands out strictly increase: when the clock has not moved past
     * the last one, the stamp is that one plus a millisecond. Fails with
     * `NotFound` when the account does not exist.
     */
    buildReadStamp,

    /**
     * Records that a device login finished on a runner without Hercule storing
     * anything. It advances the account's credential generation, so a probe
     * sent before this is stale when its answer arrives, and in the same
     * transaction marks the runner's snapshot of the account in the harness as
     * not signed in, so the runner is not placeable on an `ok` that was taken
     * before the login while the probe that checks the login runs. Does
     * nothing when the account does not exist, or while the controller is
     * sealed after a promotion.
     */
    acceptDeviceSignIn: (
      providerAccountId: string,
      runnerId: string,
      harnessId: string,
    ): Effect.Effect<void, SqlError> =>
      promotion.whenServingOr(
        withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) =>
            accounts.recordAcceptedSignIn(providerAccountId, runnerId, harnessId, at),
          ),
        ),
        () => Effect.void,
      ),

    /**
     * Stores what a runner reported for one account in one harness, and
     * returns the snapshot. Fails with `NotFound` when the account was deleted
     * while the runner was answering, because a snapshot cannot be stored for
     * an account that is gone.
     *
     * With `readsCatalog`, the probe was sent as a read of the account's Model
     * Catalog, and its result, judged for identity as below, is handed to
     * `ModelCatalogs.recordCatalogRead` in the same transaction. Every other
     * probe leaves the catalog alone. The catalog read and the snapshot are
     * accepted separately:
     *
     * - A result sent with an older credential than the account has now is
     *   neither stored as a snapshot nor as a read. It describes the old
     *   credential, and it must not pin the old person as the account's
     *   identity before the new credential's own probe answers.
     * - A result sent before the stored snapshot's `probedAt` is stale as a
     *   snapshot, because two probes of one pair can be in flight together and
     *   the slower one can answer last. It is still a valid read, and the
     *   catalog decides on its own whether a newer read of it was stored
     *   already. Without this, an ordinary probe sent after a forced read
     *   would swallow the read.
     *
     * `stamp.sentAt` is when the controller sent the probe, and it becomes
     * the snapshot's `probedAt`, because the runner looked at the account's
     * state some time after that and before it answered.
     *
     * For a stale snapshot nothing is written to the snapshots, and it does
     * not set the account's identity either. The outcome is `superseded`. The
     * stored snapshot is not returned in its place: it may describe a
     * different sign-in than the one the caller wants checked.
     *
     * One account is one person. An `ok` result that carries an identity sets
     * the account's identity and plan label when the account has none yet.
     * When the identity differs from the account's, the snapshot is stored as
     * `unauthenticated` with a message that says who is signed in and who the
     * account is, so placement never uses that runner. The identity write and
     * the snapshot write are one transaction.
     *
     * When the probe asked for usage (`stamp.readUsage`), the stored snapshot
     * is `ok` and the result carries usage readings (`result.usage`), they are
     * stored as read in the same transaction (see `AccountUsage.record`).
     * Usage in the answer to a probe that did not ask for it is dropped, and
     * so is the usage of a result that is not `ok`: when it is a sign-in as
     * someone else, the readings belong to that person.
     *
     * Only the store passes the promotion gate, not the wait for the runner, so
     * a freeze never waits up to a probe's deadline for its answer. While a
     * promotion freezes the controller, the store waits until the freeze ends.
     * Once the controller is sealed, the snapshot is dropped and the outcome is
     * `unanswered`: the runner reconnects to the new machine, which probes it again
     * when it arrives.
     */
    recordProbe: (
      runnerId: string,
      providerAccountId: string,
      harnessId: string,
      result: ProbeResult,
      stamp: ProbeStamp,
      { readsCatalog }: { readonly readsCatalog: boolean } = { readsCatalog: false },
    ): Effect.Effect<ProbeOutcome, StoreError | NotFound> => {
      const { sentAt } = stamp;
      const store: Effect.Effect<ProbeOutcome, StoreError | NotFound> = withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* accounts.one(providerAccountId);
          if (Option.isNone(found)) {
            return yield* Effect.fail(createNotFoundError(NO_SUCH_PROVIDER_ACCOUNT));
          }
          if (found.value.credentialGeneration > stamp.credentialGeneration) {
            return { _tag: "superseded" } as const;
          }
          const stored = yield* accounts.readSnapshot(providerAccountId, harnessId, runnerId);
          if (Option.isSome(stored) && Date.parse(stored.value.probedAt) > Date.parse(sentAt)) {
            if (readsCatalog) {
              yield* catalogs.recordCatalogRead(
                providerAccountId,
                { _tag: "probed", result: judgeIdentity(result, found.value.identity) },
                stamp,
              );
            }
            return { _tag: "superseded" } as const;
          }
          let accountIdentity = found.value.identity;
          const reported = result.auth.identity;
          if (result.auth.status === "ok" && reported !== undefined && accountIdentity === null) {
            // The first person to sign in becomes the account's person. The
            // account is read again afterwards, because a concurrent first
            // sign-in may have set the identity between the read and the update.
            yield* accounts.setIdentityIfUnset(
              providerAccountId,
              reported,
              result.auth.planLabel,
              yield* nowIso,
            );
            accountIdentity = Option.getOrNull(
              Option.map(yield* accounts.one(providerAccountId), (winner) => winner.identity),
            );
          }
          const judged = judgeIdentity(result, accountIdentity);
          yield* accounts.recordSnapshot(providerAccountId, harnessId, runnerId, judged, sentAt);
          if (
            stamp.readUsage &&
            judged.auth.status === "ok" &&
            judged.usage !== null &&
            judged.usage.length > 0
          ) {
            yield* accountUsage.record(providerAccountId, judged.usage, { source: "read" });
          }
          if (readsCatalog) {
            yield* catalogs.recordCatalogRead(
              providerAccountId,
              { _tag: "probed", result: judged },
              stamp,
            );
          }
          yield* afterCommit(() => {
            PubSub.publishUnsafe(snapshotWrites, undefined);
          });
          // No audit row: a probe result is not an event anyone reads back, so
          // the account's live subscribers are notified instead.
          yield* announce({
            _tag: "record",
            topic: "provider",
            id: providerAccountId,
            kind: "updated",
          });
          return {
            _tag: "stored",
            snapshot: describeSnapshot({
              providerAccountId,
              runnerId,
              harnessId,
              probedAt: sentAt,
              harnessVersion: judged.harnessVersion,
              auth: judged.auth,
              models: judged.models,
            }),
          } as const;
        }),
      );
      return promotion.whenServingOr(store, () => Effect.succeed({ _tag: "unanswered" } as const));
    },

    /**
     * Emits once each time a stored snapshot commits, so a run whose
     * text generation step waits for a runner can check again whether one
     * can take its call: a snapshot can show a login or a model that was not
     * there before. A subscriber that falls behind gets one emission for all
     * the snapshots it missed.
     */
    snapshotChanges: Stream.fromPubSub(snapshotWrites),

    /**
     * Emits once each time a credential expiry is stored or cleared and the
     * write commits, so the watcher of expiries plans its wait again. A
     * subscriber that falls behind gets one emission for all the changes it
     * missed.
     */
    credentialExpiryChanges: Stream.fromPubSub(credentialExpiryWrites),

    /**
     * Records that an account's credential expiry was stored or cleared, so
     * `credentialExpiryChanges` emits once the transaction commits (at once
     * outside a transaction). Does not store the expiry.
     */
    notifyCredentialExpiryChanged: (): Effect.Effect<void> =>
      afterCommit(() => {
        PubSub.publishUnsafe(credentialExpiryWrites, undefined);
      }),

    /**
     * Returns the earliest time after `afterMillis` (epoch milliseconds) at
     * which a stored key or token expires, or `none` when none expires later.
     * The controller daemon wakes at that time, because nothing else changes
     * when a credential expires: the account stops being ready by the clock
     * alone.
     */
    findNextCredentialExpiry: (
      afterMillis: number,
    ): Effect.Effect<Option.Option<number>, SqlError> =>
      Effect.map(accounts.list(), (all) => {
        const later = all.flatMap((account) =>
          account.credentialExpiresAt === null ? [] : [Date.parse(account.credentialExpiresAt)],
        );
        const next = later.filter((at) => at > afterMillis);
        return next.length === 0 ? Option.none() : Option.some(Math.min(...next));
      }),

    /**
     * Announces on the `provider` live topic every account whose key or token
     * expired after `sinceMillis` and up to `untilMillis` (epoch milliseconds,
     * the end included), so a client that shows the account as ready reads it
     * again and sees `token-expired`. The caller passes the end of its last
     * call as the next `sinceMillis`, which announces each expiry once.
     */
    announceExpiredCredentials: (
      sinceMillis: number,
      untilMillis: number,
    ): Effect.Effect<void, SqlError> =>
      Effect.flatMap(accounts.list(), (all) =>
        Effect.forEach(
          all.filter((account) => {
            if (account.credentialExpiresAt === null) return false;
            const at = Date.parse(account.credentialExpiresAt);
            return at > sinceMillis && at <= untilMillis;
          }),
          (account) =>
            announce({ _tag: "record", topic: "provider", id: account.id, kind: "updated" }),
          { discard: true },
        ),
      ),

    /** Lists the pairs to probe on one runner: every account and harness that runner could run. */
    listPairsOnRunner: (runnerId: string): Effect.Effect<ReadonlyArray<ProbePair>, StoreError> =>
      Effect.flatMap(accounts.list(), (all) => listPairs([runnerId], all)),

    /** Lists the pairs to probe on every connected runner. Lists none when no runner is connected. */
    listPairsOnFleet: (): Effect.Effect<ReadonlyArray<ProbePair>, StoreError> =>
      Effect.gen(function* () {
        const online = yield* runners.connected();
        if (online.length === 0) return [];
        return yield* listPairs(online, yield* accounts.list());
      }),

    /**
     * Lists the pairs to probe for one account on every connected runner. A
     * probe runs with the account's credential, so a new credential makes
     * every runner's snapshot stale at once. Lists none for an account that
     * does not exist.
     */
    listPairsOfProviderAccount: (
      providerAccountId: string,
    ): Effect.Effect<ReadonlyArray<ProbePair>, StoreError> =>
      Effect.gen(function* () {
        const found = yield* accounts.one(providerAccountId);
        if (Option.isNone(found)) return [];
        return yield* listPairs(yield* runners.connected(), [found.value]);
      }),
  };
});

/** The service that decides what to probe for Provider Accounts and stores the snapshots. */
export class ProviderAccountProbes extends Context.Service<
  ProviderAccountProbes,
  Effect.Success<typeof make>
>()("hercule/controller/provider-accounts/ProviderAccountProbes") {}

export const ProviderAccountProbesLayer: Layer.Layer<
  ProviderAccountProbes,
  never,
  SqlClient.SqlClient | PluginHost | PromotionState | Secrets | AccountUsage | ModelCatalogs
> = Layer.effect(ProviderAccountProbes)(make);

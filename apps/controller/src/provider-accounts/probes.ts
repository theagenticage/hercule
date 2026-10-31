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
import { describeSnapshot } from "./describe-snapshot";
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
 * What the controller knew when it sent a probe: the time, and which
 * credential the account had. The answer is judged against both.
 */
export interface ProbeStamp {
  readonly sentAt: string;
  readonly credentialGeneration: number;
}

/**
 * What came of handing a probe's answer to be stored:
 *
 * - `stored`: the snapshot as stored.
 * - `superseded`: the answer was out of date (the account got a new
 *   credential or a sign-in after the probe was sent, or a newer probe of the
 *   pair was already stored), so nothing was written. It says nothing about
 *   the account as it is now.
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
  // A wake needs no payload, and one unread change already says that a
  // snapshot was stored, so the PubSub keeps only the latest.
  const snapshotWrites = yield* PubSub.sliding<void>(1);
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
          const { credentialSecretName } = choice.support;
          return (
            credentialSecretName === undefined ||
            findCredentialProblem(
              account,
              providers,
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

  return {
    /**
     * Reads what to send with a probe of the account: the time and the
     * account's credential generation. Read this before the credential is
     * decrypted for the probe, so a credential that changes in between only
     * makes the answer look older than it is, never newer. The times this
     * service hands out strictly increase: when the clock has not moved past
     * the last one, the stamp is that one plus a millisecond. Fails with
     * `NotFound` when the account does not exist.
     */
    readProbeStamp: (providerAccountId: string): Effect.Effect<ProbeStamp, SqlError | NotFound> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        lastStampMillis = Math.max(now, lastStampMillis + 1);
        const sentAt = new Date(lastStampMillis).toISOString();
        const found = yield* accounts.one(providerAccountId);
        if (Option.isNone(found)) {
          return yield* Effect.fail(createNotFoundError(NO_SUCH_PROVIDER_ACCOUNT));
        }
        return { sentAt, credentialGeneration: found.value.credentialGeneration };
      }),

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
          Effect.gen(function* () {
            yield* accounts.advanceCredentialGeneration(providerAccountId, yield* nowIso);
            yield* accounts.markSnapshotSignInPending(providerAccountId, harnessId, runnerId);
          }),
        ),
        () => Effect.void,
      ),

    /**
     * Stores what a runner reported for one account in one harness, and
     * returns the snapshot. Fails with `NotFound` when the account was deleted
     * while the runner was answering, because a snapshot cannot be stored for
     * an account that is gone.
     *
     * `stamp.sentAt` is when the controller sent the probe, and it becomes
     * the snapshot's `probedAt`, because the runner looked at the account's
     * state some time after that and before it answered. Two probes of one
     * pair can be in flight together, and the slower one can answer last. A
     * result sent before the stored snapshot's `probedAt` is therefore stale.
     *
     * A result is also stale when the account got a new credential or a
     * sign-in after the probe was sent (`stamp.credentialGeneration` is below
     * the account's). It describes the old credential, and it must not pin
     * the old person as the account's identity before the new credential's
     * own probe answers.
     *
     * For a stale result nothing is written (it does not set the account's
     * identity either) and the outcome is `superseded`. The stored snapshot is
     * not returned in its place: it may describe a different sign-in than the
     * one the caller wants checked.
     *
     * One account is one person. An `ok` result that carries an identity sets
     * the account's identity and plan label when the account has none yet.
     * When the identity differs from the account's, the snapshot is stored as
     * `unauthenticated` with a message that says who is signed in and who the
     * account is, so placement never uses that runner. The identity write and
     * the snapshot write are one transaction.
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
    ): Effect.Effect<ProbeOutcome, StoreError | NotFound> => {
      const { sentAt } = stamp;
      const store: Effect.Effect<ProbeOutcome, StoreError | NotFound> = withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* accounts.one(providerAccountId);
          if (Option.isNone(found)) {
            return yield* Effect.fail(createNotFoundError(NO_SUCH_PROVIDER_ACCOUNT));
          }
          const stored = yield* accounts.readSnapshot(providerAccountId, harnessId, runnerId);
          if (
            found.value.credentialGeneration > stamp.credentialGeneration ||
            (Option.isSome(stored) && Date.parse(stored.value.probedAt) > Date.parse(sentAt))
          ) {
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
  SqlClient.SqlClient | PluginHost | PromotionState | Secrets
> = Layer.effect(ProviderAccountProbes)(make);

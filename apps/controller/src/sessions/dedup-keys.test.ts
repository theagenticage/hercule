/**
 * Tests `returnExistingOrCreate`, which makes a retried `session.spawn`,
 * `session.continue` or `session.input` return the first call's result:
 *
 * - a repeat of a recorded key returns the first result and does no work;
 * - a call that loses the claim to another call with the same key returns that
 *   call's result, also when it fails before it reaches its own claim;
 * - a call's own failure after its claim committed (the runner not answering)
 *   reaches the caller unchanged, because the caller must learn that the call
 *   failed;
 * - a key belongs to one actor and one operation.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { dedupKeyRepository, type DedupClaim, type DedupOperation } from "./dedup-keys";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** A session's actor. Only its id matters here, because the stamp is `session:<id>`. */
const SESSION: Actor = {
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  profileId: "0199e0e7-0003-7000-8000-000000000000",
  grants: [],
  profileGrants: [],
  assistantId: null,
  agentId: null,
};

/** Returns a new canonical v7 id, the only id format the database accepts. */
const mintId = () => uuidToString(mintUuid());

/** Runs `effect` as `actor` against a fresh database. */
const runAs = <A, E>(actor: Actor, effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(CurrentActor, actor), Effect.provide(TestDatabase)),
  );

const readExisting = (resultId: string) => Effect.succeed(`read ${resultId}`);

/** Returns the claim `returnExistingOrCreate` passes when the call has a key. */
const requireClaim = (claim: DedupClaim | undefined): DedupClaim => {
  if (claim === undefined) throw new Error("the test call has a key, so it gets a claim");
  return claim;
};

/**
 * Builds a `create` like a service operation's: it claims the key in a
 * transaction of its own and returns the new id. `runs` counts how often it ran.
 */
const claimingCreate =
  (runs: { count: number }, resultId: string = mintId()) =>
  (claim: DedupClaim | undefined) =>
    Effect.suspend(() => {
      runs.count += 1;
      return Effect.as(inTransaction(requireClaim(claim)(resultId)), `created ${resultId}`);
    });

/** Runs a complete call that records `key` for `resultId`, like the call that wins an overlap. */
const recordKey = (operation: DedupOperation, key: string, resultId: string) =>
  Effect.gen(function* () {
    const dedup = yield* dedupKeyRepository;
    yield* dedup.returnExistingOrCreate(
      operation,
      key,
      readExisting,
      claimingCreate({ count: 0 }, resultId),
    );
  });

/** Returns the typed failure of `exit`, or `undefined` when it did not fail with one. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    : undefined;

describe("returnExistingOrCreate", () => {
  it("runs create on every call when no key is sent", async () => {
    const runs = { count: 0 };
    await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        const create = () => Effect.sync(() => `created ${(runs.count += 1)}`);
        yield* dedup.returnExistingOrCreate("session.spawn", undefined, readExisting, create);
        yield* dedup.returnExistingOrCreate("session.spawn", undefined, readExisting, create);
      }),
    );
    expect(runs.count).toBe(2);
  });

  it("returns the first result of a repeat and does not run create again", async () => {
    const runs = { count: 0 };
    const { first, second } = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        const create = claimingCreate(runs);
        const call = () =>
          dedup.returnExistingOrCreate("session.spawn", "key-1", readExisting, create);
        return { first: yield* call(), second: yield* call() };
      }),
    );
    expect(runs.count).toBe(1);
    expect(second).toBe(`read ${first.replace("created ", "")}`);
  });

  it("returns the first result when create loses its claim to a call that recorded the key first", async () => {
    const winnerId = mintId();
    const result = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        // The other call commits after this call's first lookup found nothing.
        const create = (claim: DedupClaim | undefined) =>
          Effect.andThen(
            recordKey("session.spawn", "key-1", winnerId),
            inTransaction(Effect.as(requireClaim(claim)(mintId()), "created")),
          );
        return yield* dedup.returnExistingOrCreate("session.spawn", "key-1", readExisting, create);
      }),
    );
    expect(result).toBe(`read ${winnerId}`);
  });

  it("returns the first result when create fails before its claim after another call recorded the key", async () => {
    const winnerId = mintId();
    const result = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        // The repeat names another target and fails a check before it claims.
        const create = () =>
          Effect.andThen(
            recordKey("session.spawn", "key-1", winnerId),
            Effect.fail({ _tag: "NotFound" as const }),
          );
        return yield* dedup.returnExistingOrCreate("session.spawn", "key-1", readExisting, create);
      }),
    );
    expect(result).toBe(`read ${winnerId}`);
  });

  it("passes this call's own failure after its committed claim through, and a repeat returns its id", async () => {
    const runs = { count: 0 };
    const claimedId = mintId();
    const { failed, retried } = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        const create = (claim: DedupClaim | undefined) =>
          Effect.andThen(
            claimingCreate(runs, claimedId)(claim),
            // The claim committed. Then the runner does not answer.
            Effect.fail({ _tag: "RunnerSilent" as const }),
          );
        const failed = yield* Effect.exit(
          dedup.returnExistingOrCreate("session.spawn", "key-1", readExisting, create),
        );
        const retried = yield* dedup.returnExistingOrCreate(
          "session.spawn",
          "key-1",
          readExisting,
          create,
        );
        return { failed, retried };
      }),
    );
    expect(failureOf(failed)).toEqual({ _tag: "RunnerSilent" });
    expect(runs.count).toBe(1);
    expect(retried).toBe(`read ${claimedId}`);
  });

  it("passes a failure before any claim through when no other call recorded the key", async () => {
    const exit = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        return yield* Effect.exit(
          dedup.returnExistingOrCreate("session.spawn", "key-1", readExisting, () =>
            Effect.fail({ _tag: "NotFound" as const }),
          ),
        );
      }),
    );
    expect(failureOf(exit)).toEqual({ _tag: "NotFound" });
  });

  it("does real work for another operation and for another actor with the same key", async () => {
    const runs = { count: 0 };
    await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        const call = (operation: DedupOperation) =>
          dedup.returnExistingOrCreate(operation, "key-1", readExisting, claimingCreate(runs));
        yield* call("session.spawn");
        yield* call("session.continue");
        yield* Effect.provideService(call("session.spawn"), CurrentActor, SESSION);
      }),
    );
    expect(runs.count).toBe(3);
  });
});

/**
 * Tests the dedup keys of `session.spawn`, `session.continue` and
 * `session.input`:
 *
 * - a key is claimed once per actor and operation, and a second claim fails
 *   with `DedupKeyTaken` and writes nothing;
 * - `returnExistingOrCreate` returns the first call's result for a repeat, and
 *   recovers from nothing but the claim conflict.
 *
 * The case they guard against: a failure after the claim committed (the runner
 * not answering) is turned into the first call's result, and the caller never
 * learns that its call failed.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidToString, withTransaction } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { DedupKeyTaken, dedupKeyRepository, type DedupOperation } from "./dedup-keys";

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

/** Claims `key` for `operation` in a transaction of its own, as production callers do. */
const claim = (operation: DedupOperation, key: string, resultId: string) =>
  Effect.gen(function* () {
    const dedup = yield* dedupKeyRepository;
    yield* inTransaction(dedup.claimDedupKey(operation, key, resultId));
  });

describe("claimDedupKey", () => {
  it("fails with DedupKeyTaken on a second claim by the same actor, operation and key", async () => {
    const exit = await runAs(
      USER,
      Effect.gen(function* () {
        yield* claim("session.spawn", "key-1", mintId());
        return yield* Effect.exit(claim("session.spawn", "key-1", mintId()));
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("DedupKeyTaken");
  });

  it("lets another operation claim the same key", async () => {
    const exit = await runAs(
      USER,
      Effect.gen(function* () {
        yield* claim("session.spawn", "key-1", mintId());
        yield* claim("session.continue", "key-1", mintId());
        return yield* Effect.exit(claim("session.input", "key-1", mintId()));
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("lets another actor claim the same key", async () => {
    const exit = await runAs(
      USER,
      Effect.gen(function* () {
        yield* claim("session.spawn", "key-1", mintId());
        return yield* Effect.exit(
          Effect.provideService(claim("session.spawn", "key-1", mintId()), CurrentActor, SESSION),
        );
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("rolls back the writes of the transaction it fails in", async () => {
    const exit = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        yield* claim("session.spawn", "taken", mintId());
        // The repeat claims another key first, then loses the claim of "taken".
        yield* Effect.exit(
          inTransaction(
            Effect.gen(function* () {
              yield* dedup.claimDedupKey("session.spawn", "written-first", mintId());
              yield* dedup.claimDedupKey("session.spawn", "taken", mintId());
            }),
          ),
        );
        return yield* Effect.exit(claim("session.spawn", "written-first", mintId()));
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("returnExistingOrCreate", () => {
  /**
   * Builds a `create` like a service operation's: it claims `key` in a
   * transaction of its own and returns the new id. `runs` counts how often it ran.
   */
  const buildCreate = (key: string | undefined, runs: { count: number }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const dedup = yield* dedupKeyRepository;
      return withTransaction(
        sql,
        Effect.gen(function* () {
          runs.count += 1;
          const id = mintId();
          if (key !== undefined) yield* dedup.claimDedupKey("session.spawn", key, id);
          return id;
        }),
      );
    });

  const readExisting = (resultId: string) => Effect.succeed(`read ${resultId}`);

  it("runs create when no key is sent", async () => {
    const runs = { count: 0 };
    const result = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        const create = yield* buildCreate(undefined, runs);
        const first = yield* dedup.returnExistingOrCreate(
          "session.spawn",
          undefined,
          readExisting,
          Effect.map(create, (id) => `created ${id}`),
        );
        const second = yield* dedup.returnExistingOrCreate(
          "session.spawn",
          undefined,
          readExisting,
          Effect.map(create, (id) => `created ${id}`),
        );
        return [first, second];
      }),
    );
    expect(runs.count).toBe(2);
    expect(result[0]).not.toBe(result[1]);
    expect(result.every((value) => value?.startsWith("created "))).toBe(true);
  });

  it("returns the first result of a repeat and does not run create again", async () => {
    const runs = { count: 0 };
    const { first, second } = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        const create = yield* buildCreate("key-1", runs);
        const call = () =>
          dedup.returnExistingOrCreate("session.spawn", "key-1", readExisting, create);
        return { first: yield* Effect.map(call(), String), second: yield* call() };
      }),
    );
    expect(runs.count).toBe(1);
    // The first call created and returned the new id. The repeat read it back.
    expect(second).toBe(`read ${first}`);
  });

  it("returns the first result when create loses the claim to another call", async () => {
    const firstId = mintId();
    const result = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        const sql = yield* SqlClient.SqlClient;
        // Another call with the same key commits its claim after this call's
        // first lookup found nothing and before this call's own claim.
        const create = Effect.andThen(
          claim("session.spawn", "key-1", firstId),
          withTransaction(
            sql,
            Effect.as(dedup.claimDedupKey("session.spawn", "key-1", mintId()), "created"),
          ),
        );
        return yield* dedup.returnExistingOrCreate("session.spawn", "key-1", readExisting, create);
      }),
    );
    expect(result).toBe(`read ${firstId}`);
  });

  it("passes every other failure of create through, even after create claimed the key", async () => {
    const runs = { count: 0 };
    const exit = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        const sql = yield* SqlClient.SqlClient;
        const create = Effect.andThen(
          withTransaction(
            sql,
            Effect.gen(function* () {
              runs.count += 1;
              yield* dedup.claimDedupKey("session.spawn", "key-1", mintId());
            }),
          ),
          // The claim committed. Then the runner does not answer.
          Effect.fail({ _tag: "RunnerSilent" as const }),
        );
        const failed = yield* Effect.exit(
          dedup.returnExistingOrCreate("session.spawn", "key-1", readExisting, create),
        );
        // The key stays claimed, so the retry reads the first result instead of creating.
        const retried = yield* dedup.returnExistingOrCreate(
          "session.spawn",
          "key-1",
          readExisting,
          create,
        );
        return { failed, retried };
      }),
    );
    expect(Exit.isFailure(exit.failed)).toBe(true);
    expect(JSON.stringify(exit.failed)).toContain("RunnerSilent");
    expect(runs.count).toBe(1);
    expect(exit.retried).toMatch(/^read /);
  });

  it("dies when create loses a claim it was not asked to make", async () => {
    const exit = await runAs(
      USER,
      Effect.gen(function* () {
        const dedup = yield* dedupKeyRepository;
        return yield* Effect.exit(
          dedup.returnExistingOrCreate(
            "session.spawn",
            undefined,
            readExisting,
            Effect.fail(new DedupKeyTaken({ operation: "session.spawn", dedupKey: "key-1" })),
          ),
        );
      }),
    );
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(
      true,
    );
  });
});

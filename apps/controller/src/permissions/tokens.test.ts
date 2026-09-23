/**
 * Tests the resolver's cache: that it caches results, and that a cache
 * removal is not lost when it happens while a lookup is running.
 *
 * Which rows resolve - a running session's, but not an exited or queued one's,
 * and not an unknown token - is tested over the real HTTP server in
 * `http/session-actor.integration.test.ts`, where an agent presents the token
 * the controller actually gave its runner. That test cannot reach the timing
 * below, so here the resolver gets a SQL client that lets the test run code
 * after the query returns and before the result is cached.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { SessionTokens, SessionTokensLayer } from "./tokens";

const PROFILE = "0199e0e77b217000800000000000000a";
const SESSION = "0199e0e77b217000800000000000001a";

/** The same profile id in the canonical form the resolver returns. */
const PROFILE_ID = "0199e0e7-7b21-7000-8000-00000000000a";

/** What the test runs right after each query the resolver makes returns. */
let interleave: () => void = () => {};

/**
 * The resolver's SQL client, which calls `interleave` after every query it
 * runs. Only the `apply` trap is wrapped; the rest of the client is the real
 * one.
 */
const seamed = Layer.effect(SqlClient.SqlClient)(
  Effect.map(
    SqlClient.SqlClient,
    (sql) =>
      new Proxy(sql, {
        apply: (target, self, args: Parameters<typeof sql>) => {
          // A statement is an Effect, but the tagged template overloads do not
          // type it as one. The cast only fixes that.
          const query = Reflect.apply(target, self, args) as unknown as Effect.Effect<unknown>;
          return Effect.tap(query, () =>
            Effect.sync(() => {
              interleave();
            }),
          );
        },
      }),
  ),
);

const layer = SessionTokensLayer.pipe(Layer.provide(seamed), Layer.provideMerge(TestDatabase));

const arrange = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO permission_profiles (id, name, grants, shipped, created_at, updated_at)
    VALUES (unhex(${PROFILE}), 'worker', '["task.read","task.create"]', 0,
            '2026-09-15T10:00:00.000Z', '2026-09-15T10:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                          requested_access_mode, access_mode, spec, title, status,
                          created_at, last_activity_at, token_hash)
    VALUES (unhex(${SESSION}), unhex(${PROFILE}), unhex(${PROFILE}), unhex(${PROFILE}),
            'auto', 'auto', '{}', 'a session', 'idle',
            '2026-09-15T10:00:00.000Z', '2026-09-15T10:00:00.000Z', 'hash-live')
  `;
});

/** Narrows the profile to one grant, the way `profile.update` does. */
const narrow = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`UPDATE permission_profiles SET grants = '["task.read"]' WHERE id = unhex(${PROFILE})`,
);

const run = <A, E>(body: Effect.Effect<A, E, SessionTokens | SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.ensuring(
        Effect.flatMap(arrange, () => body),
        Effect.sync(() => {
          interleave = () => {};
        }),
      ),
      layer,
    ),
  );

const readGrants = (actor: Option.Option<{ readonly grants: ReadonlyArray<string> }>) =>
  Option.getOrThrow(actor).grants;

describe("the resolver cache", () => {
  it("returns the second call from the cache, without reading the row again", async () => {
    const { first, second } = await run(
      Effect.gen(function* () {
        const tokens = yield* SessionTokens;
        const first = yield* tokens.resolve("hash-live");
        // The row changes without the resolver being told, so a different
        // second result would mean it read the row again.
        yield* narrow;
        return { first, second: yield* tokens.resolve("hash-live") };
      }),
    );

    expect(readGrants(first)).toEqual(["task.read", "task.create"]);
    expect(readGrants(second)).toEqual(["task.read", "task.create"]);
  });

  it("does not cache the result of a lookup that was running when the cache was cleared", async () => {
    const after = await run(
      Effect.gen(function* () {
        const tokens = yield* SessionTokens;
        // The cache is cleared after the resolver's query returns and before
        // the result is cached. There is nothing to delete at that moment, so
        // the lookup itself must not cache what it read, which is the row as
        // it was before the edit that caused the clearing.
        interleave = () => {
          tokens.forgetProfile(PROFILE_ID);
        };
        yield* tokens.resolve("hash-live");
        interleave = () => {};
        yield* narrow;
        return yield* tokens.resolve("hash-live");
      }),
    );

    expect(readGrants(after)).toEqual(["task.read"]);
  });
});

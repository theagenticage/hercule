/**
 * The resolver's memory: that it has one, and that a drop landing while a
 * lookup is in flight is not lost.
 *
 * Which rows resolve - a live session's, not an exited or queued one's, not a
 * token nobody minted - is asserted over the real HTTP server in
 * `http/session-actor.integration.test.ts`, where an agent presents the token
 * the controller actually handed its machine. What cannot be reached from there
 * is the interleaving below, so the resolver is given a SQL client that lets
 * this test act in the moment between the query answering and the answer being
 * remembered.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { SessionTokens, SessionTokensLayer } from "./tokens";

const PROFILE = "0199e0e77b217000800000000000000a";
const SESSION = "0199e0e77b217000800000000000001a";

/** The same profile id in the canonical form the resolver answers with. */
const PROFILE_ID = "0199e0e7-7b21-7000-8000-00000000000a";

/** What the test does the moment a query the resolver made has answered. */
let interleave: () => void = () => {};

/**
 * The resolver's SQL client, with a seam after every query it runs. The apply
 * trap is the whole wrapper: everything else about the client is the real one's.
 */
const seamed = Layer.effect(SqlClient.SqlClient)(
  Effect.map(
    SqlClient.SqlClient,
    (sql) =>
      new Proxy(sql, {
        apply: (target, self, args: Parameters<typeof sql>) => {
          // A statement is an Effect; the overloads that describe the tagged
          // template do not say so, which is all this cast is for.
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

const grantsOf = (actor: Option.Option<{ readonly grants: ReadonlyArray<string> }>) =>
  Option.getOrThrow(actor).grants;

describe("what the resolver remembers", () => {
  it("answers the second call from memory, without asking the row again", async () => {
    const { first, second } = await run(
      Effect.gen(function* () {
        const tokens = yield* SessionTokens;
        const first = yield* tokens.resolve("hash-live");
        // The row changes underneath, and nothing has told the resolver: a
        // second answer that differs would mean it read again.
        yield* narrow;
        return { first, second: yield* tokens.resolve("hash-live") };
      }),
    );

    expect(grantsOf(first)).toEqual(["task.read", "task.create"]);
    expect(grantsOf(second)).toEqual(["task.read", "task.create"]);
  });

  it("keeps nothing from a lookup that was already reading when the drop landed", async () => {
    const after = await run(
      Effect.gen(function* () {
        const tokens = yield* SessionTokens;
        // The invalidation lands in the gap between the resolver's query
        // answering and its answer being remembered. There is nothing to delete
        // at that moment, so the lookup itself has to decline to keep what it
        // read - which is the row as it stood before the edit behind the drop.
        interleave = () => {
          tokens.forgetProfile(PROFILE_ID);
        };
        yield* tokens.resolve("hash-live");
        interleave = () => {};
        yield* narrow;
        return yield* tokens.resolve("hash-live");
      }),
    );

    expect(grantsOf(after)).toEqual(["task.read"]);
  });
});

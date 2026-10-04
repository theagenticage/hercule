/**
 * Tests the Connection state store an ingest handle receives:
 *
 * - each Connection reads only its own keys;
 * - deleting a Connection deletes its state, through the foreign key;
 * - `wipe` deletes the state of the Connections it is given, and no others;
 * - an empty key is refused with a message for the plugin author.
 */
import { describe, expect, it } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { connectionRepository } from "./repository";
import { connectionStateRepository } from "./state";

const at = "2026-09-01T00:00:00.000Z";

/** Inserts a Connection of the GitHub plugin and returns its id. */
const insertConnection = (label: string) =>
  Effect.map(
    Effect.flatMap(connectionRepository, (connections) =>
      connections.insert({
        pluginId: "github",
        type: "github/github",
        label,
        displayName: label,
        accountId: label,
        labels: [],
        config: {},
        at,
      }),
    ),
    (connection) => connection.id,
  );

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestDatabase), Effect.orDie));

describe("the Connection state store", () => {
  it("keeps each Connection's keys apart", async () => {
    const read = await run(
      Effect.gen(function* () {
        const state = yield* connectionStateRepository;
        const work = state.buildStore(yield* insertConnection("work"));
        const home = state.buildStore(yield* insertConnection("home"));
        yield* work.set("cursor", { since: "2026-09-01" });
        yield* work.set("seen", [1, 2]);
        yield* home.set("cursor", "other");
        yield* work.delete("seen");
        return {
          workCursor: yield* work.get("cursor"),
          workKeys: yield* work.list(),
          homeCursor: yield* home.get("cursor"),
          homeSeen: yield* home.get("seen"),
        };
      }),
    );

    expect(read.workCursor).toEqual(Option.some({ since: "2026-09-01" }));
    expect(read.workKeys).toEqual(["cursor"]);
    expect(read.homeCursor).toEqual(Option.some("other"));
    expect(read.homeSeen).toEqual(Option.none());
  });

  it("is deleted with its Connection", async () => {
    const keys = await run(
      Effect.gen(function* () {
        const state = yield* connectionStateRepository;
        const id = yield* insertConnection("work");
        yield* state.buildStore(id).set("cursor", 1);
        yield* Effect.flatMap(connectionRepository, (connections) => connections.delete(id));
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT key FROM connection_state`;
      }),
    );

    expect(keys).toEqual([]);
  });

  it("is wiped for the Connections given, and kept for the others", async () => {
    const read = await run(
      Effect.gen(function* () {
        const state = yield* connectionStateRepository;
        const work = yield* insertConnection("work");
        const home = yield* insertConnection("home");
        yield* state.buildStore(work).set("cursor", 1);
        yield* state.buildStore(home).set("cursor", 2);
        yield* state.wipe([work]);
        yield* state.wipe([]);
        return {
          work: yield* state.buildStore(work).list(),
          home: yield* state.buildStore(home).list(),
        };
      }),
    );

    expect(read).toEqual({ work: [], home: ["cursor"] });
  });

  it("refuses an empty key with a message for the plugin author", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const state = yield* connectionStateRepository;
        const store = state.buildStore(yield* insertConnection("work"));
        return yield* Effect.exit(store.set("", 1));
      }),
    );

    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
      "A Connection state key cannot be empty.",
    );
  });
});

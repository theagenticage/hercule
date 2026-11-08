/**
 * Tests the facts that deleting a Connection makes about the things Tasks
 * link, through `ConnectionEntityFacts` on real rows: the delete removes the
 * Connection's reads, and a completed pull request that nothing else can read
 * counts as open again.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor } from "../../actor";
import { ConnectionEntityFacts } from "../../connections";
import type { TaskService } from "../../tasks";
import { uuidFromString, withTransaction } from "../../db";
import {
  arrange,
  arrangeConnection,
  CONNECTION,
  createTaskLinking,
  declareKinds,
  PLUGIN,
  pr,
  readFacts,
  TaskTestLayer,
  USER,
} from "../../tasks/testing";
import { ConnectionEntityFactsLayer } from "./entity-facts";

const OTHER_CONNECTION = "0190c000-0000-7000-8000-0000000000a2";

const run = <A>(
  body: Effect.Effect<A, unknown, ConnectionEntityFacts | TaskService | SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* arrangeConnection;
      yield* declareKinds;
      return yield* body;
    }).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(ConnectionEntityFactsLayer.pipe(Layer.provideMerge(TaskTestLayer))),
      Effect.provide(TestClock.layer()),
      Effect.orDie,
    ),
  );

/** Deletes the Connection the way the connection service does: its reads go with it. */
const deleteConnection = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const facts = yield* ConnectionEntityFacts;
    yield* withTransaction(
      sql,
      facts.recordFactsOfDeletion(
        id,
        sql`DELETE FROM connections WHERE id = ${uuidFromString(id)}`,
      ),
    );
  });

/** Adds a second Connection of the plugin that also reads `ref`. */
const arrangeOtherReader = (ref: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withTransaction(
      sql,
      Effect.gen(function* () {
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (${uuidFromString(OTHER_CONNECTION)}, ${PLUGIN}, ${`${PLUGIN}/account`}, 'b', 'b',
            'b', 'connected', '[]', '{}', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO external_entity_observations (ref, connection_id, access)
          VALUES (${ref}, ${uuidFromString(OTHER_CONNECTION)}, 'ok')`;
      }),
    );
  });

describe("deleting the only Connection that reads a completed pull request", () => {
  it("writes a fact that the Task counts it as open again", async () => {
    const { facts, taskId } = await run(
      Effect.gen(function* () {
        yield* arrange({ ref: pr(1), lifecycle: "completed" });
        const task = yield* createTaskLinking("Review", pr(1));
        const linked = (yield* readFacts).length;
        yield* TestClock.adjust(60_000);
        yield* deleteConnection(CONNECTION);
        return { facts: (yield* readFacts).slice(linked), taskId: task.id };
      }),
    );
    expect(facts).toMatchObject([
      { taskId, ref: pr(1), lifecycle: "completed", previousLifecycle: "completed" },
    ]);
  });

  it("writes nothing when another Connection still reads it", async () => {
    const facts = await run(
      Effect.gen(function* () {
        yield* arrange({ ref: pr(1), lifecycle: "completed" });
        yield* arrangeOtherReader(pr(1));
        yield* createTaskLinking("Review", pr(1));
        const linked = (yield* readFacts).length;
        yield* TestClock.adjust(60_000);
        yield* deleteConnection(CONNECTION);
        return (yield* readFacts).slice(linked);
      }),
    );
    expect(facts).toEqual([]);
  });

  it("writes nothing for a thing no Task links", async () => {
    const facts = await run(
      Effect.gen(function* () {
        yield* arrange({ ref: pr(1), lifecycle: "completed" });
        yield* createTaskLinking("Elsewhere", pr(2));
        yield* deleteConnection(CONNECTION);
        return yield* readFacts;
      }),
    );
    expect(facts).toEqual([]);
  });
});

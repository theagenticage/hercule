/**
 * Tests the facts that a plugin's report makes about the things Tasks link,
 * through `ExternalEntityIngest` on real rows and the real Task service:
 *
 * - a lifecycle change of a linked pull request writes one fact for each live
 *   Task that links it, and a poll that changes nothing writes none
 * - what is not a fact: a title or an owner change, a first sight with no link
 * - a user's lookup (`storeRead`) behaves like a poll's refresh
 * - losing the last good read of a completed pull request, and getting it back
 *
 * The facts are read back from `task_entity_facts` and from the
 * `task.entityChanged` events in the log.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type { EntityLifecycle } from "@hercule/contract";
import type { EntityObservation, QualifiedEntityKindDeclaration } from "@hercule/plugin-host";
import { CurrentActor } from "../actor";
import { uuidFromString, withTransaction } from "../db";
import { readEventsOfKind } from "../events/testing";
import type { EntityReporter } from "../plugins";
import { TaskService } from "../tasks";
import {
  arrangeConnection,
  CONNECTION,
  createTaskLinking,
  declareKinds,
  PLUGIN,
  PULL_REQUEST,
  PULL_REQUEST_PREFIX,
  pr,
  readFacts,
  TaskTestLayer,
  USER,
} from "../tasks/testing";
import { ExternalEntityIngest, ExternalEntityIngestLayer, prepareObservations } from "./ingest";
import type { FullEntityObservation } from "./slots";

const OTHER_CONNECTION = "0190c000-0000-7000-8000-0000000000a2";

const PULL_REQUEST_KIND: QualifiedEntityKindDeclaration = {
  word: PULL_REQUEST,
  noun: "Pull request",
  refPrefix: PULL_REQUEST_PREFIX,
  pace: "fast",
  patience: 24,
  identifier: "#{key}",
  person: null,
  owner: null,
  status: null,
  facts: [],
  reasons: {},
};

const reporterOf = (connectionId: string): EntityReporter => ({
  connectionId,
  pluginId: PLUGIN,
  kinds: [PULL_REQUEST_KIND],
});

const reporter = reporterOf(CONNECTION);

/** Builds a full observation of pull request `number`, as a poll reports it. */
const pullRequest = (
  number: number,
  overrides: Partial<FullEntityObservation> = {},
): FullEntityObservation => ({
  kind: "pull-request",
  ref: pr(number),
  title: `Pull request ${String(number)}`,
  url: `https://northwind.example/pull/${String(number)}`,
  lifecycle: "open",
  fields: { key: String(number) },
  concerns: ["assigned"],
  sourceUpdatedAt: "2026-03-01T10:00:00Z",
  ...overrides,
});

/** Runs `body` on a fresh migrated database that holds the northwind plugin and its kinds. */
const run = <A>(
  body: (
    ingest: typeof ExternalEntityIngest.Service,
  ) => Effect.Effect<A, unknown, TaskService | SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-03-01T00:00:00Z"));
      yield* arrangeConnection;
      yield* declareKinds;
      return yield* body(yield* ExternalEntityIngest);
    }).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(ExternalEntityIngestLayer.pipe(Layer.provideMerge(TaskTestLayer))),
      Effect.provide(TestClock.layer()),
      Effect.orDie,
    ),
  );

const advance = TestClock.adjust(60_000);

/** Reports the pull requests as a complete inventory, a minute after the last call. */
const reconcile = (
  ingest: typeof ExternalEntityIngest.Service,
  observations: ReadonlyArray<EntityObservation>,
  as: EntityReporter = reporter,
) =>
  Effect.andThen(
    advance,
    ingest.reconcile(as, { kind: "pull-request", complete: true, observations }),
  );

/** Reports the pull requests as a poll's refresh does, a minute after the last call. */
const refresh = (
  ingest: typeof ExternalEntityIngest.Service,
  ...observations: Array<EntityObservation>
) => Effect.andThen(advance, ingest.refresh(reporter, observations));

/** What the facts and events hold now, with the fact rows reduced to what a test compares. */
const readOutcome = Effect.gen(function* () {
  const facts = yield* readFacts;
  const events = yield* readEventsOfKind("task.entityChanged");
  return { facts, events };
});

describe("the facts a plugin's report makes", () => {
  it("writes nothing when a refresh changes nothing", async () => {
    const outcome = await run((ingest) =>
      Effect.gen(function* () {
        yield* reconcile(ingest, [pullRequest(1)]);
        yield* createTaskLinking("Review", pr(1));
        const before = yield* readOutcome;
        yield* refresh(ingest, pullRequest(1));
        yield* reconcile(ingest, [pullRequest(1)]);
        return { before, after: yield* readOutcome };
      }),
    );
    expect(outcome.after.facts).toEqual(outcome.before.facts);
    expect(outcome.after.events).toHaveLength(outcome.before.events.length);
  });

  it("writes one fact and one event for each live Task that links a pull request whose lifecycle changed", async () => {
    const { facts, events, first, second } = await run((ingest) =>
      Effect.gen(function* () {
        yield* reconcile(ingest, [pullRequest(1)]);
        const first = yield* createTaskLinking("First", pr(1));
        const second = yield* createTaskLinking("Second", pr(1));
        yield* createTaskLinking("Unrelated");
        const linked = (yield* readOutcome).facts.length;
        yield* refresh(ingest, pullRequest(1, { lifecycle: "completed" }));
        const outcome = yield* readOutcome;
        return {
          facts: outcome.facts.slice(linked),
          events: outcome.events.slice(linked),
          first,
          second,
        };
      }),
    );
    expect(
      facts.map(({ taskId, previousLifecycle, lifecycle }) => ({
        taskId,
        lifecycle,
        previousLifecycle,
      })),
    ).toEqual(
      [first.id, second.id].map((taskId) => ({
        taskId,
        lifecycle: "completed",
        previousLifecycle: "open",
      })),
    );
    expect(
      events.map(({ payload }) => [payload.taskId, payload.openLinks, payload.completedLinks]),
    ).toEqual([first.id, second.id].map((taskId) => [taskId, 0, 1]));
  });

  it("counts all the links of the Task, not only the one that changed", async () => {
    const { events, taskId } = await run((ingest) =>
      Effect.gen(function* () {
        yield* reconcile(ingest, [
          pullRequest(1),
          pullRequest(2),
          pullRequest(3, { lifecycle: "completed" }),
        ]);
        const task = yield* createTaskLinking("Two reviews", pr(1), pr(2), pr(3));
        const linked = (yield* readOutcome).events.length;
        yield* refresh(ingest, pullRequest(1, { lifecycle: "completed" }));
        return { events: (yield* readOutcome).events.slice(linked), taskId: task.id };
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      taskId,
      ref: pr(1),
      lifecycle: "completed",
      previousLifecycle: "open",
      openLinks: 1,
      completedLinks: 2,
    });
  });

  it("writes the fact of a lifecycle change reported by a complete inventory as well", async () => {
    const lifecycles = await run((ingest) =>
      Effect.gen(function* () {
        yield* reconcile(ingest, [pullRequest(1)]);
        yield* createTaskLinking("Review", pr(1));
        const linked = (yield* readOutcome).facts.length;
        yield* reconcile(ingest, [pullRequest(1, { lifecycle: "abandoned" })]);
        return (yield* readFacts)
          .slice(linked)
          .map(({ lifecycle, previousLifecycle }) => [previousLifecycle, lifecycle]);
      }),
    );
    expect(lifecycles).toEqual([["open", "abandoned"]]);
  });

  it.each<[string, Partial<FullEntityObservation>]>([
    ["a new title", { title: "A better title" }],
    ["a new owner", { ownedByYou: true }],
    ["new facts", { fields: { key: "1", extra: "x" } }],
    ["a new time of the last change", { sourceUpdatedAt: "2026-03-02T10:00:00Z" }],
  ])("writes none for %s", async (_name, change) => {
    const outcome = await run((ingest) =>
      Effect.gen(function* () {
        yield* reconcile(ingest, [pullRequest(1)]);
        yield* createTaskLinking("Review", pr(1));
        const before = yield* readOutcome;
        yield* refresh(ingest, pullRequest(1, change));
        return { before, after: yield* readOutcome };
      }),
    );
    expect(outcome.after.facts).toEqual(outcome.before.facts);
    expect(outcome.after.events).toHaveLength(outcome.before.events.length);
  });

  it("writes a fact with no previous lifecycle when a linked ref is seen for the first time", async () => {
    const facts = await run((ingest) =>
      Effect.gen(function* () {
        const task = yield* createTaskLinking("Review", pr(1));
        const linked = (yield* readOutcome).facts;
        yield* refresh(ingest, pullRequest(1, { lifecycle: "completed" }));
        return {
          linked,
          written: (yield* readFacts).slice(linked.length),
          taskId: task.id,
        };
      }),
    );
    expect(facts.linked).toEqual([]);
    expect(
      facts.written.map(({ taskId, ref, lifecycle, previousLifecycle }) => ({
        taskId,
        ref,
        lifecycle,
        previousLifecycle,
      })),
    ).toEqual([
      { taskId: facts.taskId, ref: pr(1), lifecycle: "completed", previousLifecycle: null },
    ]);
  });

  it("writes nothing for the first sight of a ref no Task links", async () => {
    const outcome = await run((ingest) =>
      Effect.gen(function* () {
        yield* createTaskLinking("Elsewhere", pr(9));
        yield* reconcile(ingest, [pullRequest(1), pullRequest(2, { lifecycle: "completed" })]);
        yield* refresh(ingest, pullRequest(3));
        return yield* readOutcome;
      }),
    );
    expect(outcome.facts).toEqual([]);
    expect(outcome.events).toEqual([]);
  });

  it("writes nothing for a Task that is finished", async () => {
    const outcome = await run((ingest) =>
      Effect.gen(function* () {
        yield* reconcile(ingest, [pullRequest(1)]);
        const tasks = yield* TaskService;
        const task = yield* createTaskLinking("Review", pr(1));
        yield* tasks.update({ id: task.id, stage: "done" });
        const before = yield* readOutcome;
        yield* refresh(ingest, pullRequest(1, { lifecycle: "completed" }));
        return { before, after: yield* readOutcome };
      }),
    );
    expect(outcome.after.facts).toEqual(outcome.before.facts);
  });

  it("treats a user's lookup like a poll's refresh", async () => {
    const outcome = await run((ingest) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* reconcile(ingest, [pullRequest(1)]);
        const task = yield* createTaskLinking("Review", pr(1));
        const read = (lifecycle: EntityLifecycle) =>
          Effect.gen(function* () {
            const [observed] = yield* prepareObservations(reporter, [
              pullRequest(1, { lifecycle }),
            ]);
            yield* advance;
            yield* withTransaction(
              sql,
              ingest.storeRead({
                connectionId: CONNECTION,
                observed: observed!,
                activePluginIds: [PLUGIN],
              }),
            );
          });
        const before = yield* readOutcome;
        yield* read("open");
        const unchanged = yield* readOutcome;
        yield* read("completed");
        return { before, unchanged, after: yield* readOutcome, taskId: task.id };
      }),
    );
    expect(outcome.unchanged.facts).toEqual(outcome.before.facts);
    expect(outcome.after.facts.slice(outcome.before.facts.length)).toMatchObject([
      { taskId: outcome.taskId, lifecycle: "completed", previousLifecycle: "open" },
    ]);
  });

  describe("when a Connection fails to read a completed pull request", () => {
    /** Arranges a second Connection of the plugin, which can read the same things. */
    const arrangeOtherConnection = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* withTransaction(
        sql,
        sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (${uuidFromString(OTHER_CONNECTION)}, ${PLUGIN}, ${`${PLUGIN}/account`}, 'b', 'b',
            'b', 'connected', '[]', '{}', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
      );
    });

    it("writes a fact that the thing is open again when it was the last good read, and a fact when it can be read again", async () => {
      const { written, taskId } = await run((ingest) =>
        Effect.gen(function* () {
          yield* reconcile(ingest, [pullRequest(1, { lifecycle: "completed" })]);
          const task = yield* createTaskLinking("Review", pr(1));
          const linked = (yield* readOutcome).events.length;
          yield* advance;
          yield* ingest.reportMissing(reporter, pr(1), "inaccessible");
          yield* refresh(ingest, pullRequest(1, { lifecycle: "completed" }));
          return { written: (yield* readOutcome).events.slice(linked), taskId: task.id };
        }),
      );
      expect(written.map(({ payload }) => payload)).toMatchObject([
        {
          taskId,
          lifecycle: "completed",
          previousLifecycle: "completed",
          openLinks: 1,
          completedLinks: 0,
        },
        {
          taskId,
          lifecycle: "completed",
          previousLifecycle: "completed",
          openLinks: 0,
          completedLinks: 1,
        },
      ]);
    });

    it("writes nothing when another Connection can still read it", async () => {
      const outcome = await run((ingest) =>
        Effect.gen(function* () {
          yield* arrangeOtherConnection;
          yield* reconcile(ingest, [pullRequest(1, { lifecycle: "completed" })]);
          yield* reconcile(
            ingest,
            [pullRequest(1, { lifecycle: "completed" })],
            reporterOf(OTHER_CONNECTION),
          );
          yield* createTaskLinking("Review", pr(1));
          const before = yield* readOutcome;
          yield* advance;
          yield* ingest.reportMissing(reporter, pr(1), "inaccessible");
          return { before, after: yield* readOutcome };
        }),
      );
      expect(outcome.after.facts).toEqual(outcome.before.facts);
      expect(outcome.after.events).toHaveLength(outcome.before.events.length);
    });

    it("writes nothing for a thing that is still open", async () => {
      const outcome = await run((ingest) =>
        Effect.gen(function* () {
          yield* reconcile(ingest, [pullRequest(1)]);
          yield* createTaskLinking("Review", pr(1));
          const before = yield* readOutcome;
          yield* advance;
          yield* ingest.reportMissing(reporter, pr(1), "deleted");
          return { before, after: yield* readOutcome };
        }),
      );
      expect(outcome.after.facts).toEqual(outcome.before.facts);
    });
  });
});

describe("the cost of watching for facts", () => {
  it("sends one statement, however many refs a report names, when no live Task links any of them", async () => {
    const statements = await run(() =>
      Effect.gen(function* () {
        yield* createTaskLinking("Elsewhere", pr(9));
        const tasks = yield* TaskService;
        const seen: Array<string> = [];
        yield* Effect.provideService(
          withTransaction(
            yield* SqlClient.SqlClient,
            tasks.recordEntityFactsAround([pr(1), pr(2), pr(3), pr(4), pr(5)], Effect.void),
          ),
          Statement.CurrentTransformer,
          (statement) =>
            Effect.sync(() => {
              seen.push(statement.compile()[0]);
              return statement;
            }),
        );
        return seen;
      }),
    );
    expect(statements).toHaveLength(1);
  });
});

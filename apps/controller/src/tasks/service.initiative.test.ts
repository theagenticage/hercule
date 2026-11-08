/**
 * Tests the Initiative of a Task through the Task service and the board read
 * on real rows: putting a Task on an Initiative and taking it off (create,
 * update and move), which Initiatives refuse a Task, the `initiativeId` filter,
 * what deleting an Initiative does to its Tasks (`clearInitiative`), what a
 * merge does with the two Initiatives, and what the board carries (the cards'
 * `initiativeId` and the Done count of each Initiative).
 *
 * The Initiative rows are written in SQL: the initiatives domain imports this
 * one, and this domain only reads the table.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type { Task, TaskStage } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { buildAnnouncementRecorder } from "../db/testing";
import { TaskBoardFactsLayer, TaskServicePortsLayer } from "../daemon/tasks";
import { TaskTrackingRunsLayer } from "../daemon/runs";
import { PlatformEventsLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { NotifierLayer } from "../notifications";
import { buildPluginStack } from "../plugins/testing";
import { TaskBoard, TaskBoardLayer } from "./board";
import { TaskService, TaskServiceLayer } from "./index";
import { taskRepository } from "./repository";
import { A_MINUTE, USER } from "./testing";

const reads = TaskBoardLayer.pipe(
  Layer.provide(Layer.mergeAll(TaskBoardFactsLayer, TaskTrackingRunsLayer)),
  Layer.provideMerge(buildPluginStack()),
);

const layer = TaskServiceLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(TaskServicePortsLayer),
  Layer.provideMerge(PlatformEventsLayer),
  Layer.provideMerge(reads),
);

type Deps = TaskService | TaskBoard | SqlClient.SqlClient;

const SESSION = {
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  profileId: "0199e0e7-0003-7000-8000-000000000000",
  grants: ["task.read", "task.update", "task.create"],
  profileGrants: ["task.read", "task.update", "task.create"],
  assistantId: null,
  agentId: null,
} as unknown as Actor;

const run = <A, E>(effect: Effect.Effect<A, E, Deps>, actor: Actor = USER) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, actor),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

const AT = "2026-11-01T09:00:00.000Z";

/** Writes an Initiative row and returns its id. */
const insertInitiative = (
  name: string,
  state: { readonly closed?: boolean; readonly deleted?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintUuid();
    yield* withTransaction(
      sql,
      sql`INSERT INTO initiatives (id, name, intent, hue, closed_at, created_at, updated_at,
                                   created_by, updated_by, deleted_at)
          VALUES (${id}, ${name}, '', 245, ${state.closed === true ? AT : null}, ${AT}, ${AT},
                  'user', 'user', ${state.deleted === true ? AT : null})`,
    );
    return uuidToString(id);
  });

/** Closes or deletes an Initiative that exists. */
const setInitiativeState = (id: string, column: "closed_at" | "deleted_at") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withTransaction(
      sql,
      sql`UPDATE initiatives SET ${sql.literal(column)} = ${AT} WHERE id = ${uuidFromString(id)}`,
    );
  });

const createTask = (title: string, fields: { readonly stage?: TaskStage; initiativeId?: string }) =>
  Effect.flatMap(TaskService, (tasks) => tasks.create({ title, description: "", ...fields }));

/** Returns the `changes` of every `task.updated` event of the Task, oldest first. */
const readChanges = (taskId: string) =>
  Effect.map(readEventsOfKind("task.updated"), (events) =>
    events
      .filter((event) => (event.payload as { taskId: string }).taskId === taskId)
      .map((event) => (event.payload as { changes: Record<string, unknown> }).changes),
  );

describe("putting a Task on an Initiative", () => {
  it("starts a Task on an Initiative, and reads it back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const initiative = yield* insertInitiative("Platform");
        const created = yield* createTask("Add a refund button", { initiativeId: initiative });
        const read = yield* Effect.flatMap(TaskService, (tasks) => tasks.read(created.id));
        return { initiative, created, read };
      }),
    );
    expect(result.created.initiativeId).toBe(result.initiative);
    expect(result.read.initiativeId).toBe(result.initiative);
  });

  it("sets and clears the Initiative on update, and reports the change as old and new", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const initiative = yield* insertInitiative("Platform");
        const task = yield* createTask("Add a refund button", {});
        yield* TestClock.adjust(A_MINUTE);
        const put = yield* tasks.update({ id: task.id, initiativeId: initiative });
        yield* TestClock.adjust(A_MINUTE);
        const cleared = yield* tasks.update({ id: task.id, initiativeId: null });
        return { initiative, put, cleared, changes: yield* readChanges(task.id) };
      }),
    );
    expect(result.put.initiativeId).toBe(result.initiative);
    expect(result.cleared.initiativeId).toBeUndefined();
    expect(result.changes).toEqual([
      { initiativeId: { old: null, new: result.initiative } },
      { initiativeId: { old: result.initiative, new: null } },
    ]);
  });

  it("writes nothing when the Task is on that Initiative already", async () => {
    const result = await run(
      Effect.gen(function* () {
        const initiative = yield* insertInitiative("Platform");
        const task = yield* createTask("Add a refund button", { initiativeId: initiative });
        yield* TestClock.adjust(A_MINUTE);
        const tasks = yield* TaskService;
        const again = yield* tasks.update({ id: task.id, initiativeId: initiative });
        return { task, again, changes: yield* readChanges(task.id) };
      }),
    );
    expect(result.again.updatedAt).toBe(result.task.updatedAt);
    expect(result.changes).toEqual([]);
  });

  it("moves a Task to another stage and another Initiative in one write", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const initiative = yield* insertInitiative("Platform");
        const task = yield* createTask("Add a refund button", { stage: "planned" });
        yield* TestClock.adjust(A_MINUTE);
        const moved = yield* tasks.move({
          id: task.id,
          stage: "building",
          initiativeId: initiative,
        });
        yield* TestClock.adjust(A_MINUTE);
        const taken = yield* tasks.move({ id: task.id, initiativeId: null });
        return { initiative, moved, taken, changes: yield* readChanges(task.id) };
      }),
    );
    expect(result.moved).toMatchObject({ stage: "building", initiativeId: result.initiative });
    expect(result.taken.initiativeId).toBeUndefined();
    expect(result.changes.map((changes) => Object.keys(changes).sort())).toEqual([
      ["initiativeId", "stage", "status"],
      ["initiativeId"],
    ]);
  });

  it("lets a session put a Task on an Initiative that exists", async () => {
    const task = await run(
      Effect.gen(function* () {
        const initiative = yield* insertInitiative("Platform");
        const created = yield* createTask("Add a refund button", {});
        const tasks = yield* TaskService;
        return yield* tasks.update({ id: created.id, initiativeId: initiative });
      }),
      SESSION,
    );
    expect(task.initiativeId).toBeDefined();
  });

  const WRITES: ReadonlyArray<
    readonly [
      string,
      (initiativeId: string) => Effect.Effect<unknown, unknown, TaskService | SqlClient.SqlClient>,
    ]
  > = [
    ["create", (initiativeId) => createTask("New", { initiativeId })],
    [
      "update",
      (initiativeId) =>
        Effect.gen(function* () {
          const task = yield* createTask("Existing", {});
          return yield* Effect.flatMap(TaskService, (tasks) =>
            tasks.update({ id: task.id, initiativeId }),
          );
        }),
    ],
    [
      "move",
      (initiativeId) =>
        Effect.gen(function* () {
          const task = yield* createTask("Existing", {});
          return yield* Effect.flatMap(TaskService, (tasks) =>
            tasks.move({ id: task.id, initiativeId }),
          );
        }),
    ],
  ];

  it.each(WRITES)(
    "fails %s with not_found for an Initiative that does not exist",
    async (_name, write) => {
      const error = await run(Effect.flip(write(uuidToString(mintUuid()))));
      expect(error).toMatchObject({ error: { code: "not_found" } });
    },
  );

  it.each(WRITES)("fails %s with not_found for a deleted Initiative", async (_name, write) => {
    const error = await run(
      Effect.flip(
        Effect.flatMap(insertInitiative("Gone", { deleted: true }), (initiative) =>
          write(initiative),
        ),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it.each(WRITES)("fails %s with invalid_state for a closed Initiative", async (_name, write) => {
    const error = await run(
      Effect.flip(
        Effect.flatMap(insertInitiative("Done", { closed: true }), (initiative) =>
          write(initiative),
        ),
      ),
    );
    expect(error).toMatchObject({ error: { code: "invalid_state" } });
  });

  it("leaves a Task alone when the write that names a closed Initiative is refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const closed = yield* insertInitiative("Done", { closed: true });
        const task = yield* createTask("Add a refund button", {});
        const error = yield* Effect.flip(
          tasks.update({ id: task.id, title: "Renamed", initiativeId: closed }),
        );
        return { error, after: yield* tasks.read(task.id) };
      }),
    );
    expect(result.after).toMatchObject({ title: "Add a refund button" });
    expect(result.after.initiativeId).toBeUndefined();
  });

  it("never refuses an edit of a Task that stays on an Initiative that was closed since", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const initiative = yield* insertInitiative("Platform");
        const task = yield* createTask("Add a refund button", { initiativeId: initiative });
        yield* setInitiativeState(initiative, "closed_at");
        yield* TestClock.adjust(A_MINUTE);
        const renamed = yield* tasks.update({ id: task.id, title: "Renamed" });
        const named = yield* tasks.update({
          id: task.id,
          initiativeId: initiative,
          priority: "high",
        });
        const moved = yield* tasks.move({
          id: task.id,
          stage: "building",
          initiativeId: initiative,
        });
        const cleared = yield* tasks.update({ id: task.id, initiativeId: null });
        return { initiative, renamed, named, moved, cleared };
      }),
    );
    expect(result.renamed).toMatchObject({ title: "Renamed", initiativeId: result.initiative });
    expect(result.named).toMatchObject({ priority: "high", initiativeId: result.initiative });
    expect(result.moved).toMatchObject({ stage: "building", initiativeId: result.initiative });
    expect(result.cleared.initiativeId).toBeUndefined();
  });

  it("refuses to move a Task from one Initiative to a closed one", async () => {
    const error = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const open = yield* insertInitiative("Platform");
        const closed = yield* insertInitiative("Done", { closed: true });
        const task = yield* createTask("Add a refund button", { initiativeId: open });
        return yield* Effect.flip(tasks.update({ id: task.id, initiativeId: closed }));
      }),
    );
    expect(error).toMatchObject({ error: { code: "invalid_state" } });
  });
});

describe("listing the Tasks of an Initiative", () => {
  it("lists only the live Tasks of that Initiative", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const platform = yield* insertInitiative("Platform");
        const other = yield* insertInitiative("Storefront");
        const first = yield* createTask("First", { initiativeId: platform });
        const second = yield* createTask("Second", { initiativeId: platform, stage: "landed" });
        const gone = yield* createTask("Deleted", { initiativeId: platform });
        yield* tasks.delete(gone.id);
        yield* createTask("Elsewhere", { initiativeId: other });
        yield* createTask("Loose", {});
        const page = yield* tasks.query({ initiativeId: platform });
        return { titles: page.items.map((task) => task.title).sort(), ids: [first.id, second.id] };
      }),
    );
    expect(result.titles).toEqual(["First", "Second"]);
  });

  it("keeps a search cursor to the filter it was made under", async () => {
    const error = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const platform = yield* insertInitiative("Platform");
        const other = yield* insertInitiative("Storefront");
        for (const title of ["Refund one", "Refund two"]) {
          yield* createTask(title, { initiativeId: platform });
        }
        const first = yield* tasks.query({ initiativeId: platform, text: "refund", limit: 1 });
        return yield* Effect.flip(
          tasks.query({
            initiativeId: other,
            text: "refund",
            limit: 1,
            cursor: first.nextCursor!,
          }),
        );
      }),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });
});

describe("clearInitiative", () => {
  it("takes every live Task off the Initiative and says so once for each", async () => {
    const { result, announced } = await (async () => {
      const recorder = buildAnnouncementRecorder();
      const result = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const initiative = yield* insertInitiative("Platform");
          const other = yield* insertInitiative("Storefront");
          const building = yield* createTask("Building", { initiativeId: initiative });
          const finished = yield* createTask("Finished", { initiativeId: initiative });
          yield* tasks.update({ id: finished.id, stage: "done" });
          const deleted = yield* createTask("Deleted", { initiativeId: initiative });
          yield* tasks.delete(deleted.id);
          const kept = yield* createTask("Elsewhere", { initiativeId: other });
          const cleared = yield* tasks.clearInitiative(initiative);
          return {
            initiative,
            cleared,
            expected: [building.id, finished.id].sort(),
            building: yield* tasks.read(building.id),
            finished: yield* tasks.read(finished.id),
            kept: yield* tasks.read(kept.id),
            events: yield* readChanges(building.id),
            finishedEvents: yield* readChanges(finished.id),
          };
        }).pipe(Effect.provide(recorder.listener)),
      );
      return { result, announced: recorder.announced };
    })();
    expect(result.cleared).toEqual(result.expected);
    expect(result.building.initiativeId).toBeUndefined();
    expect(result.finished.initiativeId).toBeUndefined();
    expect(result.kept.initiativeId).toBeDefined();
    const cleared = { initiativeId: { old: result.initiative, new: null } };
    expect(result.events.at(-1)).toEqual(cleared);
    expect(result.finishedEvents.at(-1)).toEqual(cleared);
    // Each cleared Task is announced as a plain `task` change, and none else.
    const afterClear = announced.filter(
      (change) => change._tag === "record" && change.id === result.building.id,
    );
    expect(afterClear.at(-1)).toEqual({
      _tag: "record",
      topic: "task",
      id: result.building.id,
      kind: "updated",
    });
  });

  it("answers an empty list for an Initiative with no Tasks, and writes no event", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const initiative = yield* insertInitiative("Empty");
        const cleared = yield* tasks.clearInitiative(initiative);
        return { cleared, events: yield* readEventsOfKind("task.updated") };
      }),
    );
    expect(result.cleared).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("refuses a caller who is not the user, even one who holds the grants", async () => {
    const error = await run(
      Effect.flatMap(insertInitiative("Platform"), (initiative) =>
        Effect.flip(Effect.flatMap(TaskService, (tasks) => tasks.clearInitiative(initiative))),
      ),
      SESSION,
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("merging Tasks that belong to Initiatives", () => {
  const mergeInto = (
    sourceInitiative: "none" | "same" | "other" | "closed",
    survivorInitiative: "none" | "platform",
  ) =>
    run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const platform = yield* insertInitiative("Platform");
        const storefront = yield* insertInitiative("Storefront");
        const closed = yield* insertInitiative("Done");
        const fieldsOf = (initiativeId: string | undefined) =>
          initiativeId === undefined ? {} : { initiativeId };
        const source = yield* createTask("Source", {
          ...fieldsOf(
            { none: undefined, same: platform, other: storefront, closed }[sourceInitiative],
          ),
        });
        const survivor = yield* createTask("Survivor", {
          ...fieldsOf(survivorInitiative === "platform" ? platform : undefined),
        });
        if (sourceInitiative === "closed") yield* setInitiativeState(closed, "closed_at");
        yield* TestClock.adjust(A_MINUTE);
        const merged = yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        return {
          ids: { platform, storefront, closed },
          merged,
          members: (yield* tasks.query({ initiativeId: platform })).items.map((task) => task.id),
          survivorChanges: yield* readChanges(survivor.id),
        };
      }),
    );

  it("keeps the survivor's own Initiative", async () => {
    const result = await mergeInto("other", "platform");
    expect(result.merged.initiativeId).toBe(result.ids.platform);
    expect(result.survivorChanges.some((changes) => "initiativeId" in changes)).toBe(false);
  });

  it("keeps the survivor's Initiative when the source is on the same one", async () => {
    const result = await mergeInto("same", "platform");
    expect(result.merged.initiativeId).toBe(result.ids.platform);
    expect(result.members).toEqual([result.merged.id]);
  });

  it("gives a survivor with none the source's Initiative, and says so in the survivor's event", async () => {
    const result = await mergeInto("other", "none");
    expect(result.merged.initiativeId).toBe(result.ids.storefront);
    expect(result.survivorChanges.at(-1)).toMatchObject({
      initiativeId: { old: null, new: result.ids.storefront },
    });
  });

  it("gives a survivor with none the source's Initiative even when it is closed", async () => {
    const result = await mergeInto("closed", "none");
    expect(result.merged.initiativeId).toBe(result.ids.closed);
  });

  it("leaves a survivor with none alone when the source has none either", async () => {
    const result = await mergeInto("none", "none");
    expect(result.merged.initiativeId).toBeUndefined();
  });

  it("takes the merged Task off its Initiative, so it leaves the partial index", async () => {
    const left = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const platform = yield* insertInitiative("Platform");
        const source = yield* createTask("Source", { initiativeId: platform });
        const survivor = yield* createTask("Survivor", {});
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        const rows = yield* sql<{ readonly id: Uint8Array }>`
          SELECT id FROM tasks WHERE id = ${uuidFromString(source.id)} AND initiative_id IS NOT NULL`;
        return rows.length;
      }),
    );
    expect(left).toBe(0);
  });
});

describe("the Initiative on the board", () => {
  const insertTaskAt = (
    title: string,
    stage: TaskStage,
    initiativeId: string | undefined,
  ): Effect.Effect<Task, unknown, TaskService | SqlClient.SqlClient> =>
    createTask(title, { stage, ...(initiativeId === undefined ? {} : { initiativeId }) });

  it("puts the Initiative on a card, and none on a Task that has none", async () => {
    const result = await run(
      Effect.gen(function* () {
        const initiative = yield* insertInitiative("Platform");
        const member = yield* insertTaskAt("Member", "building", initiative);
        const loose = yield* insertTaskAt("Loose", "building", undefined);
        const board = yield* Effect.flatMap(TaskBoard, (reader) => reader.query());
        return {
          initiative,
          member: board.cards.find((card) => card.id === member.id),
          loose: board.cards.find((card) => card.id === loose.id),
        };
      }),
    );
    expect(result.member?.initiativeId).toBe(result.initiative);
    expect(result.loose).toBeDefined();
    expect(result.loose?.initiativeId).toBeUndefined();
  });

  it("counts the Done Tasks of each Initiative, and leaves out Dropped, deleted and merged ones", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const platform = yield* insertInitiative("Platform");
        const storefront = yield* insertInitiative("Storefront");
        const noDone = yield* insertInitiative("Nothing landed");
        yield* insertTaskAt("Open", "building", platform);
        yield* insertTaskAt("Landed", "landed", platform);
        yield* insertTaskAt("Done one", "done", platform);
        yield* insertTaskAt("Done two", "done", platform);
        yield* insertTaskAt("Dropped", "dropped", platform);
        const deleted = yield* insertTaskAt("Done then deleted", "done", platform);
        yield* tasks.delete(deleted.id);
        const merged = yield* insertTaskAt("Done then merged", "done", platform);
        yield* withTransaction(
          sql,
          sql`UPDATE tasks SET merged_into_id = ${uuidFromString(merged.id)}
              WHERE id = ${uuidFromString(merged.id)}`,
        );
        yield* insertTaskAt("Done elsewhere", "done", storefront);
        yield* insertTaskAt("Done and loose", "done", undefined);
        const board = yield* Effect.flatMap(TaskBoard, (reader) => reader.query());
        return { platform, storefront, noDone, counts: board.initiativeDoneCounts };
      }),
    );
    expect(result.counts).toEqual({ [result.platform]: 2, [result.storefront]: 1 });
  });

  it("reads the Done counts from the partial index of Tasks on an Initiative", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* tasks.countDoneTasksByInitiative().pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile());
              return statement;
            }),
          ),
        );
        const [text, params] = statements[0]!;
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params,
        );
        return rows.map((row) => row.detail);
      }),
    );
    expect(plan.join("\n")).toContain("USING INDEX tasks_initiative");
  });
});

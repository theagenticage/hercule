/**
 * Tests `task.move`: where a Task lands in a cell, what it refuses, and that
 * one move writes one `task.updated`, whatever the cell had to do to make
 * room. A cell is the Tasks of one project at one stage.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import type { BoardStage, TaskStage } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { NotifierLayer } from "../notifications";
import { MAX_BOARD_RANK_LENGTH } from "./board-rank";
import { taskRepository } from "./repository";
import { TaskService, TaskServiceLayer } from "./index";
import { TaskLinkOwnersLayer } from "../daemon/tasks";

const layer = TaskServiceLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(TaskLinkOwnersLayer),
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const run = <A, E>(effect: Effect.Effect<A, E, TaskService | SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

const runError = <A, E>(effect: Effect.Effect<A, E, TaskService | SqlClient.SqlClient>) =>
  run(Effect.flip(effect));

/** Writes a project and returns its id. */
const insertProject = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintUuid();
    yield* withTransaction(
      sql,
      sql`INSERT INTO projects (id, name, created_at, updated_at)
          VALUES (${id}, ${name}, '2026-09-04T10:00:00.000Z', '2026-09-04T10:00:00.000Z')`,
    );
    return uuidToString(id);
  });

/** Deletes a project the way the projects domain does: the row stays, marked deleted. */
const deleteProject = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withTransaction(
      sql,
      sql`UPDATE projects SET deleted_at = '2026-09-05T10:00:00.000Z' WHERE id = ${uuidFromString(id)}`,
    );
  });

/** Creates a Task in a cell. */
const createInCell = (title: string, stage: TaskStage, projectId?: string) =>
  Effect.flatMap(TaskService, (tasks) =>
    tasks.create({
      title,
      description: "",
      stage,
      ...(projectId === undefined ? {} : { projectId }),
    }),
  );

/** Returns the titles of the cell's Tasks in rank order. */
const readCellTitles = (projectId: string | null, stage: BoardStage) =>
  Effect.gen(function* () {
    const repository = yield* taskRepository;
    const tasks = yield* TaskService;
    const ranked = yield* repository.listCellRanks({ projectId, stage });
    return yield* Effect.forEach(ranked, (entry) =>
      Effect.map(tasks.read(entry.id), (task) => task.title),
    );
  });

/** Creates the Tasks of a cell, in the order given, and returns them by title. */
const fillCell = (
  titles: ReadonlyArray<string>,
  stage: TaskStage,
  projectId?: string,
): Effect.Effect<Record<string, string>, unknown, TaskService | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const ids: Record<string, string> = {};
    for (const title of titles) ids[title] = (yield* createInCell(title, stage, projectId)).id;
    return ids;
  });

describe("task.move", () => {
  it.each([
    ["first, when afterTaskId is null", null, ["moved", "a", "b", "c"]],
    ["after the card afterTaskId names", "a", ["a", "moved", "b", "c"]],
    ["after the last card", "c", ["a", "b", "c", "moved"]],
    ["last, when afterTaskId is absent", undefined, ["a", "b", "c", "moved"]],
  ] as const)("puts a Task from another stage %s", async (_name, after, expected) => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const cell = yield* fillCell(["a", "b", "c"], "building");
        const moved = yield* createInCell("moved", "planned");
        const placed = yield* tasks.move({
          id: moved.id,
          stage: "building",
          ...(after === undefined ? {} : { afterTaskId: after === null ? null : cell[after]! }),
        });
        return {
          placed,
          building: yield* readCellTitles(null, "building"),
          planned: yield* readCellTitles(null, "planned"),
        };
      }),
    );
    expect(result.building).toEqual(expected);
    expect(result.planned).toEqual([]);
    expect(result.placed).toMatchObject({ stage: "building", status: "in-progress" });
  });

  it("moves a Task to another project's cell and to No project, and leaves the other cells alone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const storefront = yield* insertProject("Northwind Storefront");
        const support = yield* insertProject("Northwind Support");
        const stay = yield* fillCell(["stay"], "planned", storefront);
        const there = yield* fillCell(["there 1", "there 2"], "planned", support);
        const moved = yield* createInCell("moved", "planned", storefront);
        yield* tasks.move({ id: moved.id, projectId: support, afterTaskId: there["there 1"]! });
        const second = yield* tasks.move({ id: moved.id, projectId: null });
        return {
          second,
          storefront: yield* readCellTitles(storefront, "planned"),
          support: yield* readCellTitles(support, "planned"),
          noProject: yield* readCellTitles(null, "planned"),
          stay,
        };
      }),
    );
    expect(result.storefront).toEqual(["stay"]);
    expect(result.support).toEqual(["there 1", "there 2"]);
    expect(result.noProject).toEqual(["moved"]);
    expect(result.second.projectId).toBeUndefined();
  });

  it("reorders a Task inside its cell and puts the cell's other cards in the order they had", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const cell = yield* fillCell(["a", "b", "c", "d"], "planned");
        yield* tasks.move({ id: cell["d"]!, afterTaskId: cell["a"]! });
        const afterD = yield* readCellTitles(null, "planned");
        yield* tasks.move({ id: cell["a"]!, afterTaskId: null });
        const afterA = yield* readCellTitles(null, "planned");
        yield* tasks.move({ id: cell["a"]!, afterTaskId: cell["c"]! });
        return { afterD, afterA, last: yield* readCellTitles(null, "planned") };
      }),
    );
    expect(result.afterD).toEqual(["a", "d", "b", "c"]);
    expect(result.afterA).toEqual(["a", "d", "b", "c"]);
    expect(result.last).toEqual(["d", "b", "c", "a"]);
  });

  it("keeps a Task where it is when it is moved without afterTaskId inside its own cell, or after the card it already follows, and writes nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const cell = yield* fillCell(["a", "b", "c"], "planned");
        const before = yield* tasks.read(cell["b"]!);
        yield* TestClock.adjust(60_000);
        const unchanged = [
          yield* tasks.move({ id: cell["b"]!, stage: "planned" }),
          yield* tasks.move({ id: cell["b"]! }),
          yield* tasks.move({ id: cell["b"]!, afterTaskId: cell["a"]! }),
        ];
        return {
          before,
          unchanged,
          events: yield* readEventsOfKind("task.updated"),
          titles: yield* readCellTitles(null, "planned"),
        };
      }),
    );
    for (const task of result.unchanged) expect(task).toEqual(result.before);
    expect(result.events).toEqual([]);
    expect(result.titles).toEqual(["a", "b", "c"]);
  });

  it("treats a Task of a deleted project as a card of No project, and keeps its project until it is moved to a lane", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const gone = yield* insertProject("Northwind Archive");
        const orphan = yield* createInCell("orphan", "planned", gone);
        yield* deleteProject(gone);
        const plain = yield* createInCell("plain", "planned");
        const mover = yield* createInCell("mover", "exploring");
        const sameLane = yield* tasks.move({ id: orphan.id, afterTaskId: plain.id });
        const dropped = yield* tasks.move({
          id: mover.id,
          stage: "planned",
          projectId: null,
          afterTaskId: orphan.id,
        });
        const refused = yield* Effect.flip(
          tasks.move({ id: mover.id, projectId: gone, stage: "planned" }),
        );
        const cleared = yield* tasks.move({ id: orphan.id, projectId: null });
        return {
          sameLane,
          dropped,
          refused,
          cleared,
          titles: yield* readCellTitles(null, "planned"),
        };
      }),
    );
    expect(result.sameLane.projectId).toBeDefined();
    expect(result.dropped.stage).toBe("planned");
    expect(result.refused).toMatchObject({ error: { code: "not_found" } });
    expect(result.cleared.projectId).toBeUndefined();
    expect(result.titles).toEqual(["plain", "orphan", "mover"]);
  });

  describe("refusals", () => {
    it("fails with Validation when afterTaskId is the moving Task itself", async () => {
      const error = await runError(
        Effect.gen(function* () {
          const task = yield* createInCell("alone", "planned");
          return yield* Effect.flatMap(TaskService, (tasks) =>
            tasks.move({ id: task.id, afterTaskId: task.id }),
          );
        }),
      );
      expect(error).toMatchObject({
        error: { code: "validation", details: { issues: [{ path: ["afterTaskId"] }] } },
      });
    });

    it("fails with Validation when afterTaskId is a card of another stage or another project", async () => {
      const errors = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const project = yield* insertProject("Northwind Storefront");
          const here = yield* createInCell("here", "planned");
          const otherStage = yield* createInCell("other stage", "building");
          const otherProject = yield* createInCell("other project", "planned", project);
          return [
            yield* Effect.flip(tasks.move({ id: here.id, afterTaskId: otherStage.id })),
            yield* Effect.flip(tasks.move({ id: here.id, afterTaskId: otherProject.id })),
            yield* Effect.flip(
              tasks.move({ id: otherStage.id, stage: "planned", afterTaskId: otherProject.id }),
            ),
          ];
        }),
      );
      for (const error of errors) {
        expect(error).toMatchObject({ error: { code: "validation" } });
      }
    });

    it("fails with NotFound for a Task, a project or an afterTaskId that does not exist, or is deleted", async () => {
      const errors = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const task = yield* createInCell("real", "planned");
          const deleted = yield* createInCell("deleted", "planned");
          yield* tasks.delete(deleted.id);
          return [
            yield* Effect.flip(tasks.move({ id: UNKNOWN_ID, stage: "building" })),
            yield* Effect.flip(tasks.move({ id: deleted.id, stage: "building" })),
            yield* Effect.flip(tasks.move({ id: task.id, projectId: UNKNOWN_ID })),
            yield* Effect.flip(tasks.move({ id: task.id, afterTaskId: UNKNOWN_ID })),
            yield* Effect.flip(tasks.move({ id: task.id, afterTaskId: deleted.id })),
          ];
        }),
      );
      for (const error of errors) expect(error).toMatchObject({ error: { code: "not_found" } });
    });

    it("refuses to move a finished Task that is given no stage, and puts one that is given a stage last in that cell", async () => {
      const result = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          yield* fillCell(["a", "b"], "planned");
          const finished = yield* createInCell("finished", "planned");
          yield* tasks.update({ id: finished.id, stage: "done" });
          const refused = yield* Effect.flip(tasks.move({ id: finished.id, afterTaskId: null }));
          const restored = yield* tasks.move({ id: finished.id, stage: "planned" });
          return { refused, restored, titles: yield* readCellTitles(null, "planned") };
        }),
      );
      expect(result.refused).toMatchObject({
        error: { code: "validation", details: { issues: [{ path: ["stage"] }] } },
      });
      expect(result.restored.stage).toBe("planned");
      expect(result.titles).toEqual(["a", "b", "finished"]);
    });

    it("refuses a move to done or dropped, which the board has no column for", async () => {
      const errors = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const task = yield* createInCell("real", "planned");
          const bad = (stage: string) => tasks.move({ id: task.id, stage: stage as "planned" });
          return [yield* Effect.flip(bad("done")), yield* Effect.flip(bad("dropped"))];
        }),
      );
      for (const error of errors) expect(error).toMatchObject({ error: { code: "validation" } });
    });
  });

  describe("the events of a move", () => {
    it("writes one task.updated that lists the stage, the status and the rank for a move to another column", async () => {
      const events = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const cell = yield* fillCell(["a", "b"], "building");
          const moved = yield* createInCell("moved", "planned");
          yield* TestClock.adjust(60_000);
          yield* tasks.move({ id: moved.id, stage: "building", afterTaskId: cell["a"]! });
          return yield* readEventsOfKind("task.updated");
        }),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.actor).toBe("user");
      const changes = (events[0]?.payload as { changes: Record<string, unknown> }).changes;
      expect(Object.keys(changes).toSorted()).toEqual(["boardRank", "stage", "status"]);
    });

    it("writes one task.updated that lists only the rank for a move inside a column", async () => {
      const events = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const cell = yield* fillCell(["a", "b", "c"], "planned");
          yield* TestClock.adjust(60_000);
          yield* tasks.move({ id: cell["c"]!, afterTaskId: null });
          return yield* readEventsOfKind("task.updated");
        }),
      );
      expect(events).toHaveLength(1);
      expect(Object.keys((events[0]?.payload as { changes: object }).changes)).toEqual([
        "boardRank",
      ]);
    });
  });

  describe("when ranks run out of room", () => {
    it("keeps 1,000 Tasks moved into one gap in order and every rank within the length limit", async () => {
      const result = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const repository = yield* taskRepository;
          const ends = yield* fillCell(["first", "last"], "planned");
          const moved: Array<string> = [];
          for (let n = 1; n <= 1000; n++) {
            const task = yield* createInCell(`n${String(n)}`, "exploring");
            moved.push(task.id);
            yield* tasks.move({ id: task.id, stage: "planned", afterTaskId: ends["first"]! });
          }
          const ranks = yield* repository.listCellRanks({ projectId: null, stage: "planned" });
          return { titles: yield* readCellTitles(null, "planned"), ranks };
        }),
      );
      // Each Task was put right after "first", so the newest comes first.
      expect(result.titles).toEqual([
        "first",
        ...Array.from({ length: 1000 }, (_, index) => `n${String(1000 - index)}`),
        "last",
      ]);
      expect(result.ranks.every((entry) => entry.boardRank.length <= MAX_BOARD_RANK_LENGTH)).toBe(
        true,
      );
      expect(new Set(result.ranks.map((entry) => entry.boardRank)).size).toBe(1002);
    }, 60_000);

    it("spreads the cell again, keeping its order, and gives only the moved Task a task.updated", async () => {
      const result = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const tasks = yield* TaskService;
          const repository = yield* taskRepository;
          const cell = yield* fillCell(["a", "b", "c"], "planned");
          const mover = yield* createInCell("mover", "exploring");
          // "a" and "b" sit next to each other at the longest rank there is, so
          // no rank fits between them.
          const longest = "z".repeat(MAX_BOARD_RANK_LENGTH - 1);
          yield* withTransaction(
            sql,
            Effect.gen(function* () {
              yield* sql`UPDATE tasks SET board_rank = ${`${longest}1`} WHERE id = ${uuidFromString(cell["a"]!)}`;
              yield* sql`UPDATE tasks SET board_rank = ${`${longest}2`} WHERE id = ${uuidFromString(cell["b"]!)}`;
              yield* sql`UPDATE tasks SET board_rank = ${`${longest}3`} WHERE id = ${uuidFromString(cell["c"]!)}`;
            }),
          );
          const ranksBefore = yield* repository.listCellRanks({
            projectId: null,
            stage: "planned",
          });
          yield* TestClock.adjust(60_000);
          yield* tasks.move({ id: mover.id, stage: "planned", afterTaskId: cell["a"]! });
          return {
            ranksBefore,
            titles: yield* readCellTitles(null, "planned"),
            ranks: yield* repository.listCellRanks({ projectId: null, stage: "planned" }),
            events: yield* readEventsOfKind("task.updated"),
            moverId: mover.id,
          };
        }),
      );
      expect(result.ranksBefore.map((entry) => entry.boardRank.length)).toEqual([64, 64, 64]);
      expect(result.titles).toEqual(["a", "mover", "b", "c"]);
      expect(result.ranks.every((entry) => entry.boardRank.length < MAX_BOARD_RANK_LENGTH)).toBe(
        true,
      );
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.payload).toMatchObject({ taskId: result.moverId });
    });
  });
});

/**
 * Tests the link between a Task and the refs it names, and the two rules built
 * on it: the active Task of a ref (the oldest live link), and taking back a
 * Task that was made for a ref and has gathered nothing since.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import type { ExternalRef } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidFromString, withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { taskRepository } from "./repository";
import { TaskService, TaskServiceLayer } from "./index";
import { TaskServicePortsLayer } from "../daemon/tasks";

const layer = TaskServiceLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(TaskServicePortsLayer),
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const run = <A, E>(effect: Effect.Effect<A, E, TaskService | SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

const A_MINUTE = 60_000;
const REF: ExternalRef = "github:issue:acme/api#7";
const OTHER_REF: ExternalRef = "github:issue:acme/api#8";
const THIRD_REF: ExternalRef = "github:issue:acme/api#9";

/** Creates a Task whose provenance carries `ref`, a minute after the last write. */
const createTaskOnRef = (title: string, ref: ExternalRef = REF) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    return yield* tasks.create({ title, description: "", provenance: [{ ref }] });
  });

const readLinks = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly ref: string;
      readonly linked_at: string;
      readonly linked_by: string;
      readonly following: number;
    }>`SELECT ref, linked_at, linked_by, following FROM task_entity_links
       WHERE task_id = ${uuidFromString(taskId)} ORDER BY ref`;
  });

describe("the link a Task's provenance writes", () => {
  it("links each ref a new Task names, stamped with the time and the actor", async () => {
    const links = await run(
      Effect.gen(function* () {
        const task = yield* createTaskOnRef("First", REF);
        return { task, links: yield* readLinks(task.id) };
      }),
    );
    expect(links.links).toEqual([
      { ref: REF, linked_at: links.task.createdAt, linked_by: "user", following: 0 },
    ]);
  });

  it("links a ref an update appends, and keeps the oldest link when the ref is named again", async () => {
    const { first, after } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTaskOnRef("First", REF);
        const first = yield* readLinks(task.id);
        yield* TestClock.adjust(A_MINUTE);
        yield* tasks.update({ id: task.id, provenance: [{ ref: OTHER_REF }, { ref: REF }] });
        return { first, after: yield* readLinks(task.id) };
      }),
    );
    expect(after.map((link) => link.ref)).toEqual([REF, OTHER_REF]);
    expect(after[0]).toEqual(first[0]);
    expect(after[1]!.linked_at > first[0]!.linked_at).toBe(true);
  });
});

describe("the active Task of a ref", () => {
  it("is the live Task with the oldest link, and an update does not change it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const repository = yield* taskRepository;
        const older = yield* createTaskOnRef("Older");
        const newer = yield* createTaskOnRef("Newer");
        yield* TestClock.adjust(A_MINUTE);
        // The newer Task is now the most recently updated one.
        yield* tasks.update({ id: newer.id, title: "Newer, renamed" });
        const active = yield* repository.findActiveTaskForRef(REF);
        return { olderId: older.id, activeId: active._tag === "Some" ? active.value.id : null };
      }),
    );
    expect(result.activeId).toBe(result.olderId);
  });

  it("skips a Task that is done, dropped or deleted, and is none when no Task is live", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const repository = yield* taskRepository;
        const first = yield* createTaskOnRef("First");
        const second = yield* createTaskOnRef("Second");
        const third = yield* createTaskOnRef("Third");
        const fourth = yield* createTaskOnRef("Fourth");
        const readActive = Effect.map(repository.findActiveTaskForRef(REF), (found) =>
          found._tag === "Some" ? found.value.title : null,
        );
        const steps = [yield* readActive];
        yield* tasks.update({ id: first.id, stage: "done" });
        steps.push(yield* readActive);
        yield* tasks.update({ id: second.id, stage: "dropped" });
        steps.push(yield* readActive);
        yield* tasks.delete(third.id);
        steps.push(yield* readActive);
        yield* tasks.update({ id: fourth.id, stage: "done" });
        steps.push(yield* readActive);
        // Reopening a finished Task makes its old link count again.
        yield* tasks.update({ id: first.id, stage: "planned" });
        steps.push(yield* readActive);
        return steps;
      }),
    );
    expect(result).toEqual(["First", "Second", "Third", "Fourth", null, "First"]);
  });

  it("answers many refs in one call, each with the same Task the single read finds", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        const tasks = yield* TaskService;
        const older = yield* createTaskOnRef("Older", REF);
        yield* createTaskOnRef("Newer", REF);
        const other = yield* createTaskOnRef("Other", OTHER_REF);
        const finished = yield* createTaskOnRef("Finished", "github:issue:acme/api#9");
        yield* tasks.update({ id: finished.id, stage: "done" });
        const rows = yield* repository.listActiveTasksForRefs([
          REF,
          OTHER_REF,
          "github:issue:acme/api#9",
          "github:issue:acme/api#10",
        ]);
        return { rows, olderId: older.id, otherId: other.id };
      }),
    );
    expect(result.rows.every((row) => row.updatedAt !== "")).toBe(true);
    expect(result.rows.map((row) => [row.ref, row.id, row.stage]).toSorted()).toEqual(
      [
        [REF, result.olderId, "planned"],
        [OTHER_REF, result.otherId, "planned"],
      ].toSorted(),
    );
  });
});

describe("taking on work for a ref", () => {
  it("creates a Task linked to the ref, and stores whether the user was only following it", async () => {
    const { task, links } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* tasks.createTaskLinkedToRef({
          ref: REF,
          title: "Review the change",
          stage: "building",
          following: true,
        });
        return { task, links: yield* readLinks(task.id) };
      }),
    );
    expect(task).toMatchObject({
      title: "Review the change",
      stage: "building",
      priority: "normal",
      provenance: [{ ref: REF }],
    });
    expect(links).toMatchObject([{ ref: REF, following: 1, linked_by: "user" }]);
  });

  it("refuses a caller who is not the user, even one who holds the grants", async () => {
    const SESSION: Actor = {
      _tag: "session",
      sessionId: "0199e0e7-0002-7000-8000-000000000000",
      grants: ["task.update", "task.create", "task.read"],
    } as unknown as Actor;
    const errors = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.createTaskLinkedToRef({
          ref: REF,
          title: "Mine",
          stage: "planned",
          following: false,
        });
        const asSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(Effect.flip(effect), CurrentActor, SESSION);
        return [
          yield* asSession(
            tasks.createTaskLinkedToRef({
              ref: REF,
              title: "x",
              stage: "planned",
              following: false,
            }),
          ),
          yield* asSession(tasks.undoCreatedTask(created.id, REF)),
        ];
      }),
    );
    expect(errors).toMatchObject([
      { error: { code: "forbidden" } },
      { error: { code: "forbidden" } },
    ]);
  });
});

describe("taking back a Task made for a ref", () => {
  const makeTask = Effect.gen(function* () {
    const tasks = yield* TaskService;
    yield* TestClock.adjust(A_MINUTE);
    return yield* tasks.createTaskLinkedToRef({
      ref: REF,
      title: "Take it",
      stage: "planned",
      following: false,
    });
  });

  const isDeleted = (id: string) =>
    Effect.gen(function* () {
      const tasks = yield* TaskService;
      return yield* Effect.match(tasks.read(id), {
        // The user holds the grant, so a failed read is the Task being gone.
        onFailure: () => true,
        onSuccess: () => false,
      });
    });

  it("deletes a Task nothing has been added to", async () => {
    const { outcome, deleted } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* makeTask;
        return {
          outcome: yield* tasks.undoCreatedTask(task.id, REF),
          deleted: yield* isDeleted(task.id),
        };
      }),
    );
    expect(outcome).toEqual({ undone: true });
    expect(deleted).toBe(true);
  });

  it("keeps a Task that has been edited", async () => {
    const { outcome, deleted } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* makeTask;
        yield* TestClock.adjust(A_MINUTE);
        yield* tasks.update({ id: task.id, priority: "high" });
        return {
          outcome: yield* tasks.undoCreatedTask(task.id, REF),
          deleted: yield* isDeleted(task.id),
        };
      }),
    );
    expect(outcome).toEqual({ undone: false, reason: "edited" });
    expect(deleted).toBe(false);
  });

  it("keeps a Task that was edited in the same millisecond it was made", async () => {
    const { outcome, deleted } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* makeTask;
        // The clock does not move, so `updatedAt` still equals `createdAt`.
        const edited = yield* tasks.update({ id: task.id, title: "Renamed" });
        expect(edited.updatedAt).toBe(task.createdAt);
        return {
          outcome: yield* tasks.undoCreatedTask(task.id, REF),
          deleted: yield* isDeleted(task.id),
        };
      }),
    );
    expect(outcome).toEqual({ undone: false, reason: "edited" });
    expect(deleted).toBe(false);
  });

  it("keeps a Task that was made at Done", async () => {
    const { outcome, deleted } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* tasks.createTaskLinkedToRef({
          ref: REF,
          title: "Already done",
          stage: "done",
          following: false,
        });
        return {
          outcome: yield* tasks.undoCreatedTask(task.id, REF),
          deleted: yield* isDeleted(task.id),
        };
      }),
    );
    expect(outcome).toEqual({ undone: false, reason: "finished" });
    expect(deleted).toBe(false);
  });

  it("keeps a Task that links a second ref", async () => {
    const { outcome, deleted } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* makeTask;
        // Written straight to the table, so the Task's `updated_at` stays untouched and
        // only the second link can be what keeps it.
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          sql`INSERT INTO task_entity_links (task_id, ref, linked_at, linked_by)
              VALUES (${uuidFromString(task.id)}, ${OTHER_REF}, ${task.createdAt}, 'user')`,
        );
        return {
          outcome: yield* tasks.undoCreatedTask(task.id, REF),
          deleted: yield* isDeleted(task.id),
        };
      }),
    );
    expect(outcome).toEqual({ undone: false, reason: "has-other-link" });
    expect(deleted).toBe(false);
  });

  it("keeps a Task that a Thread has joined", async () => {
    const { outcome, deleted } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* makeTask;
        const sql = yield* SqlClient.SqlClient;
        const runnerId = mintUuid();
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
                       VALUES (${runnerId}, 'one', 'online', 'active', 0, '[]', 'hash', ${task.createdAt}, ${task.createdAt})`;
            yield* sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id,
                                             requested_access_mode, access_mode, spec, title, status,
                                             created_at, last_activity_at, task_id)
                       VALUES (${mintUuid()}, ${mintUuid()}, ${mintUuid()}, ${runnerId}, 'default', 'default',
                               '{}', 'thread', 'idle', ${task.createdAt}, ${task.createdAt},
                               ${uuidFromString(task.id)})`;
          }),
        );
        return {
          outcome: yield* tasks.undoCreatedTask(task.id, REF),
          deleted: yield* isDeleted(task.id),
        };
      }),
    );
    expect(outcome).toEqual({ undone: false, reason: "has-thread" });
    expect(deleted).toBe(false);
  });

  it("keeps a Task that a run works on", async () => {
    const { outcome, deleted } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* makeTask;
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at, task_id)
              VALUES (${mintUuid()}, '{}', '{}', '{"kind":"manual","actor":"user"}', 'pending',
                      ${task.createdAt}, ${uuidFromString(task.id)})`,
        );
        return {
          outcome: yield* tasks.undoCreatedTask(task.id, REF),
          deleted: yield* isDeleted(task.id),
        };
      }),
    );
    expect(outcome).toEqual({ undone: false, reason: "has-run" });
    expect(deleted).toBe(false);
  });

  it("reports a Task that is already gone, and one that never existed", async () => {
    const outcomes = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* makeTask;
        yield* tasks.delete(task.id);
        return [
          yield* tasks.undoCreatedTask(task.id, REF),
          yield* tasks.undoCreatedTask("0199e0e7-9999-7000-8000-000000000000", REF),
        ];
      }),
    );
    expect(outcomes).toEqual([
      { undone: false, reason: "task-gone" },
      { undone: false, reason: "task-gone" },
    ]);
  });
});

describe("merging Tasks that link refs", () => {
  const SIGNAL_ID = "0199e0e7-0003-7000-8000-000000000000";
  const RUN_ID = "0199e0e7-0004-7000-8000-000000000000";

  /** Makes the links of `taskId` to `ref` older or newer, and following or not, as a test needs. */
  const setLink = (
    taskId: string,
    ref: ExternalRef,
    link: { readonly linkedAt: string; readonly following: boolean },
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* withTransaction(
        sql,
        sql`UPDATE task_entity_links
            SET linked_at = ${link.linkedAt}, linked_by = ${"by " + link.linkedAt},
                following = ${link.following ? 1 : 0}
            WHERE task_id = ${uuidFromString(taskId)} AND ref = ${ref}`,
      );
    });

  it("keeps one link for a ref both Tasks link: the older time, and following if either was", async () => {
    const { links, sourceLinks } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const survivor = yield* createTaskOnRef("Survivor", REF);
        const source = yield* createTaskOnRef("Source", REF);
        yield* setLink(survivor.id, REF, {
          linkedAt: "2026-02-01T00:00:00.000Z",
          following: false,
        });
        yield* setLink(source.id, REF, { linkedAt: "2026-01-01T00:00:00.000Z", following: true });
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        return { links: yield* readLinks(survivor.id), sourceLinks: yield* readLinks(source.id) };
      }),
    );
    expect(links).toEqual([
      {
        ref: REF,
        linked_at: "2026-01-01T00:00:00.000Z",
        linked_by: "by 2026-01-01T00:00:00.000Z",
        following: 1,
      },
    ]);
    expect(sourceLinks).toEqual([]);
  });

  it("keeps the survivor's own link when it is the older one", async () => {
    const links = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const survivor = yield* createTaskOnRef("Survivor", REF);
        const source = yield* createTaskOnRef("Source", REF);
        yield* setLink(survivor.id, REF, {
          linkedAt: "2026-01-01T00:00:00.000Z",
          following: false,
        });
        yield* setLink(source.id, REF, { linkedAt: "2026-02-01T00:00:00.000Z", following: false });
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        return yield* readLinks(survivor.id);
      }),
    );
    expect(links).toEqual([
      {
        ref: REF,
        linked_at: "2026-01-01T00:00:00.000Z",
        linked_by: "by 2026-01-01T00:00:00.000Z",
        following: 0,
      },
    ]);
  });

  it("moves the links of the merged Task that the survivor lacks, and the survivor becomes the active Task", async () => {
    const { links, active, otherActive } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const repository = yield* taskRepository;
        const survivor = yield* createTaskOnRef("Survivor", REF);
        const source = yield* createTaskOnRef("Source", OTHER_REF);
        yield* tasks.update({ id: source.id, provenance: [{ ref: REF }] });
        yield* setLink(source.id, REF, { linkedAt: "2020-01-01T00:00:00.000Z", following: false });
        const before = yield* repository.findActiveTaskForRef(REF);
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        return {
          before,
          links: (yield* readLinks(survivor.id)).map((link) => link.ref),
          active: yield* repository.findActiveTaskForRef(REF),
          otherActive: yield* repository.findActiveTaskForRef(OTHER_REF),
        };
      }),
    );
    expect(links).toEqual([REF, OTHER_REF]);
    expect(active._tag === "Some" && active.value.title).toBe("Survivor");
    expect(otherActive._tag === "Some" && otherActive.value.title).toBe("Survivor");
  });

  it("lands a link written for the merged id on the survivor, by update and by handoff", async () => {
    const { survivorLinks, sourceLinks } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const survivor = yield* createTaskOnRef("Survivor", REF);
        const source = yield* createTaskOnRef("Source", REF);
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        yield* tasks.update({ id: source.id, provenance: [{ ref: OTHER_REF }] });
        yield* tasks.recordHandoff({
          taskId: source.id,
          entry: { signalId: SIGNAL_ID, runId: RUN_ID, ref: THIRD_REF },
        });
        return {
          survivorLinks: (yield* readLinks(survivor.id)).map((link) => link.ref),
          sourceLinks: yield* readLinks(source.id),
        };
      }),
    );
    expect(survivorLinks).toEqual([REF, OTHER_REF, THIRD_REF]);
    expect(sourceLinks).toEqual([]);
  });

  it("refuses to take back a merged Task, and leaves the survivor and its links", async () => {
    const { outcome, survivorLinks } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const survivor = yield* createTaskOnRef("Survivor", OTHER_REF);
        const source = yield* createTaskOnRef("Source", REF);
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        return {
          outcome: yield* tasks.undoCreatedTask(source.id, REF),
          survivorLinks: (yield* readLinks(survivor.id)).map((link) => link.ref),
        };
      }),
    );
    expect(outcome).toEqual({ undone: false, reason: "task-merged" });
    expect(survivorLinks).toEqual([REF, OTHER_REF]);
  });
});

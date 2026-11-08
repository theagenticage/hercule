import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { INITIATIVE_HUES } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import {
  AfterCommit,
  mintUuid,
  uuidFromString,
  uuidToString,
  withTransaction,
  type Change,
} from "../db";
import { TaskService } from "../tasks";
import { TaskTestLayer } from "../tasks/testing";
import { InitiativeService, InitiativeServiceLayer } from "./index";

type Deps = InitiativeService | TaskService | SqlClient.SqlClient;

const layer = InitiativeServiceLayer.pipe(Layer.provideMerge(TaskTestLayer));

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** A session that holds every grant the Initiative operations name. */
const SESSION: Actor = {
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  profileId: "0199e0e7-0003-7000-8000-000000000000",
  grants: ["task.read", "task.update"],
  profileGrants: ["task.read", "task.update"],
  assistantId: null,
  agentId: null,
};

const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const A_MINUTE = 60_000;

/**
 * Runs an effect as `actor` (the user unless said otherwise) on a fresh
 * database, and returns the result with every change the committed
 * transactions announced.
 */
const runAs = <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>) => {
  const announced: Array<Change> = [];
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, actor),
      Effect.provide(
        Layer.mergeAll(
          layer,
          Layer.succeed(AfterCommit)({
            publish: (changes) =>
              Effect.sync(() => {
                announced.push(...changes);
              }),
          }),
        ),
      ),
      Effect.provide(TestClock.layer()),
      Effect.map((result) => ({ result, announced })),
    ),
  );
};

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  runAs(USER, effect).then(({ result }) => result);

/** Runs a call that is expected to fail, and returns its error. */
const runError = <A, E>(effect: Effect.Effect<A, E, Deps>, actor: Actor = USER) =>
  runAs(actor, Effect.flip(effect)).then(({ result }) => result);

/** The announcements about Initiatives, as `kind:id`. */
const initiativeAnnouncements = (announced: ReadonlyArray<Change>) =>
  announced.flatMap((change) =>
    change._tag === "record" && change.topic === "initiative"
      ? [`${change.kind}:${change.id}`]
      : [],
  );

/** Writes a project and returns its id. */
const insertProject = (name: string, deletedAt: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintUuid();
    yield* withTransaction(
      sql,
      sql`INSERT INTO projects (id, name, created_at, updated_at, deleted_at)
          VALUES (${id}, ${name}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${deletedAt})`,
    );
    return uuidToString(id);
  });

/** Creates a Task at Planned, on the Initiative if one is given. */
const createTask = (title: string, initiativeId?: string) =>
  Effect.flatMap(TaskService, (tasks) =>
    tasks.create({
      title,
      description: "",
      stage: "planned",
      ...(initiativeId === undefined ? {} : { initiativeId }),
    }),
  );

const readStamps = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ created_by: string; updated_by: string; deleted_at: string | null }>`
      SELECT created_by, updated_by, deleted_at FROM initiatives WHERE id = ${uuidFromString(id)}
    `;
    return rows[0];
  });

describe("initiative.create", () => {
  it("makes an open Initiative stamped with the user, and announces it", async () => {
    const { result, announced } = await runAs(
      USER,
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const created = yield* initiatives.create({
          name: "Gift card refunds",
          target: "Live by the spring sale",
          targetDate: "2026-03-20T00:00:00.000Z",
        });
        return {
          created,
          read: yield* initiatives.read(created.id),
          stamps: yield* readStamps(created.id),
        };
      }),
    );
    expect(result.created).toMatchObject({
      name: "Gift card refunds",
      intent: "",
      target: "Live by the spring sale",
      targetDate: "2026-03-20T00:00:00.000Z",
      hue: INITIATIVE_HUES[0],
    });
    expect(result.created.closedAt).toBeUndefined();
    expect(result.created.createdAt).toBe(result.created.updatedAt);
    expect(result.read).toEqual(result.created);
    expect(result.stamps).toMatchObject({ created_by: "user", updated_by: "user" });
    expect(initiativeAnnouncements(announced)).toEqual([`created:${result.created.id}`]);
  });

  it("puts the Initiative in a project's lane, and refuses a project that does not exist or is deleted", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const live = yield* insertProject("Northwind web");
        const deleted = yield* insertProject("Old", "2026-02-01T00:00:00.000Z");
        return {
          created: yield* initiatives.create({ name: "In a lane", projectId: live }),
          live,
          unknown: yield* Effect.flip(
            initiatives.create({ name: "Nowhere", projectId: UNKNOWN_ID }),
          ),
          deleted: yield* Effect.flip(initiatives.create({ name: "Gone", projectId: deleted })),
        };
      }),
    );
    expect(outcome.created.projectId).toBe(outcome.live);
    expect(outcome.unknown).toMatchObject({ error: { code: "not_found" } });
    expect(outcome.deleted).toMatchObject({ error: { code: "not_found" } });
  });

  it("takes the hues in list order, and again from the start once each is used once", async () => {
    const hues = await run(
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const made: Array<number> = [];
        for (let n = 0; n <= INITIATIVE_HUES.length; n++) {
          made.push((yield* initiatives.create({ name: `Initiative ${n}` })).hue);
        }
        return made;
      }),
    );
    expect(hues).toEqual([...INITIATIVE_HUES, INITIATIVE_HUES[0]]);
  });

  it("gives a hue back when its Initiative is closed or deleted, and honours a hue that was asked for", async () => {
    const hues = await run(
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const first = yield* initiatives.create({ name: "First" });
        const second = yield* initiatives.create({ name: "Second" });
        yield* initiatives.create({ name: "Third" });
        yield* initiatives.close(first.id);
        const reusedAfterClose = (yield* initiatives.create({ name: "Fourth" })).hue;
        yield* initiatives.delete(second.id);
        const reusedAfterDelete = (yield* initiatives.create({ name: "Fifth" })).hue;
        const asked = (yield* initiatives.create({ name: "Sixth", hue: INITIATIVE_HUES[5] })).hue;
        return { reusedAfterClose, reusedAfterDelete, asked };
      }),
    );
    expect(hues).toEqual({
      reusedAfterClose: INITIATIVE_HUES[0],
      reusedAfterDelete: INITIATIVE_HUES[1],
      asked: INITIATIVE_HUES[5],
    });
  });
});

describe("initiative.update", () => {
  it("changes the given fields, stamps and announces the change, and leaves the others alone", async () => {
    const { result, announced } = await runAs(
      USER,
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const project = yield* insertProject("Northwind web");
        const created = yield* initiatives.create({ name: "Refunds", intent: "Pay people back" });
        yield* TestClock.adjust(A_MINUTE);
        const updated = yield* initiatives.update(created.id, {
          name: "Gift card refunds",
          target: "Live by the spring sale",
          projectId: project,
          hue: INITIATIVE_HUES[3],
        });
        return { created, updated, project, stamps: yield* readStamps(created.id) };
      }),
    );
    expect(result.updated).toMatchObject({
      id: result.created.id,
      name: "Gift card refunds",
      intent: "Pay people back",
      target: "Live by the spring sale",
      projectId: result.project,
      hue: INITIATIVE_HUES[3],
      createdAt: result.created.createdAt,
    });
    expect(result.updated.updatedAt > result.created.updatedAt).toBe(true);
    expect(result.stamps).toMatchObject({ created_by: "user", updated_by: "user" });
    expect(initiativeAnnouncements(announced)).toEqual([
      `created:${result.created.id}`,
      `updated:${result.created.id}`,
    ]);
  });

  it("clears the target, the target date and the project with null", async () => {
    const cleared = await run(
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const project = yield* insertProject("Northwind web");
        const created = yield* initiatives.create({
          name: "Refunds",
          target: "Spring sale",
          targetDate: "2026-03-20T00:00:00.000Z",
          projectId: project,
        });
        return yield* initiatives.update(created.id, {
          target: null,
          targetDate: null,
          projectId: null,
        });
      }),
    );
    expect(cleared.target).toBeUndefined();
    expect(cleared.targetDate).toBeUndefined();
    expect(cleared.projectId).toBeUndefined();
  });

  it("writes and announces nothing when the update repeats the current values", async () => {
    const { result, announced } = await runAs(
      USER,
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const created = yield* initiatives.create({ name: "Refunds", target: "Spring sale" });
        yield* TestClock.adjust(A_MINUTE);
        const again = yield* initiatives.update(created.id, {
          name: "Refunds",
          target: "Spring sale",
          targetDate: null,
        });
        return { created, again };
      }),
    );
    expect(result.again).toEqual(result.created);
    expect(initiativeAnnouncements(announced)).toEqual([`created:${result.created.id}`]);
  });

  it("fails with not_found for a project that does not exist, and for an Initiative that does not exist", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const created = yield* initiatives.create({ name: "Refunds" });
        return {
          project: yield* Effect.flip(initiatives.update(created.id, { projectId: UNKNOWN_ID })),
          initiative: yield* Effect.flip(initiatives.update(UNKNOWN_ID, { name: "Nope" })),
        };
      }),
    );
    expect(errors.project).toMatchObject({ error: { code: "not_found" } });
    expect(errors.initiative).toMatchObject({ error: { code: "not_found" } });
  });

  it("refuses an update that names no field", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const created = yield* initiatives.create({ name: "Refunds" });
        return yield* initiatives.update(created.id, {});
      }),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });
});

describe("initiative.close and initiative.reopen", () => {
  it("closes and reopens, stamping and announcing each change once, however often it is asked", async () => {
    const { result, announced } = await runAs(
      USER,
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const created = yield* initiatives.create({ name: "Refunds" });
        yield* TestClock.adjust(A_MINUTE);
        const closed = yield* initiatives.close(created.id);
        yield* TestClock.adjust(A_MINUTE);
        const closedAgain = yield* initiatives.close(created.id);
        const reopened = yield* initiatives.reopen(created.id);
        yield* TestClock.adjust(A_MINUTE);
        const reopenedAgain = yield* initiatives.reopen(created.id);
        return { created, closed, closedAgain, reopened, reopenedAgain };
      }),
    );
    expect(result.closed.closedAt).toBeDefined();
    expect(result.closedAgain).toEqual(result.closed);
    expect(result.reopened.closedAt).toBeUndefined();
    expect(result.reopenedAgain).toEqual(result.reopened);
    expect(initiativeAnnouncements(announced)).toEqual([
      `created:${result.created.id}`,
      `updated:${result.created.id}`,
      `updated:${result.created.id}`,
    ]);
  });

  it("fails with not_found for an Initiative that does not exist", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        return [
          yield* Effect.flip(initiatives.close(UNKNOWN_ID)),
          yield* Effect.flip(initiatives.reopen(UNKNOWN_ID)),
        ];
      }),
    );
    expect(errors).toMatchObject([
      { error: { code: "not_found" } },
      { error: { code: "not_found" } },
    ]);
  });
});

describe("initiative.delete", () => {
  it("hides the Initiative from every read, keeps the row, and announces it", async () => {
    const { result, announced } = await runAs(
      USER,
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const created = yield* initiatives.create({ name: "Refunds" });
        const kept = yield* initiatives.create({ name: "Kept" });
        const outcome = yield* initiatives.delete(created.id);
        return {
          created,
          outcome,
          read: yield* Effect.flip(initiatives.read(created.id)),
          deletedAgain: yield* Effect.flip(initiatives.delete(created.id)),
          closed: yield* Effect.flip(initiatives.close(created.id)),
          open: (yield* initiatives.query({})).items.map((item) => item.id),
          kept,
          stamps: yield* readStamps(created.id),
        };
      }),
    );
    expect(result.outcome).toEqual({});
    expect(result.read).toMatchObject({ error: { code: "not_found" } });
    expect(result.deletedAgain).toMatchObject({ error: { code: "not_found" } });
    expect(result.closed).toMatchObject({ error: { code: "not_found" } });
    expect(result.open).toEqual([result.kept.id]);
    expect(result.stamps?.deleted_at).not.toBeNull();
    expect(result.stamps?.updated_by).toBe("user");
    expect(initiativeAnnouncements(announced)).toContain(`deleted:${result.created.id}`);
  });
});

describe("initiative.delete and the Tasks on the Initiative", () => {
  it("takes the Initiative off each of its Tasks, announces each Task, and leaves other Tasks alone", async () => {
    const { result, announced } = await runAs(
      USER,
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const sql = yield* SqlClient.SqlClient;
        const doomed = yield* initiatives.create({ name: "Refunds" });
        const other = yield* initiatives.create({ name: "Other" });
        const onDoomed = [
          yield* createTask("Add a refund button", doomed.id),
          yield* createTask("Ship refund emails", doomed.id),
        ];
        const onOther = yield* createTask("Unrelated", other.id);
        const loose = yield* createTask("Loose");
        yield* initiatives.delete(doomed.id);
        const rows = yield* sql<{ id: Uint8Array; initiative_id: Uint8Array | null }>`
          SELECT id, initiative_id FROM tasks
        `;
        const initiativeOf = (taskId: string) =>
          rows.find((row) => uuidToString(row.id) === taskId)?.initiative_id ?? null;
        return {
          clearedIds: onDoomed.map((task) => task.id),
          stillOnDoomed: onDoomed.map((task) => initiativeOf(task.id)),
          onOther: initiativeOf(onOther.id),
          other,
          loose: initiativeOf(loose.id),
          untouchedIds: [onOther.id, loose.id],
        };
      }),
    );
    expect(result.stillOnDoomed).toEqual([null, null]);
    expect(result.onOther).not.toBeNull();
    expect(uuidToString(result.onOther!)).toBe(result.other.id);
    expect(result.loose).toBeNull();

    const taskUpdates = announced.flatMap((change) =>
      change._tag === "record" && change.topic === "task" && change.kind === "updated"
        ? [change.id]
        : [],
    );
    expect(taskUpdates.sort()).toEqual([...result.clearedIds].sort());
  });

  it("changes nothing when the delete fails because the Initiative is already gone", async () => {
    const { result, announced } = await runAs(
      USER,
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const initiative = yield* initiatives.create({ name: "Refunds" });
        yield* createTask("Add a refund button", initiative.id);
        yield* initiatives.delete(initiative.id);
        return yield* Effect.flip(initiatives.delete(initiative.id));
      }),
    );
    expect(result).toMatchObject({ error: { code: "not_found" } });
    // One Task was cleared by the first delete, and the second announced no Task.
    expect(
      announced.filter(
        (change) =>
          change._tag === "record" && change.topic === "task" && change.kind === "updated",
      ),
    ).toHaveLength(1);
  });
});

describe("initiative.query", () => {
  it("lists the open Initiatives in creation order, and the closed ones when asked", async () => {
    const lists = await run(
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const ids: Array<string> = [];
        for (const name of ["A", "B", "C", "D"]) {
          ids.push((yield* initiatives.create({ name })).id);
          yield* TestClock.adjust(A_MINUTE);
        }
        const [a, b, c, d] = ids;
        yield* initiatives.close(b!);
        yield* initiatives.close(d!);
        const names = (closed: boolean | undefined) =>
          initiatives
            .query(closed === undefined ? {} : { closed })
            .pipe(Effect.map((page) => page.items.map((item) => item.name)));
        return {
          ids: { a, b, c, d },
          byDefault: yield* names(undefined),
          open: yield* names(false),
          closed: yield* names(true),
        };
      }),
    );
    expect(lists.byDefault).toEqual(["A", "C"]);
    expect(lists.open).toEqual(["A", "C"]);
    expect(lists.closed).toEqual(["B", "D"]);
  });

  it("lists only the Initiatives of one project's lane, and pages with a cursor", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const project = yield* insertProject("Northwind web");
        for (const name of ["One", "Two", "Three"]) {
          yield* initiatives.create({ name, projectId: project });
          yield* TestClock.adjust(A_MINUTE);
        }
        yield* initiatives.create({ name: "Loose" });
        const first = yield* initiatives.query({ projectId: project, limit: 2 });
        const second = yield* initiatives.query({
          projectId: project,
          limit: 2,
          ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
        });
        return { first, second };
      }),
    );
    expect(outcome.first.items.map((item) => item.name)).toEqual(["One", "Two"]);
    expect(outcome.first.nextCursor).toBeDefined();
    expect(outcome.second.items.map((item) => item.name)).toEqual(["Three"]);
    expect(outcome.second.nextCursor).toBeUndefined();
  });
});

describe("a session", () => {
  it("reads, but is refused every mutation whatever grants it holds, and the refusal says only the user does it", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const initiatives = yield* InitiativeService;
        const created = yield* initiatives.create({ name: "Refunds" });
        const asSession = <A, E>(effect: Effect.Effect<A, E, never>) =>
          Effect.flip(effect.pipe(Effect.provideService(CurrentActor, SESSION)));
        return {
          created,
          errors: [
            yield* asSession(initiatives.create({ name: "Mine" })),
            yield* asSession(initiatives.update(created.id, { name: "Mine" })),
            yield* asSession(initiatives.close(created.id)),
            yield* asSession(initiatives.reopen(created.id)),
            yield* asSession(initiatives.delete(created.id)),
          ],
          read: yield* initiatives
            .read(created.id)
            .pipe(Effect.provideService(CurrentActor, SESSION)),
          after: yield* initiatives.read(created.id),
        };
      }),
    );
    for (const error of outcome.errors) {
      expect(error).toMatchObject({
        error: {
          code: "forbidden",
          message: expect.stringContaining(
            "Only the user creates and changes initiatives",
          ) as unknown,
        },
      });
    }
    expect(outcome.read).toEqual(outcome.created);
    expect(outcome.after).toEqual(outcome.created);
  });

  it("is refused before it can learn whether the Initiative exists", async () => {
    const error = await runError(
      Effect.flatMap(InitiativeService, (initiatives) => initiatives.delete(UNKNOWN_ID)),
      SESSION,
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });
});

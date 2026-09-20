import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MAX_PROJECT_NAME_LENGTH } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { uuidFromString, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer, type AuditKind } from "../events";
import { TaskService, TaskServiceLayer } from "../tasks";
import { ProjectService, ProjectServiceLayer, type ProjectPage, type QueryInput } from "./index";

type Deps = ProjectService | TaskService | AuditLog | SqlClient.SqlClient;

const layer = ProjectServiceLayer.pipe(
  Layer.provideMerge(TaskServiceLayer),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/**
 * Every test runs on a `TestClock`, so a test that needs a later `updatedAt`
 * moves time rather than racing the millisecond the first write landed in.
 */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

/** Runs a call that is expected to fail, and hands the test its error. */
const runError = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.flip,
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

/**
 * Input a caller can put on the wire but the types here rule out. Refusing it
 * is the service's job, so the test has to be able to hand it over.
 */
const malformed = <T>(input: unknown): T => input as T;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

/** A minute, so two writes never land on the same instant by accident. */
const A_MINUTE = 60_000;

/**
 * The three `project.*` kinds this slice adds to the log. They are read back
 * through the audit writer, which types its kinds as the list this build
 * emits; the cast is what lets the test name them before that list grows.
 */
const CREATED = "project.created" as AuditKind;
const UPDATED = "project.updated" as AuditKind;
const DELETED = "project.deleted" as AuditKind;

/**
 * The project an event row carries, whatever key the payload files it under.
 * The criterion pins that the row carries the snapshot, not how it spells it.
 */
const snapshotOf = (payload: Readonly<Record<string, unknown>>, id: string) =>
  Object.values(payload).find(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && (value as { id?: unknown }).id === id,
  );

interface Diff {
  readonly old: unknown;
  readonly new: unknown;
}

/** Every per-field `{old, new}` an update's payload holds, at any depth. */
const diffsIn = (value: unknown, found: Array<Diff> = []): Array<Diff> => {
  if (typeof value !== "object" || value === null) return found;
  const record = value as Record<string, unknown>;
  if ("old" in record && "new" in record) found.push({ old: record["old"], new: record["new"] });
  for (const child of Object.values(record)) diffsIn(child, found);
  return found;
};

/** The stored row, read past the service: a soft delete leaves it behind. */
interface ProjectRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly deleted_at: string | null;
}

const names = (projects: ReadonlyArray<{ readonly name: string }>) =>
  projects.map((project) => project.name).sort();

describe("project.create", () => {
  it("stamps one instant on both timestamps and a canonical id", async () => {
    const project = await run(
      Effect.flatMap(ProjectService, (projects) =>
        projects.create({ name: "Hercule", description: "The orchestration platform" }),
      ),
    );
    expect(project).toMatchObject({ name: "Hercule", description: "The orchestration platform" });
    expect(project.id).toMatch(UUID_V7);
    expect(project.createdAt).toMatch(TIMESTAMP);
    expect(project.createdAt).toBe(project.updatedAt);
    expect(project.deletedAt).toBeUndefined();
  });

  it("takes a project with a name and nothing else", async () => {
    const project = await run(
      Effect.flatMap(ProjectService, (projects) => projects.create({ name: "Bare" })),
    );
    expect(project.name).toBe("Bare");
    expect(project.id).toMatch(UUID_V7);
    expect(project.createdAt).toBe(project.updatedAt);
  });

  it("refuses a name that is empty, over the cap, or missing", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        return [
          yield* Effect.flip(projects.create({ name: "" })),
          yield* Effect.flip(projects.create({ name: "x".repeat(MAX_PROJECT_NAME_LENGTH + 1) })),
          yield* Effect.flip(projects.create(malformed({ description: "no name" }))),
        ];
      }),
    );
    for (const error of errors) expect(error).toMatchObject({ error: { code: "validation" } });
  });
});

describe("project.update", () => {
  it("changes the field and moves updatedAt, leaving createdAt where it was", async () => {
    const { before, after } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const before = yield* projects.create({ name: "Old name", description: "d" });
        yield* TestClock.adjust(A_MINUTE);
        return { before, after: yield* projects.update({ id: before.id, name: "New name" }) };
      }),
    );
    expect(after.name).toBe("New name");
    expect(after.description).toBe("d");
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt > before.updatedAt).toBe(true);
  });

  it("answers not_found for an id nobody has", async () => {
    const error = await runError(
      Effect.flatMap(ProjectService, (projects) =>
        projects.update({ id: UNKNOWN_ID, name: "Renamed" }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("project.delete", () => {
  it("hides the project from read and query, and leaves the row behind with deletedAt set", async () => {
    const { readError, listed, rows } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projects = yield* ProjectService;
        const gone = yield* projects.create({ name: "Retired" });
        yield* projects.create({ name: "Still here" });
        yield* TestClock.adjust(A_MINUTE);
        yield* projects.delete({ id: gone.id });
        return {
          readError: yield* Effect.flip(projects.read({ id: gone.id })),
          listed: (yield* projects.query({})).items,
          rows: yield* sql<ProjectRow>`SELECT id, name, deleted_at FROM projects
                                       WHERE id = ${uuidFromString(gone.id)}`,
        };
      }),
    );
    expect(readError).toMatchObject({ error: { code: "not_found" } });
    expect(names(listed)).toEqual(["Still here"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Retired");
    expect(rows[0]?.deleted_at).toMatch(TIMESTAMP);
  });

  it("answers not_found the second time", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const created = yield* projects.create({ name: "Delete me" });
        yield* projects.delete({ id: created.id });
        return yield* projects.delete({ id: created.id });
      }),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("projects and resources", () => {
  it("leaves a task's projectId set when the project it names is deleted", async () => {
    const { project, task, rows } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projects = yield* ProjectService;
        const tasks = yield* TaskService;
        const project = yield* projects.create({ name: "Hercule" });
        const task = yield* tasks.create({
          title: "In a project that goes away",
          description: "d",
          projectId: project.id,
        });
        yield* TestClock.adjust(A_MINUTE);
        yield* projects.delete({ id: project.id });
        return {
          project,
          task,
          rows: yield* sql<{ readonly project_id: Uint8Array | null }>`
            SELECT project_id FROM tasks WHERE id = ${uuidFromString(task.id)}`,
        };
      }),
    );
    expect(task.projectId).toBe(project.id);
    expect(rows).toHaveLength(1);
    const stored = rows[0]?.project_id;
    expect(stored === null || stored === undefined).toBe(false);
    expect(uuidToString(stored as Uint8Array)).toBe(project.id);
  });
});

describe("the event log", () => {
  it("writes one project.created carrying the snapshot, stamped with the caller", async () => {
    const { project, entries } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const audit = yield* AuditLog;
        const project = yield* projects.create({ name: "Hercule", description: "d" });
        return { project, entries: yield* audit.listByKind(CREATED) };
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    expect(snapshotOf(entries[0]?.payload ?? {}, project.id)).toMatchObject({
      id: project.id,
      name: "Hercule",
      description: "d",
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  });

  it("writes one project.updated carrying a diff for the field that changed and no other", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const audit = yield* AuditLog;
        const created = yield* projects.create({
          name: "Old name",
          description: "untouched description",
        });
        yield* TestClock.adjust(A_MINUTE);
        yield* projects.update({ id: created.id, name: "New name" });
        return yield* audit.listByKind(UPDATED);
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    expect(diffsIn(entries[0]?.payload)).toEqual([{ old: "Old name", new: "New name" }]);
    expect(JSON.stringify(entries[0]?.payload)).not.toContain("untouched description");
  });

  it("writes one project.deleted carrying the final snapshot", async () => {
    const { project, entries } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const audit = yield* AuditLog;
        const project = yield* projects.create({ name: "Gone" });
        yield* TestClock.adjust(A_MINUTE);
        yield* projects.delete({ id: project.id });
        return { project, entries: yield* audit.listByKind(DELETED) };
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    const snapshot = snapshotOf(entries[0]?.payload ?? {}, project.id);
    expect(snapshot).toMatchObject({ id: project.id, name: "Gone" });
    expect(snapshot?.["deletedAt"]).toMatch(TIMESTAMP);
  });

  it("writes nothing when the mutation fails", async () => {
    const { created, updated, deleted } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const audit = yield* AuditLog;
        yield* Effect.ignore(projects.create({ name: "" }));
        yield* Effect.ignore(projects.update({ id: UNKNOWN_ID, name: "Renamed" }));
        yield* Effect.ignore(projects.delete({ id: UNKNOWN_ID }));
        return {
          created: yield* audit.listByKind(CREATED),
          updated: yield* audit.listByKind(UPDATED),
          deleted: yield* audit.listByKind(DELETED),
        };
      }),
    );
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
  });
});

describe("project.query", () => {
  /** Walks a listing to its end, a page at a time, and returns every name. */
  const walk = (input: QueryInput, limit: number) =>
    Effect.gen(function* () {
      const projects = yield* ProjectService;
      const seen: Array<string> = [];
      let cursor: string | undefined = undefined;
      for (;;) {
        const page: ProjectPage = yield* projects.query({
          ...input,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((project) => project.name));
        if (page.nextCursor === undefined) return seen;
        cursor = page.nextCursor;
      }
    });

  const five = Effect.gen(function* () {
    const projects = yield* ProjectService;
    for (const name of ["Docs", "Hercule", "Atlas", "Runner", "Web"]) {
      yield* projects.create({ name });
      yield* TestClock.adjust(A_MINUTE);
    }
  });

  it("lists alphabetically without a sort, and by the field a sort names", async () => {
    const { byDefault, byCreated } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        yield* five;
        return {
          byDefault: (yield* projects.query({})).items.map((project) => project.name),
          byCreated: (yield* projects.query({ sort: { field: "createdAt" } })).items.map(
            (project) => project.name,
          ),
        };
      }),
    );
    expect(byDefault).toEqual(["Atlas", "Docs", "Hercule", "Runner", "Web"]);
    expect(byCreated).toEqual(["Docs", "Hercule", "Atlas", "Runner", "Web"]);
  });

  it("hands every row back exactly once, whatever the page size and order", async () => {
    const walks = await run(
      Effect.gen(function* () {
        yield* five;
        return {
          nameAscending: yield* walk({}, 2),
          nameDescending: yield* walk({ sort: { field: "name", direction: "desc" } }, 2),
          updatedDescending: yield* walk({ sort: { field: "updatedAt", direction: "desc" } }, 1),
        };
      }),
    );
    const all = ["Atlas", "Docs", "Hercule", "Runner", "Web"];
    expect(walks.nameAscending).toEqual(all);
    expect(walks.nameDescending).toEqual([...all].reverse());
    expect(walks.updatedDescending.sort()).toEqual(all);
  });

  it("refuses an unknown sort field, and a cursor from another walk", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        yield* five;
        const page = yield* projects.query({ limit: 2, sort: { field: "name" } });
        const cursor = page.nextCursor ?? "";
        return [
          yield* Effect.flip(projects.query(malformed({ sort: { field: "size" } }))),
          yield* Effect.flip(
            projects.query({ cursor, sort: { field: "name", direction: "desc" } }),
          ),
          yield* Effect.flip(projects.query({ cursor, sort: { field: "createdAt" } })),
          yield* Effect.flip(projects.query({ cursor: `${cursor}x` })),
        ];
      }),
    );
    for (const error of errors) expect(error).toMatchObject({ error: { code: "validation" } });
  });
});

describe("what an update leaves alone", () => {
  it("refuses a patch that names no field, and writes nothing for one that changes nothing", async () => {
    const { empty, before, after, entries } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const audit = yield* AuditLog;
        const before = yield* projects.create({ name: "Hercule", description: "d" });
        yield* TestClock.adjust(A_MINUTE);
        return {
          empty: yield* Effect.flip(projects.update({ id: before.id })),
          before,
          after: yield* projects.update({ id: before.id, name: "Hercule", description: "d" }),
          entries: yield* audit.listByKind(UPDATED),
        };
      }),
    );
    expect(empty).toMatchObject({ error: { code: "validation" } });
    expect(after).toEqual(before);
    expect(entries).toEqual([]);
  });

  it("takes the description off again when an update sets it to null", async () => {
    const { cleared, entries } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const audit = yield* AuditLog;
        const created = yield* projects.create({ name: "Hercule", description: "d" });
        yield* TestClock.adjust(A_MINUTE);
        return {
          cleared: yield* projects.update({ id: created.id, description: null }),
          entries: yield* audit.listByKind(UPDATED),
        };
      }),
    );
    expect(cleared.description).toBeUndefined();
    expect(diffsIn(entries[0]?.payload)).toEqual([{ old: "d", new: null }]);
  });
});

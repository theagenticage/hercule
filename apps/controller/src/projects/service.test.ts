import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MAX_PROJECT_NAME_LENGTH } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { uuidFromString, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { NotificationServiceTestLayer } from "../notifications/testing";
import { readEventsOfKind } from "../events/testing";
import { TaskService, TaskServiceLayer } from "../tasks";
import { ProjectService, ProjectServiceLayer, type ProjectPage, type QueryInput } from "./index";

type Deps = ProjectService | TaskService | SqlClient.SqlClient;

const layer = ProjectServiceLayer.pipe(
  Layer.provideMerge(TaskServiceLayer),
  Layer.provideMerge(NotificationServiceTestLayer),
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/**
 * Runs an effect as the test user. Every test runs on a `TestClock`, so a test
 * that needs a later `updatedAt` moves the clock forward instead of depending
 * on real time passing between two writes.
 */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

/** Runs a call that is expected to fail, and returns its error. */
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
 * Casts input that a caller can send over the API but the types here rule out.
 * Rejecting such input is the service's job, so the test must be able to pass
 * it in.
 */
const castMalformedInput = <T>(input: unknown): T => input as T;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

/** One minute, so two writes never get the same timestamp by accident. */
const A_MINUTE = 60_000;

/** The three `project.*` audit kinds these tests read back. */
const CREATED = "project.created";
const UPDATED = "project.updated";
const DELETED = "project.deleted";

/**
 * Returns the project snapshot in an event payload, under whatever key it is
 * stored. The tests check that the event holds the snapshot, not which key
 * holds it.
 */
const findSnapshot = (payload: Readonly<Record<string, unknown>>, id: string) =>
  Object.values(payload).find(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && (value as { id?: unknown }).id === id,
  );

interface Diff {
  readonly old: unknown;
  readonly new: unknown;
}

/** Returns every `{old, new}` pair in an update event's payload, at any depth. */
const collectDiffs = (value: unknown, found: Array<Diff> = []): Array<Diff> => {
  if (typeof value !== "object" || value === null) return found;
  const record = value as Record<string, unknown>;
  if ("old" in record && "new" in record) found.push({ old: record["old"], new: record["new"] });
  for (const child of Object.values(record)) collectDiffs(child, found);
  return found;
};

/** The stored row, read directly from the table, because a soft delete keeps it. */
interface ProjectRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly deleted_at: string | null;
}

const sortNames = (projects: ReadonlyArray<{ readonly name: string }>) =>
  projects.map((project) => project.name).sort();

describe("project.create", () => {
  it("gives the project a UUIDv7 id and the same createdAt and updatedAt", async () => {
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

  it("creates a project with only a name", async () => {
    const project = await run(
      Effect.flatMap(ProjectService, (projects) => projects.create({ name: "Bare" })),
    );
    expect(project.name).toBe("Bare");
    expect(project.id).toMatch(UUID_V7);
    expect(project.createdAt).toBe(project.updatedAt);
  });

  it("rejects a name that is empty, too long or missing", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        return [
          yield* Effect.flip(projects.create({ name: "" })),
          yield* Effect.flip(projects.create({ name: "x".repeat(MAX_PROJECT_NAME_LENGTH + 1) })),
          yield* Effect.flip(projects.create(castMalformedInput({ description: "no name" }))),
        ];
      }),
    );
    for (const error of errors) expect(error).toMatchObject({ error: { code: "validation" } });
  });
});

describe("project.update", () => {
  it("changes the field and updatedAt, and keeps createdAt", async () => {
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

  it("fails with not_found for an unknown id", async () => {
    const error = await runError(
      Effect.flatMap(ProjectService, (projects) =>
        projects.update({ id: UNKNOWN_ID, name: "Renamed" }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("project.delete", () => {
  it("hides the project from read and query, and keeps the row with deletedAt set", async () => {
    const { readError, listed, rows } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projects = yield* ProjectService;
        const gone = yield* projects.create({ name: "Retired" });
        yield* projects.create({ name: "Still here" });
        yield* TestClock.adjust(A_MINUTE);
        yield* projects.delete(gone.id);
        return {
          readError: yield* Effect.flip(projects.read(gone.id)),
          listed: (yield* projects.query({})).items,
          rows: yield* sql<ProjectRow>`SELECT id, name, deleted_at FROM projects
                                       WHERE id = ${uuidFromString(gone.id)}`,
        };
      }),
    );
    expect(readError).toMatchObject({ error: { code: "not_found" } });
    expect(sortNames(listed)).toEqual(["Still here"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Retired");
    expect(rows[0]?.deleted_at).toMatch(TIMESTAMP);
  });

  it("fails with not_found when the project is deleted a second time", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const created = yield* projects.create({ name: "Delete me" });
        yield* projects.delete(created.id);
        return yield* projects.delete(created.id);
      }),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("projects and resources", () => {
  it("keeps a task's projectId when its project is deleted", async () => {
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
        yield* projects.delete(project.id);
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
  it("writes one project.created event with the snapshot, stamped with the caller", async () => {
    const { project, entries } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const project = yield* projects.create({ name: "Hercule", description: "d" });
        return { project, entries: yield* readEventsOfKind(CREATED) };
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    expect(findSnapshot(entries[0]?.payload ?? {}, project.id)).toMatchObject({
      id: project.id,
      name: "Hercule",
      description: "d",
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  });

  it("writes one project.updated event with a diff for the changed field only", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const created = yield* projects.create({
          name: "Old name",
          description: "untouched description",
        });
        yield* TestClock.adjust(A_MINUTE);
        yield* projects.update({ id: created.id, name: "New name" });
        return yield* readEventsOfKind(UPDATED);
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    expect(collectDiffs(entries[0]?.payload)).toEqual([{ old: "Old name", new: "New name" }]);
    expect(JSON.stringify(entries[0]?.payload)).not.toContain("untouched description");
  });

  it("writes one project.deleted event with the final snapshot", async () => {
    const { project, entries } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const project = yield* projects.create({ name: "Gone" });
        yield* TestClock.adjust(A_MINUTE);
        yield* projects.delete(project.id);
        return { project, entries: yield* readEventsOfKind(DELETED) };
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    const snapshot = findSnapshot(entries[0]?.payload ?? {}, project.id);
    expect(snapshot).toMatchObject({ id: project.id, name: "Gone" });
    expect(snapshot?.["deletedAt"]).toMatch(TIMESTAMP);
  });

  it("writes no event when the mutation fails", async () => {
    const { created, updated, deleted } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        yield* Effect.ignore(projects.create({ name: "" }));
        yield* Effect.ignore(projects.update({ id: UNKNOWN_ID, name: "Renamed" }));
        yield* Effect.ignore(projects.delete(UNKNOWN_ID));
        return {
          created: yield* readEventsOfKind(CREATED),
          updated: yield* readEventsOfKind(UPDATED),
          deleted: yield* readEventsOfKind(DELETED),
        };
      }),
    );
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
  });
});

describe("project.query", () => {
  /** Reads every page of a project list and returns the names in order. */
  const walkPages = (input: QueryInput, limit: number) =>
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

  it("sorts by name when no sort is given, and by the given field otherwise", async () => {
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

  it("returns every project exactly once, for any page size and order", async () => {
    const walks = await run(
      Effect.gen(function* () {
        yield* five;
        return {
          nameAscending: yield* walkPages({}, 2),
          nameDescending: yield* walkPages({ sort: { field: "name", direction: "desc" } }, 2),
          updatedDescending: yield* walkPages(
            { sort: { field: "updatedAt", direction: "desc" } },
            1,
          ),
        };
      }),
    );
    const all = ["Atlas", "Docs", "Hercule", "Runner", "Web"];
    expect(walks.nameAscending).toEqual(all);
    expect(walks.nameDescending).toEqual([...all].reverse());
    expect(walks.updatedDescending.sort()).toEqual(all);
  });

  it("rejects an unknown sort field, a cursor from another sort order, and a damaged cursor", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        yield* five;
        const page = yield* projects.query({ limit: 2, sort: { field: "name" } });
        const cursor = page.nextCursor ?? "";
        return [
          yield* Effect.flip(projects.query(castMalformedInput({ sort: { field: "size" } }))),
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

describe("updates that change nothing", () => {
  it("rejects a patch with no field, and writes nothing for a patch that changes nothing", async () => {
    const { empty, before, after, entries } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const before = yield* projects.create({ name: "Hercule", description: "d" });
        yield* TestClock.adjust(A_MINUTE);
        return {
          empty: yield* Effect.flip(projects.update({ id: before.id })),
          before,
          after: yield* projects.update({ id: before.id, name: "Hercule", description: "d" }),
          entries: yield* readEventsOfKind(UPDATED),
        };
      }),
    );
    expect(empty).toMatchObject({ error: { code: "validation" } });
    expect(after).toEqual(before);
    expect(entries).toEqual([]);
  });

  it("removes the description when an update sets it to null", async () => {
    const { cleared, entries } = await run(
      Effect.gen(function* () {
        const projects = yield* ProjectService;
        const created = yield* projects.create({ name: "Hercule", description: "d" });
        yield* TestClock.adjust(A_MINUTE);
        return {
          cleared: yield* projects.update({ id: created.id, description: null }),
          entries: yield* readEventsOfKind(UPDATED),
        };
      }),
    );
    expect(cleared.description).toBeUndefined();
    expect(collectDiffs(entries[0]?.payload)).toEqual([{ old: "d", new: null }]);
  });
});

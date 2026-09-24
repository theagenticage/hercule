import { describe, expect, it } from "vitest";
import { Clock, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MAX_TASK_LABELS, MAX_TASK_TITLE_LENGTH, type Task } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { TaskService, TaskServiceLayer, type QueryInput, type TaskPage } from "./index";

type Deps = TaskService | AuditLog | SqlClient.SqlClient;

const layer = TaskServiceLayer.pipe(
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
const castMalformedInput = <T>(input: unknown): T => input as T;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ISSUE_REF = "github:issue:owner/repo#42";
const THREAD_REF = "gmail:thread:19b2c";

const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

/** A minute, so two writes never land on the same instant by accident. */
const A_MINUTE = 60_000;

const sortTitles = (tasks: ReadonlyArray<Task>) => tasks.map((task) => task.title).sort();

describe("task.create", () => {
  it("fills in the defaults and stamps one instant on the three timestamps", async () => {
    const task = await run(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.create({ title: "Fix the flaky migration test", description: "" }),
      ),
    );
    expect(task).toMatchObject({
      title: "Fix the flaky migration test",
      description: "",
      status: "open",
      priority: "normal",
      labels: [],
      provenance: [],
    });
    expect(task.id).toMatch(UUID_V7);
    expect(task.createdAt).toBe(task.updatedAt);
    expect(task.statusChangedAt).toBe(task.createdAt);
    expect(task.deletedAt).toBeUndefined();
  });

  it("refuses a title that is empty, over the cap, or missing", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        return [
          yield* Effect.flip(tasks.create({ title: "", description: "d" })),
          yield* Effect.flip(
            tasks.create({ title: "x".repeat(MAX_TASK_TITLE_LENGTH + 1), description: "d" }),
          ),
          yield* Effect.flip(tasks.create(castMalformedInput({ description: "d" }))),
        ];
      }),
    );
    for (const error of errors) expect(error).toMatchObject({ error: { code: "validation" } });
  });

  it("caps the labels a task ends up carrying, not just the ones one call names", async () => {
    const { filled, overflow } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const buildLabel = (index: number) => `label-${String(index)}`;
        const created = yield* tasks.create({
          title: "Labelled",
          description: "",
          labels: Array.from({ length: MAX_TASK_LABELS }, (_, index) => buildLabel(index)),
        });
        return {
          filled: created.labels.length,
          // Every call is under the cap and the row is at it, so what refuses
          // this is the rule about the row rather than the one about the call.
          overflow: yield* Effect.flip(
            tasks.update({ id: created.id, addLabels: [buildLabel(MAX_TASK_LABELS)] }),
          ),
        };
      }),
    );
    expect(filled).toBe(MAX_TASK_LABELS);
    expect(overflow).toMatchObject({ error: { code: "validation" } });
  });
});

describe("task.update", () => {
  it("moves updatedAt and leaves statusChangedAt when only the description changes", async () => {
    const { before, after } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({ title: "Ship the drawer", description: "old" });
        yield* TestClock.adjust(A_MINUTE);
        return {
          before: created,
          after: yield* tasks.update({ id: created.id, description: "new" }),
        };
      }),
    );
    expect(after.description).toBe("new");
    expect(after.statusChangedAt).toBe(before.statusChangedAt);
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect(after.status).toBe("open");
  });

  it("moves both when the status changes", async () => {
    const { before, after } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({ title: "Ship the drawer", description: "d" });
        yield* TestClock.adjust(A_MINUTE);
        return {
          before: created,
          after: yield* tasks.update({ id: created.id, status: "in-progress" }),
        };
      }),
    );
    expect(after.status).toBe("in-progress");
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect(after.statusChangedAt > before.statusChangedAt).toBe(true);
  });

  it("adds and removes labels without touching the rest, and one label twice is one label", async () => {
    const { added, twice, removed } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({
          title: "Triage the inbox",
          description: "d",
          priority: "high",
        });
        const added = yield* tasks.update({ id: created.id, addLabels: ["proposed", "code"] });
        const twice = yield* tasks.update({ id: created.id, addLabels: ["code"] });
        const removed = yield* tasks.update({ id: created.id, removeLabels: ["proposed"] });
        return { added, twice, removed };
      }),
    );
    expect([...added.labels].sort()).toEqual(["code", "proposed"]);
    expect([...twice.labels].sort()).toEqual(["code", "proposed"]);
    expect(removed.labels).toEqual(["code"]);
    expect(removed).toMatchObject({
      title: "Triage the inbox",
      description: "d",
      priority: "high",
    });
  });

  it("appends provenance and removes nothing", async () => {
    const task = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({
          title: "Duplicate signal",
          description: "d",
          provenance: [{ ref: ISSUE_REF }],
        });
        return yield* tasks.update({ id: created.id, provenance: [{ eventId: 7 }] });
      }),
    );
    expect(task.provenance).toHaveLength(2);
    expect(task.provenance[0]).toMatchObject({ ref: ISSUE_REF, actor: "user" });
    expect(task.provenance[1]).toMatchObject({ eventId: 7, actor: "user" });
  });

  it("answers not_found for an id nobody has", async () => {
    const error = await runError(
      Effect.flatMap(TaskService, (tasks) => tasks.update({ id: UNKNOWN_ID, title: "x" })),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("fails with a Validation error that asks for a field when the update sets none", async () => {
    const error = await runError(
      Effect.flatMap(TaskService, (tasks) =>
        Effect.flatMap(tasks.create({ title: "Unchanged", description: "d" }), (created) =>
          tasks.update({ id: created.id }),
        ),
      ),
    );
    expect(error).toMatchObject({
      error: {
        code: "validation",
        details: {
          issues: [
            {
              path: [],
              message: expect.stringContaining("at least one field to change") as unknown,
            },
          ],
        },
      },
    });
  });
});

describe("task.delete", () => {
  it("hides the task from read, query and search, and stamps deletedAt on what it emits", async () => {
    const { result, readError, listed, found, entries } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const audit = yield* AuditLog;
        const created = yield* tasks.create({
          title: "Retire the placeholder screen",
          description: "d",
        });
        const result = yield* tasks.delete({ id: created.id });
        return {
          result,
          readError: yield* Effect.flip(tasks.read({ id: created.id })),
          listed: (yield* tasks.query({})).items,
          found: (yield* tasks.query({ text: "placeholder" })).items,
          entries: yield* audit.listByKind("task.deleted"),
        };
      }),
    );
    expect(result).toEqual({});
    expect(readError).toMatchObject({ error: { code: "not_found" } });
    expect(listed).toEqual([]);
    expect(found).toEqual([]);
    expect(entries).toHaveLength(1);
    const snapshot = (entries[0]?.payload as { snapshot: Task }).snapshot;
    expect(snapshot.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("answers not_found the second time", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({ title: "Delete me", description: "d" });
        yield* tasks.delete({ id: created.id });
        return yield* tasks.delete({ id: created.id });
      }),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

/**
 * The three tasks every filter test narrows. They differ in one dimension each,
 * so a filter that matched on the wrong field would return the wrong titles.
 */
const withThreeTasks = Effect.gen(function* () {
  const tasks = yield* TaskService;
  yield* tasks.create({
    title: "open and labelled",
    description: "d",
    labels: ["code"],
    provenance: [{ ref: ISSUE_REF }],
  });
  const running = yield* tasks.create({
    title: "in progress and labelled",
    description: "d",
    labels: ["code", "ops"],
  });
  yield* tasks.update({ id: running.id, status: "in-progress" });
  const done = yield* tasks.create({
    title: "done and unlabelled",
    description: "d",
    provenance: [{ ref: THREAD_REF }],
  });
  yield* tasks.update({ id: done.id, status: "done" });
  return tasks;
});

describe("task.query", () => {
  it("matches refs, labels and status by exact identity, any-of within a field", async () => {
    const { byRef, byRefs, byLabel, byStatus } = await run(
      Effect.gen(function* () {
        const tasks = yield* withThreeTasks;
        return {
          byRef: (yield* tasks.query({ refs: [ISSUE_REF] })).items,
          byRefs: (yield* tasks.query({ refs: [ISSUE_REF, THREAD_REF] })).items,
          byLabel: (yield* tasks.query({ labels: ["ops"] })).items,
          byStatus: (yield* tasks.query({ status: ["open", "done"] })).items,
        };
      }),
    );
    expect(sortTitles(byRef)).toEqual(["open and labelled"]);
    expect(sortTitles(byRefs)).toEqual(["done and unlabelled", "open and labelled"]);
    expect(sortTitles(byLabel)).toEqual(["in progress and labelled"]);
    expect(sortTitles(byStatus)).toEqual(["done and unlabelled", "open and labelled"]);
  });

  it("ands across fields: a status plus a label needs both", async () => {
    const { both, neither } = await run(
      Effect.gen(function* () {
        const tasks = yield* withThreeTasks;
        return {
          both: (yield* tasks.query({ status: ["open"], labels: ["code"] })).items,
          neither: (yield* tasks.query({ status: ["done"], labels: ["code"] })).items,
        };
      }),
    );
    expect(sortTitles(both)).toEqual(["open and labelled"]);
    expect(neither).toEqual([]);
  });

  it("returns every live task when nothing is filtered", async () => {
    const items = await run(
      Effect.flatMap(withThreeTasks, (tasks) => Effect.map(tasks.query({}), (page) => page.items)),
    );
    expect(sortTitles(items)).toEqual([
      "done and unlabelled",
      "in progress and labelled",
      "open and labelled",
    ]);
  });

  it("matches no task for a project none of them is in", async () => {
    const items = await run(
      Effect.flatMap(withThreeTasks, (tasks) =>
        Effect.map(tasks.query({ projectId: UNKNOWN_ID }), (page) => page.items),
      ),
    );
    expect(items).toEqual([]);
  });
});

/** Prose in the two indexed fields, and the same words where search must not look. */
const withProse = Effect.gen(function* () {
  const tasks = yield* TaskService;
  yield* tasks.create({ title: "Café Naïve espresso machine", description: "grind size" });
  yield* tasks.create({ title: "espresso grinder", description: "The NAIVE cafe parser loops" });
  yield* tasks.create({
    title: "unrelated ticket",
    description: "no prose words here",
    labels: ["cafe"],
    provenance: [{ ref: "github:issue:cafe/naive#1" }],
  });
  return tasks;
});

describe("full-text search", () => {
  it("matches the title or the description, whatever the case and the diacritics", async () => {
    const items = await run(
      Effect.flatMap(withProse, (tasks) =>
        Effect.map(tasks.query({ text: "café naive" }), (page) => page.items),
      ),
    );
    expect(sortTitles(items)).toEqual(["Café Naïve espresso machine", "espresso grinder"]);
  });

  it("never reaches a label or a ref", async () => {
    const items = await run(
      Effect.flatMap(withProse, (tasks) =>
        Effect.map(tasks.query({ text: "naive" }), (page) => page.items),
      ),
    );
    // The third task carries the word only in a label and a ref, and neither its
    // title nor its description holds it.
    expect(sortTitles(items)).toEqual(["Café Naïve espresso machine", "espresso grinder"]);
  });

  it("follows a retitled task: the old word stops matching and the new one starts", async () => {
    const { before, after } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* tasks.create({ title: "hydrology survey", description: "" });
        yield* tasks.update({ id: task.id, title: "limnology survey" });
        return {
          before: yield* tasks.query({ text: "hydrology" }),
          after: yield* tasks.query({ text: "limnology" }),
        };
      }),
    );
    // The index is external content: nothing but the update trigger takes the
    // old terms out of it, and stale terms would answer for a row that no
    // longer holds them.
    expect(sortTitles(before.items)).toEqual([]);
    expect(sortTitles(after.items)).toEqual(["limnology survey"]);
  });

  it("treats FTS5 operators as plain words rather than as syntax", async () => {
    const page = await run(
      Effect.flatMap(withProse, (tasks) => tasks.query({ text: 'AND OR "(' })),
    );
    // The operators are words a search box can hold, so the call answers with a
    // result set. Nothing here says which tasks that set holds.
    expect(Array.isArray(page.items)).toBe(true);
  });
});

describe("provenance", () => {
  it("refuses an entry naming none of ref, eventId and runId, on create and on update", async () => {
    const { onCreate, onUpdate } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({ title: "Provenance", description: "d" });
        return {
          onCreate: yield* Effect.flip(
            tasks.create(castMalformedInput({ title: "t", description: "d", provenance: [{}] })),
          ),
          onUpdate: yield* Effect.flip(
            tasks.update(castMalformedInput({ id: created.id, provenance: [{}] })),
          ),
        };
      }),
    );
    expect(onCreate).toMatchObject({ error: { code: "validation" } });
    expect(onUpdate).toMatchObject({ error: { code: "validation" } });
  });

  it("refuses a caller who stamps an entry with an at or an actor of their own", async () => {
    const { withAt, withActor } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        return {
          withAt: yield* Effect.flip(
            tasks.create(
              castMalformedInput({
                title: "t",
                description: "d",
                provenance: [{ ref: ISSUE_REF, at: "2026-09-04T10:00:00.000Z" }],
              }),
            ),
          ),
          withActor: yield* Effect.flip(
            tasks.create(
              castMalformedInput({
                title: "t",
                description: "d",
                provenance: [{ ref: ISSUE_REF, actor: "session:0199e0e7-0002-7000-8000-00000000" }],
              }),
            ),
          ),
        };
      }),
    );
    expect(withAt).toMatchObject({ error: { code: "validation" } });
    expect(withActor).toMatchObject({ error: { code: "validation" } });
  });

  it("stamps at and actor itself", async () => {
    const task = await run(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.create({ title: "t", description: "d", provenance: [{ ref: ISSUE_REF }] }),
      ),
    );
    expect(task.provenance[0]?.actor).toBe("user");
    expect(task.provenance[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("external refs", () => {
  it("takes the canonical form and refuses every malformation of it", async () => {
    const { accepted, errors } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const accepted = yield* tasks.create({
          title: "t",
          description: "d",
          provenance: [{ ref: ISSUE_REF }],
        });
        const errors = [];
        for (const ref of ["GitHub:issue:x", "github:issue", "github:issue:a b"]) {
          errors.push(
            yield* Effect.flip(
              tasks.create(
                castMalformedInput({ title: "t", description: "d", provenance: [{ ref }] }),
              ),
            ),
          );
        }
        return { accepted, errors };
      }),
    );
    expect(accepted.provenance[0]?.ref).toBe(ISSUE_REF);
    for (const error of errors) expect(error).toMatchObject({ error: { code: "validation" } });
  });

  it("lets two tasks carry the same ref", async () => {
    const items = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* tasks.create({ title: "first", description: "d", provenance: [{ ref: ISSUE_REF }] });
        yield* tasks.create({
          title: "second",
          description: "d",
          provenance: [{ ref: ISSUE_REF }],
        });
        return (yield* tasks.query({ refs: [ISSUE_REF] })).items;
      }),
    );
    expect(sortTitles(items)).toEqual(["first", "second"]);
  });
});

/**
 * A clock that moves a second every time it is read. That is what a
 * transaction wait looks like from inside one operation, and it is what makes
 * two reads in one operation impossible to confuse with one.
 */
const createTickingClock = (): Clock.Clock => {
  let millis = Date.parse("2026-09-04T10:00:00.000Z");
  const advanceClock = () => (millis += 1000);
  const readNanos = () => BigInt(millis) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: advanceClock,
    currentTimeMillis: Effect.sync(advanceClock),
    currentTimeNanosUnsafe: readNanos,
    currentTimeNanos: Effect.sync(readNanos),
    monotonicTimeNanosUnsafe: readNanos,
    monotonicTimeNanos: Effect.sync(readNanos),
    sleep: () => Effect.void,
  };
};

const runTicking = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
      Effect.provideService(Clock.Clock, createTickingClock()),
    ),
  );

describe("the event log", () => {
  it("dates an entry by the same clock read as the row it records", async () => {
    const { created, updated, createdEntries, updatedEntries } = await runTicking(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const audit = yield* AuditLog;
        const created = yield* tasks.create({ title: "Before", description: "d" });
        const updated = yield* tasks.update({ id: created.id, title: "After" });
        return {
          created,
          updated,
          createdEntries: yield* audit.listByKind("task.created"),
          updatedEntries: yield* audit.listByKind("task.updated"),
        };
      }),
    );
    // The event that records a change is never dated before the change: a
    // caller reading the log up to a task's own `createdAt` sees the entry.
    expect(createdEntries[0]?.receivedAt).toBe(created.createdAt);
    expect(updatedEntries[0]?.receivedAt).toBe(updated.updatedAt);
  });

  it("writes one task.created carrying the task, and nothing about the actor", async () => {
    const { task, entries } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const audit = yield* AuditLog;
        const task = yield* tasks.create({ title: "Write it down", description: "d" });
        return { task, entries: yield* audit.listByKind("task.created") };
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    expect(entries[0]?.payload).toEqual({ task });
    expect(Object.keys(entries[0]?.payload ?? {})).toEqual(["task"]);
  });

  it("writes one task.updated carrying only what changed, scalars and arrays apart", async () => {
    const { task, entries } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const audit = yield* AuditLog;
        const created = yield* tasks.create({ title: "Before", description: "d" });
        yield* TestClock.adjust(A_MINUTE);
        yield* tasks.update({
          id: created.id,
          title: "After",
          addLabels: ["code"],
          provenance: [{ ref: ISSUE_REF }],
        });
        return { task: created, entries: yield* audit.listByKind("task.updated") };
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    const payload = entries[0]?.payload as {
      taskId: string;
      changes: Record<string, unknown>;
    };
    expect(Object.keys(payload)).toEqual(["taskId", "changes"]);
    expect(payload.taskId).toBe(task.id);
    expect(Object.keys(payload.changes).sort()).toEqual(["labels", "provenance", "title"]);
    expect(payload.changes["title"]).toEqual({ old: "Before", new: "After" });
    expect(payload.changes["labels"]).toEqual({ added: ["code"], removed: [] });
    expect(payload.changes["provenance"]).toMatchObject({ removed: [] });
    expect((payload.changes["provenance"] as { added: ReadonlyArray<unknown> }).added).toHaveLength(
      1,
    );
  });

  it("writes one task.deleted carrying the final snapshot", async () => {
    const { task, entries } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const audit = yield* AuditLog;
        const created = yield* tasks.create({ title: "Gone", description: "d" });
        yield* tasks.delete({ id: created.id });
        return { task: created, entries: yield* audit.listByKind("task.deleted") };
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    expect(Object.keys(entries[0]?.payload ?? {})).toEqual(["taskId", "snapshot"]);
    const payload = entries[0]?.payload as { taskId: string; snapshot: Task };
    expect(payload.taskId).toBe(task.id);
    expect(payload.snapshot).toMatchObject({ id: task.id, title: "Gone", status: "open" });
  });

  it("writes nothing when the mutation fails", async () => {
    const { created, updated, deleted } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const audit = yield* AuditLog;
        yield* Effect.ignore(tasks.create({ title: "", description: "d" }));
        yield* Effect.ignore(tasks.update({ id: UNKNOWN_ID, title: "x" }));
        yield* Effect.ignore(tasks.delete({ id: UNKNOWN_ID }));
        return {
          created: yield* audit.listByKind("task.created"),
          updated: yield* audit.listByKind("task.updated"),
          deleted: yield* audit.listByKind("task.deleted"),
        };
      }),
    );
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
  });
});

/** Seven tasks, walked two at a time, is three full pages and a short one. */
const withSeven = Effect.gen(function* () {
  const tasks = yield* TaskService;
  for (let index = 0; index < 7; index += 1) {
    yield* tasks.create({ title: `report ${index}`, description: "prose to search" });
    yield* TestClock.adjust(A_MINUTE);
  }
  return tasks;
});

/** Every title the walk hands out, page by page, until it says there is no more. */
const walkPages = (tasks: TaskService["Service"], input: QueryInput) =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    let cursor: string | undefined = undefined;
    do {
      const page: TaskPage = yield* tasks.query({
        ...input,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((task) => task.title));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return seen;
  });

describe("paging", () => {
  it("hands out every task exactly once, by keyset and by relevance alike", async () => {
    const { keyset, relevance } = await run(
      Effect.gen(function* () {
        const tasks = yield* withSeven;
        return {
          keyset: yield* walkPages(tasks, { limit: 2 }),
          relevance: yield* walkPages(tasks, { limit: 2, text: "prose" }),
        };
      }),
    );
    expect(keyset).toHaveLength(7);
    expect(new Set(keyset).size).toBe(7);
    expect(relevance.sort()).toEqual(keyset.sort());
  });

  it("refuses a cursor from a search of other words", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const tasks = yield* withSeven;
        const { nextCursor } = yield* tasks.query({ limit: 2, text: "prose" });
        if (nextCursor === undefined) return yield* Effect.die("the search has a second page");
        return yield* tasks.query({ limit: 2, text: "report", cursor: nextCursor });
      }),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });

  it("refuses a search cursor replayed under another filter", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        for (let index = 0; index < 4; index += 1) {
          yield* tasks.create({
            title: `report ${index}`,
            description: "prose",
            labels: [index < 2 ? "a" : "b"],
          });
        }
        const { nextCursor } = yield* tasks.query({ limit: 1, text: "prose", labels: ["a"] });
        if (nextCursor === undefined) return yield* Effect.die("the search has a second page");
        return yield* tasks.query({ limit: 1, text: "prose", labels: ["b"], cursor: nextCursor });
      }),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });

  it("refuses a search that also names a sort, naming both", async () => {
    const error = await runError(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.query({ text: "prose", sort: { field: "updatedAt" } }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
    const paths = (
      error as { error: { details: { issues: ReadonlyArray<{ path: ReadonlyArray<string> }> } } }
    ).error.details.issues.flatMap((issue) => issue.path);
    expect(paths.sort()).toEqual(["sort", "text"]);
  });
});

describe("an update that changes nothing", () => {
  it("writes no row and no event when the task already holds the values", async () => {
    const { before, after, entries } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const audit = yield* AuditLog;
        const before = yield* tasks.create({ title: "Steady", description: "d" });
        yield* TestClock.adjust(A_MINUTE);
        const after = yield* tasks.update({
          id: before.id,
          title: "Steady",
          status: "open",
          projectId: null,
          addLabels: [],
        });
        return { before, after, entries: yield* audit.listByKind("task.updated") };
      }),
    );
    expect(after).toEqual(before);
    expect(entries).toEqual([]);
  });

  it("reports a label added and removed in one call as neither", async () => {
    const { task, entries } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const audit = yield* AuditLog;
        const created = yield* tasks.create({
          title: "Both ways",
          description: "d",
          labels: ["code"],
        });
        const task = yield* tasks.update({
          id: created.id,
          addLabels: ["code"],
          removeLabels: ["code"],
        });
        return { task, entries: yield* audit.listByKind("task.updated") };
      }),
    );
    expect(task.labels).toEqual(["code"]);
    expect(entries).toEqual([]);
  });
});

describe("the project a task belongs to", () => {
  it("refuses a project that is not there, and takes one that is", async () => {
    const { task, unknown, deleted } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* TaskService;
        const live = mintUuid();
        const gone = mintUuid();
        yield* sql`INSERT INTO projects (id, name, created_at, updated_at)
                   VALUES (${live}, 'hercule', '2026-09-04T10:00:00.000Z', '2026-09-04T10:00:00.000Z')`;
        yield* sql`INSERT INTO projects (id, name, created_at, updated_at, deleted_at)
                   VALUES (${gone}, 'retired', '2026-09-04T10:00:00.000Z',
                           '2026-09-04T10:00:00.000Z', '2026-09-04T11:00:00.000Z')`;
        const projectId = uuidToString(live);
        return {
          task: yield* tasks.create({ title: "In a project", description: "d", projectId }),
          unknown: yield* Effect.flip(
            tasks.create({ title: "t", description: "d", projectId: UNKNOWN_ID }),
          ),
          deleted: yield* Effect.flip(
            tasks.create({ title: "t", description: "d", projectId: uuidToString(gone) }),
          ),
        };
      }),
    );
    expect(task.projectId).toMatch(UUID_V7);
    expect(unknown).toMatchObject({ error: { code: "not_found" } });
    expect(deleted).toMatchObject({ error: { code: "not_found" } });
  });

  it("finds the tasks of one project and no others", async () => {
    const items = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* TaskService;
        const id = mintUuid();
        yield* sql`INSERT INTO projects (id, name, created_at, updated_at)
                   VALUES (${id}, 'hercule', '2026-09-04T10:00:00.000Z', '2026-09-04T10:00:00.000Z')`;
        yield* tasks.create({
          title: "inside",
          description: "d",
          projectId: uuidToString(id),
        });
        yield* tasks.create({ title: "outside", description: "d" });
        return (yield* tasks.query({ projectId: uuidToString(id) })).items;
      }),
    );
    expect(sortTitles(items)).toEqual(["inside"]);
  });
});

describe("the priority order", () => {
  it("walks urgent to low rather than alphabetically, one row at a time", async () => {
    const walked = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        for (const priority of ["low", "urgent", "normal", "high"] as const) {
          yield* tasks.create({ title: priority, description: "d", priority });
        }
        return yield* walkPages(yield* TaskService, {
          limit: 1,
          sort: { field: "priority", direction: "asc" },
        });
      }),
    );
    expect(walked).toEqual(["urgent", "high", "normal", "low"]);
  });
});

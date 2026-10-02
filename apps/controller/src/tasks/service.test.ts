import { describe, expect, it } from "vitest";
import { Clock, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  MAX_TASK_LABELS,
  MAX_TASK_TITLE_LENGTH,
  type Task,
  type TaskCreateInput,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidToString, type Change } from "../db";
import { buildAnnouncementRecorder, TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { insertOpenDecision, readStoredNotification } from "../notifications/testing";
import { readEventsOfKind } from "../events/testing";
import { TaskService, TaskServiceLayer, type QueryInput, type TaskPage } from "./index";

type Deps = TaskService | SqlClient.SqlClient;

const layer = TaskServiceLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/**
 * Runs an effect as the user, on a `TestClock`. A test that needs a later
 * `updatedAt` moves the clock forward, rather than hoping the next write lands
 * in a later millisecond.
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
 * Casts input that a caller can send over the wire but the types here rule
 * out. Rejecting such input is the service's job, so the test must be able to
 * pass it in.
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
  it("fills in the defaults and sets the three timestamps to the same time", async () => {
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

  it("rejects a title that is empty, too long, or missing", async () => {
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

  it("caps the total labels on a task, not just the labels in one call", async () => {
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
          // Every call is under the cap and the task is at it, so this is
          // rejected by the rule about the task's total, not the rule about
          // one call.
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

  it("adds and removes labels without changing the rest, and stores a repeated label once", async () => {
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

  it("returns not_found for an id that does not exist", async () => {
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
  it("hides the task from read, query and search, and sets deletedAt on the event it writes", async () => {
    const { result, readError, listed, found, entries } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({
          title: "Retire the placeholder screen",
          description: "d",
        });
        const result = yield* tasks.delete(created.id);
        return {
          result,
          readError: yield* Effect.flip(tasks.read(created.id)),
          listed: (yield* tasks.query({})).items,
          found: (yield* tasks.query({ text: "placeholder" })).items,
          entries: yield* readEventsOfKind("task.deleted"),
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

  it("withdraws the open decisions about the task, and leaves the others open", async () => {
    const { about, other } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const deleted = yield* tasks.create({ title: "Delete me", description: "d" });
        const kept = yield* tasks.create({ title: "Keep me", description: "d" });
        const about = yield* insertOpenDecision({ kind: "task", id: deleted.id });
        const other = yield* insertOpenDecision({ kind: "task", id: kept.id });
        yield* tasks.delete(deleted.id);
        return {
          about: yield* readStoredNotification(about),
          other: yield* readStoredNotification(other),
        };
      }),
    );
    expect(about.status).toBe("resolved");
    expect(about.resolution).toMatchObject({
      kind: "withdrawn",
      actor: "system",
      origin: "core",
      reason: "task deleted",
    });
    expect(other.status).toBe("open");
  });

  it("returns not_found the second time", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({ title: "Delete me", description: "d" });
        yield* tasks.delete(created.id);
        return yield* tasks.delete(created.id);
      }),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

/**
 * The three tasks every filter test filters. Each differs from the others in
 * one field, so a filter that matched on the wrong field would return the
 * wrong titles.
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
  it("matches refs, labels and status exactly, and any of the values within a field", async () => {
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

  it("requires every field to match: a status plus a label needs both", async () => {
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

  it("matches no task for a project that has no tasks", async () => {
    const items = await run(
      Effect.flatMap(withThreeTasks, (tasks) =>
        Effect.map(tasks.query({ projectId: UNKNOWN_ID }), (page) => page.items),
      ),
    );
    expect(items).toEqual([]);
  });
});

/** Text in the two indexed fields, and the same words in fields that search must ignore. */
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
  it("matches the title or the description, ignoring case and diacritics", async () => {
    const items = await run(
      Effect.flatMap(withProse, (tasks) =>
        Effect.map(tasks.query({ text: "café naive" }), (page) => page.items),
      ),
    );
    expect(sortTitles(items)).toEqual(["Café Naïve espresso machine", "espresso grinder"]);
  });

  it("never matches a label or a ref", async () => {
    const items = await run(
      Effect.flatMap(withProse, (tasks) =>
        Effect.map(tasks.query({ text: "naive" }), (page) => page.items),
      ),
    );
    // The third task has the word only in a label and a ref, not in its title
    // or its description.
    expect(sortTitles(items)).toEqual(["Café Naïve espresso machine", "espresso grinder"]);
  });

  it("follows a renamed task: the old word stops matching and the new one starts", async () => {
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
    // The index is an external-content table: only the update trigger removes
    // the old terms from it, and stale terms would match a row that no longer
    // contains them.
    expect(sortTitles(before.items)).toEqual([]);
    expect(sortTitles(after.items)).toEqual(["limnology survey"]);
  });

  it("treats FTS5 operators as plain words rather than as syntax", async () => {
    const page = await run(
      Effect.flatMap(withProse, (tasks) => tasks.query({ text: 'AND OR "(' })),
    );
    // The operators are words someone can type in a search box, so the call
    // returns a result set instead of failing. This test does not check which
    // tasks are in it.
    expect(Array.isArray(page.items)).toBe(true);
  });
});

describe("provenance", () => {
  it("rejects an entry with none of ref, eventId and runId, on create and on update", async () => {
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

  it("rejects an entry where the caller sets its own at or actor", async () => {
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

  it("sets at and actor itself", async () => {
    const task = await run(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.create({ title: "t", description: "d", provenance: [{ ref: ISSUE_REF }] }),
      ),
    );
    expect(task.provenance[0]?.actor).toBe("user");
    expect(task.provenance[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  describe("of a task a run's step creates", () => {
    const RUN_ID = "0199e0e7-0002-7000-8000-000000000000";
    const OTHER_RUN_ID = "0199e0e7-0003-7000-8000-000000000000";
    const RUN: Actor = { _tag: "run", runId: RUN_ID, stepId: "file", workflowId: null };

    /** Creates a task as the run, with `provenance` as the step's params give it, and returns the task's provenance as refs and run ids. */
    const createAsRun = async (provenance: TaskCreateInput["provenance"]) => {
      const task = await run(
        Effect.provideService(
          Effect.flatMap(TaskService, (tasks) =>
            tasks.create({ title: "t", description: "d", ...(provenance && { provenance }) }),
          ),
          CurrentActor,
          RUN,
        ),
      );
      return task.provenance.map((entry) => [entry.ref, entry.runId, entry.actor]);
    };

    it("adds an entry naming the run after the entries the params give", async () => {
      expect(await createAsRun([{ ref: ISSUE_REF }, { runId: OTHER_RUN_ID }])).toEqual([
        [ISSUE_REF, undefined, `run:${RUN_ID}`],
        [undefined, OTHER_RUN_ID, `run:${RUN_ID}`],
        [undefined, RUN_ID, `run:${RUN_ID}`],
      ]);
      expect(await createAsRun(undefined)).toEqual([[undefined, RUN_ID, `run:${RUN_ID}`]]);
    });

    it("adds no second entry when the params already name the run", async () => {
      expect(await createAsRun([{ ref: ISSUE_REF, runId: RUN_ID }])).toEqual([
        [ISSUE_REF, RUN_ID, `run:${RUN_ID}`],
      ]);
    });

    it("adds nothing when the task is updated", async () => {
      const provenance = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const created = yield* tasks.create({ title: "t", description: "d" });
          const updated = yield* Effect.provideService(
            tasks.update({ id: created.id, status: "done" }),
            CurrentActor,
            RUN,
          );
          return updated.provenance;
        }),
      );
      expect(provenance).toEqual([]);
    });
  });
});

describe("external refs", () => {
  it("accepts the canonical form and rejects every malformed variant", async () => {
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
 * Creates a clock that moves forward one second every time it is read. This
 * is what a wait for a transaction looks like from inside one operation, and
 * it makes two clock reads in one operation easy to tell apart from one.
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
  it("dates an entry with the same clock read as the row it records", async () => {
    const { created, updated, createdEvents, updatedEvents } = await runTicking(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({ title: "Before", description: "d" });
        const updated = yield* tasks.update({ id: created.id, title: "After" });
        return {
          created,
          updated,
          createdEvents: yield* readEventsOfKind("task.created"),
          updatedEvents: yield* readEventsOfKind("task.updated"),
        };
      }),
    );
    // The event that records a change is never dated before the change, so a
    // caller reading the log up to a task's `createdAt` sees the entry.
    expect(createdEvents[0]?.receivedAt).toBe(created.createdAt);
    expect(updatedEvents[0]?.receivedAt).toBe(updated.updatedAt);
  });

  it("writes one task.created containing the task, and nothing about the actor in the payload", async () => {
    const { task, events } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* tasks.create({ title: "Write it down", description: "d" });
        return { task, events: yield* readEventsOfKind("task.created") };
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("user");
    expect(events[0]?.payload).toEqual({ task });
    expect(Object.keys(events[0]?.payload ?? {})).toEqual(["task"]);
  });

  it("writes one task.updated containing only what changed, with scalars and lists reported differently", async () => {
    const { task, events } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({ title: "Before", description: "d" });
        yield* TestClock.adjust(A_MINUTE);
        yield* tasks.update({
          id: created.id,
          title: "After",
          addLabels: ["code"],
          provenance: [{ ref: ISSUE_REF }],
        });
        return { task: created, events: yield* readEventsOfKind("task.updated") };
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("user");
    const payload = events[0]?.payload as {
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

  it("writes one task.deleted containing the final snapshot", async () => {
    const { task, entries } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({ title: "Gone", description: "d" });
        yield* tasks.delete(created.id);
        return { task: created, entries: yield* readEventsOfKind("task.deleted") };
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
        yield* Effect.ignore(tasks.create({ title: "", description: "d" }));
        yield* Effect.ignore(tasks.update({ id: UNKNOWN_ID, title: "x" }));
        yield* Effect.ignore(tasks.delete(UNKNOWN_ID));
        return {
          created: yield* readEventsOfKind("task.created"),
          updated: yield* readEventsOfKind("task.updated"),
          deleted: yield* readEventsOfKind("task.deleted"),
        };
      }),
    );
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
  });
});

/**
 * Runs `effect` as `run` does, and returns its value with every change
 * announced after a commit, in order.
 */
const runRecordingAnnouncements = async <A, E>(
  effect: Effect.Effect<A, E, Deps>,
): Promise<{ readonly value: A; readonly announced: ReadonlyArray<Change> }> => {
  const { listener, announced } = buildAnnouncementRecorder();
  const value = await run(effect.pipe(Effect.provide(listener)));
  return { value, announced };
};

describe("the changes a task write announces", () => {
  it("announces the log and the created task after task.create", async () => {
    const { value: task, announced } = await runRecordingAnnouncements(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.create({ title: "Announce me", description: "" }),
      ),
    );
    expect(announced).toEqual([
      { _tag: "event" },
      { _tag: "record", topic: "task", id: task.id, kind: "created" },
    ]);
  });

  it("announces the log and the updated task after task.update", async () => {
    const { value: task, announced } = await runRecordingAnnouncements(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const created = yield* tasks.create({ title: "Announce me", description: "" });
        return yield* tasks.update({ id: created.id, status: "done" });
      }),
    );
    expect(announced).toEqual([
      { _tag: "event" },
      { _tag: "record", topic: "task", id: task.id, kind: "created" },
      { _tag: "event" },
      { _tag: "record", topic: "task", id: task.id, kind: "updated" },
    ]);
  });

  it("announces nothing when the write fails", async () => {
    const { announced } = await runRecordingAnnouncements(
      Effect.flatMap(TaskService, (tasks) =>
        Effect.ignore(tasks.update({ id: UNKNOWN_ID, title: "x" })),
      ),
    );
    expect(announced).toEqual([]);
  });
});

/** Creates seven tasks. Paged two at a time, they fill three pages and a short one. */
const withSeven = Effect.gen(function* () {
  const tasks = yield* TaskService;
  for (let index = 0; index < 7; index += 1) {
    yield* tasks.create({ title: `report ${index}`, description: "prose to search" });
    yield* TestClock.adjust(A_MINUTE);
  }
  return tasks;
});

/** Returns every title from every page, following cursors until there is no next page. */
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
  it("returns every task exactly once, when paging by keyset and by relevance", async () => {
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

  it("rejects a cursor from a search with different words", async () => {
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

  it("rejects a search cursor reused with a different filter", async () => {
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

  it("rejects a search that also has a sort, and names both fields", async () => {
    const error = await runError(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.query({ text: "prose", sort: [{ field: "updatedAt" }] }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
    const paths = (
      error as { error: { details: { issues: ReadonlyArray<{ path: ReadonlyArray<string> }> } } }
    ).error.details.issues.flatMap((issue) => issue.path);
    expect(paths.sort()).toEqual(["sort", "text"]);
  });

  it("accepts a search with an empty sort list, which is no sort at all", async () => {
    const { items } = await run(
      Effect.gen(function* () {
        const tasks = yield* withSeven;
        return yield* tasks.query({ text: "prose", sort: [] });
      }),
    );
    expect(items).toHaveLength(7);
  });
});

describe("an update that changes nothing", () => {
  it("writes no row and no event when the task already has the values", async () => {
    const { before, after, events } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const before = yield* tasks.create({ title: "Steady", description: "d" });
        yield* TestClock.adjust(A_MINUTE);
        const after = yield* tasks.update({
          id: before.id,
          title: "Steady",
          status: "open",
          projectId: null,
          addLabels: [],
        });
        return { before, after, events: yield* readEventsOfKind("task.updated") };
      }),
    );
    expect(after).toEqual(before);
    expect(events).toEqual([]);
  });

  it("reports a label added and removed in one call as neither", async () => {
    const { task, events } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
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
        return { task, events: yield* readEventsOfKind("task.updated") };
      }),
    );
    expect(task.labels).toEqual(["code"]);
    expect(events).toEqual([]);
  });
});

describe("the project a task belongs to", () => {
  it("rejects a project that does not exist, and accepts one that does", async () => {
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

/**
 * Reads the issues of a `Validation` error. Fails the test when the error is
 * not one.
 */
const readValidationIssues = (
  error: unknown,
): ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly message: string }> => {
  expect(error).toMatchObject({ error: { code: "validation" } });
  return (
    error as {
      error: {
        details: {
          issues: ReadonlyArray<{ path: ReadonlyArray<string>; message: string }>;
        };
      };
    }
  ).error.details.issues;
};

describe("the order of the sort keys", () => {
  it("sorts by the first key, breaks its ties with the second, and breaks the rest by id", async () => {
    const { walked, created } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const create = (title: string, priority: "urgent" | "normal" | "low") =>
          tasks.create({ title, description: "d", priority });
        // The tasks created before one `TestClock.adjust` share `createdAt`,
        // so some rows are equal on both keys and only the id orders them.
        const created = [
          yield* create("normal 1", "normal"),
          yield* create("urgent 1", "urgent"),
          yield* create("urgent 2", "urgent"),
        ];
        yield* TestClock.adjust(A_MINUTE);
        created.push(
          yield* create("low", "low"),
          yield* create("normal 2", "normal"),
          yield* create("urgent 3", "urgent"),
          yield* create("normal 3", "normal"),
        );
        const walked = yield* walkPages(tasks, {
          limit: 1,
          sort: [
            { field: "priority", direction: "desc" },
            { field: "createdAt", direction: "asc" },
          ],
        });
        return { walked, created };
      }),
    );
    // The id breaks the ties left by both keys, in the direction of the last
    // key. Ids are random within one millisecond, so the order of each tie
    // is read from the ids rather than written down.
    const idOf = (title: string) => created.find((task) => task.title === title)?.id ?? "";
    const inIdOrder = (...titles: ReadonlyArray<string>) =>
      // A lowercase hex id sorts as a string the way its bytes sort in SQLite.
      [...titles].sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
    expect(walked).toEqual([
      ...inIdOrder("urgent 1", "urgent 2"),
      "urgent 3",
      "normal 1",
      ...inIdOrder("normal 2", "normal 3"),
      "low",
    ]);
  });

  it("lists the most urgent open tasks newest first within one priority", async () => {
    const { items } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        for (const [title, priority] of [
          ["A", "urgent"],
          ["B", "urgent"],
          ["C", "high"],
          ["D", "low"],
        ] as const) {
          yield* tasks.create({ title, description: "d", priority });
          yield* TestClock.adjust(A_MINUTE);
        }
        return yield* tasks.query({
          status: ["open"],
          sort: [
            { field: "priority", direction: "desc" },
            { field: "createdAt", direction: "desc" },
          ],
          limit: 3,
        });
      }),
    );
    expect(items.map((task) => task.title)).toEqual(["B", "A", "C"]);
  });

  it("reads a key with no direction as asc", async () => {
    const { bare, ascending } = await run(
      Effect.gen(function* () {
        const tasks = yield* withSeven;
        return {
          bare: yield* walkPages(tasks, { limit: 2, sort: [{ field: "createdAt" }] }),
          ascending: yield* walkPages(tasks, {
            limit: 2,
            sort: [{ field: "createdAt", direction: "asc" }],
          }),
        };
      }),
    );
    expect(bare).toEqual(ascending);
    expect(bare).toEqual([0, 1, 2, 3, 4, 5, 6].map((index) => `report ${index}`));
  });

  it("refuses a field that appears twice, and names it", async () => {
    const error = await runError(
      Effect.flatMap(TaskService, (tasks) =>
        tasks.query({
          sort: [{ field: "priority" }, { field: "priority", direction: "desc" }],
        }),
      ),
    );
    const messages = readValidationIssues(error).map((issue) => issue.message);
    expect(messages.some((message) => message.includes("priority appears more than once"))).toBe(
      true,
    );
  });

  it("refuses a cursor issued under another list of keys", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const tasks = yield* withSeven;
        const { nextCursor } = yield* tasks.query({
          limit: 1,
          sort: [
            { field: "priority", direction: "desc" },
            { field: "createdAt", direction: "desc" },
          ],
        });
        if (nextCursor === undefined) return yield* Effect.die("the listing has a second page");
        return yield* tasks.query({
          limit: 1,
          sort: [{ field: "priority", direction: "desc" }],
          cursor: nextCursor,
        });
      }),
    );
    expect(readValidationIssues(error).map((issue) => issue.path)).toEqual([["cursor"]]);
  });
});

describe("the priority order", () => {
  it("ascends low, normal, high, urgent rather than alphabetically, one row per page", async () => {
    const { ascending, descending } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        for (const priority of ["normal", "urgent", "low", "high"] as const) {
          yield* tasks.create({ title: priority, description: "d", priority });
        }
        return {
          ascending: yield* walkPages(tasks, {
            limit: 1,
            sort: [{ field: "priority", direction: "asc" }],
          }),
          descending: yield* walkPages(tasks, {
            limit: 1,
            sort: [{ field: "priority", direction: "desc" }],
          }),
        };
      }),
    );
    expect(ascending).toEqual(["low", "normal", "high", "urgent"]);
    expect(descending).toEqual(["urgent", "high", "normal", "low"]);
  });
});

describe("the status order", () => {
  it("ascends open, in-progress, done, cancelled rather than alphabetically, one row per page", async () => {
    const walked = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        for (const status of ["done", "cancelled", "open", "in-progress"] as const) {
          const task = yield* tasks.create({ title: status, description: "d" });
          if (status !== "open") yield* tasks.update({ id: task.id, status });
        }
        return yield* walkPages(tasks, { limit: 1, sort: [{ field: "status", direction: "asc" }] });
      }),
    );
    expect(walked).toEqual(["open", "in-progress", "done", "cancelled"]);
  });
});

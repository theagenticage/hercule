/**
 * Tests blockers on real rows: adding and removing one through the Task
 * service (`addBlocker`, `removeBlocker`), the loops it refuses and the words
 * of the refusal, what deleting and merging a Task do to its edges, the
 * pre-check of a merge (`checkMerge`), and what the board and the details
 * pane read of the edges.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { MAX_CARD_BLOCKERS, type Grant, type Task, type TaskStage } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { TaskBoardFactsLayer, TaskDetailFactsLayer, TaskServicePortsLayer } from "../daemon/tasks";
import { TaskTrackingRunsLayer } from "../daemon/runs";
import { mintUuid, uuidFromString, uuidToString, withTransaction, type Change } from "../db";
import { buildAnnouncementRecorder } from "../db/testing";
import { PlatformEventsLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { NotifierLayer } from "../notifications";
import { buildPluginStack } from "../plugins/testing";
import { TaskBoard, TaskBoardLayer } from "./board";
import { TaskDetails, TaskDetailsLayer } from "./detail";
import { TaskService, TaskServiceLayer } from "./index";
import { A_MINUTE, USER } from "./testing";

const reads = Layer.mergeAll(TaskBoardLayer, TaskDetailsLayer).pipe(
  Layer.provide(Layer.mergeAll(TaskBoardFactsLayer, TaskTrackingRunsLayer, TaskDetailFactsLayer)),
  Layer.provideMerge(buildPluginStack()),
);

const layer = TaskServiceLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(TaskServicePortsLayer),
  Layer.provideMerge(PlatformEventsLayer),
  Layer.provideMerge(reads),
);

type Deps = TaskService | TaskBoard | TaskDetails | SqlClient.SqlClient;

const buildSessionActor = (grants: ReadonlyArray<Grant>): Actor =>
  ({
    _tag: "session",
    sessionId: "0199e0e7-0002-7000-8000-000000000000",
    profileId: "0199e0e7-0003-7000-8000-000000000000",
    grants,
    profileGrants: grants,
    assistantId: null,
    agentId: null,
  }) as unknown as Actor;

const run = <A, E>(effect: Effect.Effect<A, E, Deps>, actor: Actor = USER) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, actor),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

/** Runs `effect` as the user and returns its value with every change announced after a commit. */
const runRecording = async <A, E>(effect: Effect.Effect<A, E, Deps>) => {
  const { listener, announced } = buildAnnouncementRecorder();
  const value = await run(effect.pipe(Effect.provide(listener)));
  return { value, announced };
};

/** Runs `effect` as the user and returns the error it fails with. */
const runForError = async <A, E>(effect: Effect.Effect<A, E, Deps>): Promise<unknown> => {
  const exit = await run(Effect.exit(effect));
  if (!Exit.isFailure(exit)) throw new Error("the effect was expected to fail");
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag !== "Some") throw new Error("the effect died");
  return failure.value;
};

const createTask = (
  title: string,
  fields: { readonly stage?: TaskStage; readonly projectId?: string } = {},
) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const task = yield* tasks.create({ title, description: "", ...fields });
    yield* TestClock.adjust(A_MINUTE);
    return task;
  });

/** Creates one Task for each title, each at `building`, so none is finished, and returns them in order. */
const createTasks = <const Titles extends ReadonlyArray<string>>(...titles: Titles) =>
  Effect.map(
    Effect.forEach(titles, (title) => createTask(title, { stage: "building" })),
    (created) => created as unknown as { [Index in keyof Titles]: Task },
  );

/** Makes the first Task wait on the second, a minute after the last write. */
const block = (task: { readonly id: string }, blocker: { readonly id: string }) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const result = yield* tasks.addBlocker(task.id, blocker.id);
    yield* TestClock.adjust(A_MINUTE);
    return result;
  });

/** Reads the stored edges as `[waiting, blocker]` pairs of titles, sorted. */
const readEdges = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly waiting: string; readonly blocker: string }>`
    SELECT w.title AS waiting, b.title AS blocker
    FROM task_blockers e JOIN tasks w ON w.id = e.task_id JOIN tasks b ON b.id = e.blocked_by_task_id
    ORDER BY w.title, b.title`;
  return rows.map((row) => [row.waiting, row.blocker]);
});

/** Returns the `changes.blockedBy` of every `task.updated` event of the Task, oldest first. */
const readBlockedByChanges = (taskId: string) =>
  Effect.map(readEventsOfKind("task.updated"), (events) =>
    events.flatMap((event) => {
      const payload = event.payload as {
        taskId: string;
        changes: { blockedBy?: { added: string[]; removed: string[] } };
      };
      return payload.taskId === taskId && payload.changes.blockedBy !== undefined
        ? [payload.changes.blockedBy]
        : [];
    }),
  );

/** Returns the Tasks of the derived `task` announcements, sorted. */
const derivedIds = (announced: ReadonlyArray<Change>) =>
  announced
    .flatMap((change) =>
      change._tag === "record" &&
      change.topic === "task" &&
      change.kind === "updated" &&
      change.derived === true
        ? [change.id]
        : [],
    )
    .toSorted();

describe("adding and removing a blocker", () => {
  it("writes one edge stamped with the caller, and reports it on the waiting Task only", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const waiting = yield* createTask("Ship refund emails");
        const blocker = yield* createTask("Add a refund button");
        const added = yield* block(waiting, blocker);
        const stamps = yield* sql<{ readonly created_by: string }>`
          SELECT created_by FROM task_blockers`;
        return {
          waiting,
          blocker,
          added,
          stamps,
          waitingChanges: yield* readBlockedByChanges(waiting.id),
          blockerChanges: yield* readBlockedByChanges(blocker.id),
        };
      }),
    );
    expect(result.added.changed).toBe(true);
    expect(result.added.task.id).toBe(result.waiting.id);
    expect(result.stamps).toEqual([{ created_by: "user" }]);
    expect(result.waitingChanges).toEqual([{ added: [result.blocker.id], removed: [] }]);
    expect(result.blockerChanges).toEqual([]);
  });

  it("announces both ends as a derived push, so the board and both panes read again", async () => {
    const { value, announced } = await runRecording(
      Effect.gen(function* () {
        const waiting = yield* createTask("Ship refund emails");
        const blocker = yield* createTask("Add a refund button");
        yield* block(waiting, blocker);
        return { waiting, blocker };
      }),
    );
    expect(derivedIds(announced)).toEqual([value.waiting.id, value.blocker.id].toSorted());
  });

  it("does nothing, and announces nothing, for an edge that is there already", async () => {
    const { value, announced } = await runRecording(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const waiting = yield* createTask("Ship refund emails");
        const blocker = yield* createTask("Add a refund button");
        yield* block(waiting, blocker);
        const before = (yield* readEventsOfKind("task.updated")).length;
        const again = yield* tasks.addBlocker(waiting.id, blocker.id);
        return {
          again,
          newEvents: (yield* readEventsOfKind("task.updated")).length - before,
          edges: yield* readEdges,
        };
      }),
    );
    expect(value.again.changed).toBe(false);
    expect(value.newEvents).toBe(0);
    expect(value.edges).toEqual([["Ship refund emails", "Add a refund button"]]);
    expect(derivedIds(announced)).toHaveLength(2);
  });

  it("removes an edge, reports it as removed, and does nothing for an edge that is not there", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const waiting = yield* createTask("Ship refund emails");
        const blocker = yield* createTask("Add a refund button");
        yield* block(waiting, blocker);
        const removed = yield* tasks.removeBlocker(waiting.id, blocker.id);
        const again = yield* tasks.removeBlocker(waiting.id, blocker.id);
        return {
          blocker,
          removed,
          again,
          edges: yield* readEdges,
          changes: yield* readBlockedByChanges(waiting.id),
        };
      }),
    );
    expect(result.removed.changed).toBe(true);
    expect(result.again.changed).toBe(false);
    expect(result.edges).toEqual([]);
    expect(result.changes).toEqual([
      { added: [result.blocker.id], removed: [] },
      { added: [], removed: [result.blocker.id] },
    ]);
  });

  it("refuses a Task that waits on itself, and two ids that stand for one Task", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const survivor = yield* createTask("Survivor");
        const merged = yield* createTask("Merged away");
        yield* tasks.merge(merged.id, { intoTaskId: survivor.id });
        return {
          same: yield* Effect.flip(tasks.addBlocker(survivor.id, survivor.id)),
          viaRedirect: yield* Effect.flip(tasks.addBlocker(survivor.id, merged.id)),
          edges: yield* readEdges,
        };
      }),
    );
    expect(result.same).toMatchObject({ error: { code: "validation" } });
    expect(result.viaRedirect).toMatchObject({ error: { code: "validation" } });
    expect(result.edges).toEqual([]);
  });

  it("fails with not found for a Task that does not exist or is deleted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Ship refund emails");
        const gone = yield* createTask("Gone");
        yield* tasks.delete(gone.id);
        const unknown = mintUuid();
        return {
          waitingUnknown: yield* Effect.flip(tasks.addBlocker(uuidToString(unknown), task.id)),
          blockerUnknown: yield* Effect.flip(tasks.addBlocker(task.id, uuidToString(unknown))),
          blockerDeleted: yield* Effect.flip(tasks.addBlocker(task.id, gone.id)),
          removeDeleted: yield* Effect.flip(tasks.removeBlocker(task.id, gone.id)),
        };
      }),
    );
    for (const error of Object.values(result)) {
      expect(error).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("needs the grant task.update", async () => {
    const error = await runForError(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const a = yield* createTask("A");
        const b = yield* createTask("B");
        return yield* tasks.addBlocker(a.id, b.id);
      }).pipe(Effect.provideService(CurrentActor, buildSessionActor(["task.read"]))),
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });

  it("lets a session with the grant add one, stamped with the session", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const a = yield* createTask("A");
        const b = yield* createTask("B");
        const tasks = yield* TaskService;
        const added = yield* tasks
          .addBlocker(a.id, b.id)
          .pipe(Effect.provideService(CurrentActor, buildSessionActor(["task.update"])));
        const stamps = yield* sql<{ readonly created_by: string }>`
          SELECT created_by FROM task_blockers`;
        return { added, stamps };
      }),
    );
    expect(result.added.changed).toBe(true);
    expect(result.stamps).toEqual([{ created_by: "session:0199e0e7-0002-7000-8000-000000000000" }]);
  });
});

describe("loops of blockers", () => {
  it("refuses a blocker that waits on the Task directly, and names it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const first = yield* createTask("Add a refund button");
        const second = yield* createTask("Ship refund emails");
        yield* block(second, first);
        return {
          error: yield* Effect.flip(tasks.addBlocker(first.id, second.id)),
          edges: yield* readEdges,
        };
      }),
    );
    expect(result.error).toMatchObject({
      error: {
        code: "invalid_state",
        message: "Ship refund emails already waits on this Task.",
        details: { reason: "blocker-cycle" },
      },
    });
    expect(result.edges).toEqual([["Ship refund emails", "Add a refund button"]]);
  });

  it("refuses a long loop, and names the Tasks between in order", async () => {
    const error = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const a = yield* createTask("Plan the rollout");
        const b = yield* createTask("Write the migration");
        const c = yield* createTask("Add a refund button");
        const d = yield* createTask("Ship refund emails");
        // d waits on c, c on b, b on a: adding "a waits on d" closes the loop.
        yield* block(d, c);
        yield* block(c, b);
        yield* block(b, a);
        return yield* Effect.flip(tasks.addBlocker(a.id, d.id));
      }),
    );
    expect(error).toMatchObject({
      error: {
        message:
          "Ship refund emails already waits on this Task, through Add a refund button, Write the migration.",
        details: { reason: "blocker-cycle" },
      },
    });
  });

  it("counts an edge whose blocker has finished, because the stored edges stay a DAG", async () => {
    const error = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const first = yield* createTask("Add a refund button");
        const second = yield* createTask("Ship refund emails");
        yield* block(second, first);
        yield* tasks.update({ id: first.id, stage: "done" });
        return yield* Effect.flip(tasks.addBlocker(first.id, second.id));
      }),
    );
    expect(error).toMatchObject({ error: { details: { reason: "blocker-cycle" } } });
  });

  it("allows a diamond: two paths to one Task are no loop", async () => {
    const edges = await run(
      Effect.gen(function* () {
        const top = yield* createTask("Top");
        const left = yield* createTask("Left");
        const right = yield* createTask("Right");
        const bottom = yield* createTask("Bottom");
        yield* block(top, left);
        yield* block(top, right);
        yield* block(left, bottom);
        yield* block(right, bottom);
        return yield* readEdges;
      }),
    );
    expect(edges).toHaveLength(4);
  });

  it("lets exactly one of two reciprocal writes win when they run together", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const a = yield* createTask("A");
        const b = yield* createTask("B");
        const exits = yield* Effect.all(
          [Effect.exit(tasks.addBlocker(a.id, b.id)), Effect.exit(tasks.addBlocker(b.id, a.id))],
          { concurrency: "unbounded" },
        );
        return { exits, edges: yield* readEdges };
      }),
    );
    expect(result.exits.filter(Exit.isSuccess)).toHaveLength(1);
    expect(result.exits.filter(Exit.isFailure)).toHaveLength(1);
    expect(result.edges).toHaveLength(1);
  });
});

describe("deleting a Task that waits or is waited on", () => {
  it("removes its edges in both directions, reports each, and announces the other ends", async () => {
    const { value, announced } = await runRecording(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const middle = yield* createTask("Middle");
        const upstream = yield* createTask("Upstream");
        const downstream = yield* createTask("Downstream");
        yield* block(middle, upstream);
        yield* block(downstream, middle);
        yield* tasks.delete(middle.id);
        return {
          middle,
          upstream,
          downstream,
          edges: yield* readEdges,
          middleChanges: yield* readBlockedByChanges(middle.id),
          downstreamChanges: yield* readBlockedByChanges(downstream.id),
          upstreamChanges: yield* readBlockedByChanges(upstream.id),
        };
      }),
    );
    expect(value.edges).toEqual([]);
    expect(value.middleChanges.at(-1)).toEqual({ added: [], removed: [value.upstream.id] });
    expect(value.downstreamChanges.at(-1)).toEqual({ added: [], removed: [value.middle.id] });
    expect(value.upstreamChanges).toEqual([]);
    // The Task upstream lists the deleted Task as one it blocks, so its pane reads again too.
    expect(new Set(derivedIds(announced))).toEqual(
      new Set([value.middle.id, value.upstream.id, value.downstream.id]),
    );
  });

  it("frees a card that only the deleted Task held", async () => {
    const card = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const waiting = yield* createTask("Ship refund emails", { stage: "building" });
        const blocker = yield* createTask("Add a refund button", { stage: "building" });
        yield* block(waiting, blocker);
        yield* tasks.delete(blocker.id);
        const board = yield* Effect.flatMap(TaskBoard, (reader) => reader.query());
        return board.cards.find((candidate) => candidate.id === waiting.id)!;
      }),
    );
    expect(card.blockedBy).toEqual([]);
    expect(card.blockedByCount).toBe(0);
  });
});

describe("merging Tasks that have blockers", () => {
  it("refuses a merge that closes a loop, with nothing written", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const [source, middle, survivor] = yield* createTasks("Source", "Middle", "Survivor");
        // Source waits on Middle, and Middle waits on Survivor: one Task once merged.
        yield* block(source, middle);
        yield* block(middle, survivor);
        const countEvents = Effect.map(
          sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM events`,
          (rows) => rows[0]!.n,
        );
        const eventsBefore = yield* countEvents;
        const error = yield* Effect.flip(tasks.merge(source.id, { intoTaskId: survivor.id }));
        return {
          error,
          source,
          newEvents: (yield* countEvents) - eventsBefore,
          edges: yield* readEdges,
          resolved: yield* tasks.resolveTaskId(source.id),
        };
      }),
    );
    expect(result.error).toMatchObject({
      error: {
        code: "invalid_state",
        message: "Merging these Tasks would make Survivor wait on itself, through Middle.",
        details: { reason: "blocker-cycle" },
      },
    });
    expect(result.newEvents).toBe(0);
    expect(result.edges).toEqual([
      ["Middle", "Survivor"],
      ["Source", "Middle"],
    ]);
    expect(result.resolved).toBe(result.source.id);
  });

  it("refuses the loop in the other direction too, and announces nothing", async () => {
    const { listener, announced } = buildAnnouncementRecorder();
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const [source, middle, survivor] = yield* createTasks("Source", "Middle", "Survivor");
        yield* block(survivor, middle);
        yield* block(middle, source);
        const announcedBefore = announced.length;
        const error = yield* Effect.flip(tasks.merge(source.id, { intoTaskId: survivor.id }));
        return { error, newAnnouncements: announced.length - announcedBefore };
      }).pipe(Effect.provide(listener)),
    );
    expect(result.error).toMatchObject({
      error: {
        message: "Merging these Tasks would make Survivor wait on itself, through Middle.",
        details: { reason: "blocker-cycle" },
      },
    });
    expect(result.newAnnouncements).toBe(0);
  });

  it("drops the edge between the two Tasks, which is no loop", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const [source, survivor] = yield* createTasks("Source", "Survivor");
        yield* block(source, survivor);
        const merged = yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        return { merged, survivor, edges: yield* readEdges };
      }),
    );
    expect(result.merged.id).toBe(result.survivor.id);
    expect(result.edges).toEqual([]);
  });

  it("moves the edges onto the survivor, keeps a duplicate once, and reports every change", async () => {
    const { value, announced } = await runRecording(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const [source, survivor, shared, onlySource, dependant, dependsOnBoth] = yield* createTasks(
          "Source",
          "Survivor",
          "Shared blocker",
          "Source blocker",
          "Dependant",
          "Depends on both",
        );
        yield* block(source, shared);
        yield* block(survivor, shared);
        yield* block(source, onlySource);
        yield* block(dependant, source);
        yield* block(dependsOnBoth, source);
        yield* block(dependsOnBoth, survivor);
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        return {
          source,
          survivor,
          shared,
          onlySource,
          dependant,
          dependsOnBoth,
          edges: yield* readEdges,
          survivorChanges: yield* readBlockedByChanges(survivor.id),
          sourceChanges: yield* readBlockedByChanges(source.id),
          dependantChanges: yield* readBlockedByChanges(dependant.id),
          bothChanges: yield* readBlockedByChanges(dependsOnBoth.id),
        };
      }),
    );
    expect(value.edges).toEqual([
      ["Dependant", "Survivor"],
      ["Depends on both", "Survivor"],
      ["Survivor", "Shared blocker"],
      ["Survivor", "Source blocker"],
    ]);
    // The survivor's one `task.updated` of the merge carries the blockers it gained.
    expect(value.survivorChanges).toEqual([
      { added: [value.shared.id], removed: [] },
      { added: [value.onlySource.id], removed: [] },
    ]);
    expect(value.sourceChanges.at(-1)?.added).toEqual([]);
    expect(value.sourceChanges.at(-1)?.removed.toSorted()).toEqual(
      [value.shared.id, value.onlySource.id].toSorted(),
    );
    expect(value.dependantChanges.at(-1)).toEqual({
      added: [value.survivor.id],
      removed: [value.source.id],
    });
    expect(value.bothChanges.at(-1)).toEqual({ added: [], removed: [value.source.id] });
    expect(derivedIds(announced)).toContain(value.dependant.id);
    expect(derivedIds(announced)).toContain(value.onlySource.id);
  });

  it("keeps the stamp of a moved edge", async () => {
    const stamps = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const [source, survivor, blocker] = yield* createTasks("Source", "Survivor", "Blocker");
        yield* tasks
          .addBlocker(source.id, blocker.id)
          .pipe(Effect.provideService(CurrentActor, buildSessionActor(["task.update"])));
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        return yield* sql<{ readonly task_id: Uint8Array; readonly created_by: string }>`
          SELECT task_id, created_by FROM task_blockers`;
      }),
    );
    expect(stamps.map((row) => row.created_by)).toEqual([
      "session:0199e0e7-0002-7000-8000-000000000000",
    ]);
  });

  it("follows an old, merged id when a blocker is added", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const [source, survivor, other, third] = yield* createTasks(
          "Source",
          "Survivor",
          "Other",
          "Third",
        );
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        const waits = yield* tasks.addBlocker(source.id, other.id);
        const isWaitedOn = yield* tasks.addBlocker(third.id, source.id);
        return { survivor, waits, isWaitedOn, edges: yield* readEdges };
      }),
    );
    expect(result.waits.task.id).toBe(result.survivor.id);
    expect(result.waits.changed).toBe(true);
    expect(result.isWaitedOn.changed).toBe(true);
    expect(result.edges).toEqual([
      ["Survivor", "Other"],
      ["Third", "Survivor"],
    ]);
  });
});

describe("checking a merge before it is made", () => {
  it("returns no refusal for a merge that would go ahead, and writes nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const [source, survivor, blocker] = yield* createTasks("Source", "Survivor", "Blocker");
        yield* block(source, blocker);
        const check = yield* tasks.checkMerge(source.id, survivor.id);
        return {
          check,
          edges: yield* readEdges,
          resolved: yield* tasks.resolveTaskId(source.id),
          source,
        };
      }),
    );
    expect(result.check).toEqual({});
    expect(result.edges).toEqual([["Source", "Blocker"]]);
    expect(result.resolved).toBe(result.source.id);
  });

  it("returns the refusal the merge fails with, whatever the reason", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const [source, middle, survivor, finished] = yield* createTasks(
          "Source",
          "Middle",
          "Survivor",
          "Finished",
        );
        yield* tasks.update({ id: finished.id, stage: "done" });
        yield* block(source, middle);
        yield* block(middle, survivor);
        const unknown = uuidToString(mintUuid());
        const cases = {
          loop: [source.id, survivor.id],
          sameTask: [source.id, source.id],
          finished: [source.id, finished.id],
          unknown: [source.id, unknown],
        } as const;
        const outcomes: Record<string, { refusal: string | undefined; failure: unknown }> = {};
        for (const [name, [from, into]] of Object.entries(cases)) {
          const check = yield* tasks.checkMerge(from, into);
          const failure = yield* Effect.flip(tasks.merge(from, { intoTaskId: into }));
          outcomes[name] = { refusal: check.refusal, failure };
        }
        return outcomes;
      }),
    );
    for (const outcome of Object.values(result)) {
      expect(outcome.refusal).toBeDefined();
      const failure = outcome.failure as {
        error: { message: string; details?: { issues?: Array<{ message: string }> } };
      };
      expect(outcome.refusal).toBe(
        failure.error.details?.issues?.[0]?.message ?? failure.error.message,
      );
    }
    expect(result.loop!.refusal).toBe(
      "Merging these Tasks would make Survivor wait on itself, through Middle.",
    );
  });

  it("returns a refusal, never a defect, when a Task is deleted between the reads of the check", async () => {
    const check = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* TaskService;
        const [source, survivor] = yield* createTasks("Source", "Survivor");
        // Deletes the survivor just before the check reads the Task row, after
        // it has read the survivor's state. The deletion runs once.
        let deleted = false;
        return yield* tasks.checkMerge(source.id, survivor.id).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.gen(function* () {
              const [text] = statement.compile();
              if (!deleted && text.includes("FROM tasks") && text.includes("labels")) {
                deleted = true;
                yield* withTransaction(
                  sql,
                  sql`UPDATE tasks SET deleted_at = '2026-11-01T09:00:00.000Z'
                      WHERE id = ${uuidFromString(survivor.id)}`,
                ).pipe(
                  Effect.provideService(Statement.CurrentTransformer, (inner) =>
                    Effect.succeed(inner),
                  ),
                );
              }
              return statement;
            }).pipe(Effect.orDie),
          ),
        );
      }),
    );
    expect(check).toEqual({ refusal: "no such task" });
  });

  it("needs only task.read, so a session that may not merge can still check", async () => {
    const check = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const [source, survivor] = yield* createTasks("Source", "Survivor");
        return yield* tasks
          .checkMerge(source.id, survivor.id)
          .pipe(Effect.provideService(CurrentActor, buildSessionActor(["task.read"])));
      }),
    );
    expect(check).toEqual({});
  });
});

describe("announcing the Tasks on the other end of an edge when a Task is edited", () => {
  /**
   * Builds the chain Downstream waits on Middle waits on Upstream, plus a
   * Task with no edges, applies `patch` to Middle, and returns the Tasks and
   * the derived announcements the edit made (not those of building the chain).
   */
  const editMiddle = async (patch: { readonly title?: string; readonly priority?: "high" }) => {
    const { listener, announced } = buildAnnouncementRecorder();
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const [upstream, middle, downstream, stranger] = yield* createTasks(
          "Upstream",
          "Middle",
          "Downstream",
          "Stranger",
        );
        yield* block(middle, upstream);
        yield* block(downstream, middle);
        const announcedBefore = announced.length;
        yield* tasks.update({ id: middle.id, ...patch });
        return {
          upstream,
          middle,
          downstream,
          stranger,
          derived: derivedIds(announced.slice(announcedBefore)),
        };
      }).pipe(Effect.provide(listener)),
    );
    return result;
  };

  it("announces the Tasks on both ends of its edges as derived pushes when its title changes", async () => {
    const result = await editMiddle({ title: "Middle, renamed" });
    expect(result.derived).toEqual([result.upstream.id, result.downstream.id].toSorted());
  });

  it("does so when its stage changes", async () => {
    const { listener, announced } = buildAnnouncementRecorder();
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const [upstream, middle] = yield* createTasks("Upstream", "Middle");
        yield* block(middle, upstream);
        const announcedBefore = announced.length;
        yield* tasks.update({ id: middle.id, stage: "in-review" });
        return { upstream, derived: derivedIds(announced.slice(announcedBefore)) };
      }).pipe(Effect.provide(listener)),
    );
    expect(result.derived).toEqual([result.upstream.id]);
  });

  it("announces no neighbour when a field its neighbours do not show changes", async () => {
    const result = await editMiddle({ priority: "high" });
    expect(result.derived).toEqual([]);
  });
});

describe("what the board and the pane read of blockers", () => {
  it("lists on a card the blockers that still block it, with titles from other projects", async () => {
    const card = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projectId = uuidToString(mintUuid());
        yield* withTransaction(
          sql,
          sql`INSERT INTO projects (id, name, created_at, updated_at)
              VALUES (${uuidFromString(projectId)}, 'Storefront', '2026-11-01T09:00:00.000Z',
                      '2026-11-01T09:00:00.000Z')`,
        );
        const [waiting] = yield* createTasks("Ship refund emails");
        const elsewhere = yield* createTask("Add a refund button", { stage: "planned", projectId });
        yield* block(waiting, elsewhere);
        const board = yield* Effect.flatMap(TaskBoard, (reader) => reader.query());
        return { card: board.cards.find((candidate) => candidate.id === waiting.id)!, elsewhere };
      }),
    );
    expect(card.card.blockedBy).toEqual([
      { id: card.elsewhere.id, title: "Add a refund button", stage: "planned" },
    ]);
    expect(card.card.blockedByCount).toBe(1);
  });

  it("cuts a card's blockers at the most a card lists, in the order they were added, and counts all", async () => {
    const result = await run(
      Effect.gen(function* () {
        const waiting = yield* createTask("Waits on many", { stage: "building" });
        const total = MAX_CARD_BLOCKERS + 2;
        const added: Array<Task> = [];
        for (let index = 0; index < total; index += 1) {
          const blocker = yield* createTask(`Blocker ${String(index)}`, { stage: "exploring" });
          yield* block(waiting, blocker);
          added.push(blocker);
        }
        const board = yield* Effect.flatMap(TaskBoard, (reader) => reader.query());
        return {
          card: board.cards.find((candidate) => candidate.id === waiting.id)!,
          added,
          total,
        };
      }),
    );
    expect(result.card.blockedBy.map((blocker) => blocker.id)).toEqual(
      result.added.slice(0, MAX_CARD_BLOCKERS).map((task) => task.id),
    );
    expect(result.card.blockedByCount).toBe(result.total);
  });

  it("stops counting a blocker that has landed, finished or been dropped, but keeps the edge in the pane", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const details = yield* TaskDetails;
        const waiting = yield* createTask("Waits", { stage: "building" });
        const landed = yield* createTask("Landed blocker", { stage: "building" });
        const done = yield* createTask("Done blocker", { stage: "building" });
        const dropped = yield* createTask("Dropped blocker", { stage: "building" });
        const open = yield* createTask("Open blocker", { stage: "building" });
        for (const blocker of [landed, done, dropped, open]) yield* block(waiting, blocker);
        yield* tasks.update({ id: landed.id, stage: "landed" });
        yield* tasks.update({ id: done.id, stage: "done" });
        yield* tasks.update({ id: dropped.id, stage: "dropped" });
        const board = yield* Effect.flatMap(TaskBoard, (reader) => reader.query());
        const detail = yield* details.read(waiting.id);
        return {
          card: board.cards.find((candidate) => candidate.id === waiting.id)!,
          detail,
          open,
        };
      }),
    );
    expect(result.card.blockedBy.map((blocker) => blocker.id)).toEqual([result.open.id]);
    expect(result.card.blockedByCount).toBe(1);
    // The pane's own card agrees with the board's.
    expect(result.detail.card.blockedBy).toEqual(result.card.blockedBy);
    expect(result.detail.card.blockedByCount).toBe(1);
    expect(result.detail.blockers.map((blocker) => [blocker.title, blocker.stage])).toEqual([
      ["Landed blocker", "landed"],
      ["Done blocker", "done"],
      ["Dropped blocker", "dropped"],
      ["Open blocker", "building"],
    ]);
    expect(result.detail.blockerCount).toBe(4);
  });

  it("lists in the pane both the Tasks it waits on and the Tasks that wait on it", async () => {
    const detail = await run(
      Effect.gen(function* () {
        const details = yield* TaskDetails;
        const [middle, upstream, downstream] = yield* createTasks(
          "Middle",
          "Upstream",
          "Downstream",
        );
        yield* block(middle, upstream);
        yield* block(downstream, middle);
        return yield* details.read(middle.id);
      }),
    );
    expect(detail.blockers.map((blocker) => blocker.title)).toEqual(["Upstream"]);
    expect(detail.blocks.map((blocker) => blocker.title)).toEqual(["Downstream"]);
    expect([detail.blockerCount, detail.blockCount]).toEqual([1, 1]);
  });

  it("reads the blockers of every card in one statement, whatever the number of cards", async () => {
    const counts = await run(
      Effect.gen(function* () {
        const board = Effect.flatMap(TaskBoard, (reader) => reader.query());
        const countStatements = Effect.gen(function* () {
          let count = 0;
          yield* board.pipe(
            Effect.provideService(Statement.CurrentTransformer, (statement) =>
              Effect.sync(() => {
                count += 1;
                return statement;
              }),
            ),
          );
          return count;
        });
        const blocker = yield* createTask("Blocker", { stage: "building" });
        const first = yield* countStatements;
        for (let index = 0; index < 5; index += 1) {
          const waiting = yield* createTask(`Waiting ${String(index)}`, { stage: "building" });
          yield* block(waiting, blocker);
        }
        return { first, second: yield* countStatements };
      }),
    );
    expect(counts.second).toBe(counts.first);
  });

  it("reads the edges of the listed cards by the primary key of task_blockers, not by a scan", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const blocker = yield* createTask("Blocker", { stage: "building" });
        const waiting = yield* createTask("Waiting", { stage: "building" });
        yield* block(waiting, blocker);
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* Effect.flatMap(TaskBoard, (reader) => reader.query()).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile());
              return statement;
            }),
          ),
        );
        const [text, params] = statements.find(([text]) => text.includes("task_blockers"))!;
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params,
        );
        return rows.map((row) => row.detail);
      }),
    );
    expect(plan.some((step) => step === "SEARCH task_blockers USING PRIMARY KEY (task_id=?)")).toBe(
      true,
    );
    expect(plan.some((step) => step.startsWith("SCAN task_blockers"))).toBe(false);
  });
});

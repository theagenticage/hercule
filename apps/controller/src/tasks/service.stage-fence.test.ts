/**
 * Tests which stage writes a Task takes, through the Task service on real
 * rows: a write that comes from a fact moves the Task only when the fact is
 * newer than everything a person has decided, and a stage that a person or an
 * agent writes overrules every fact recorded so far.
 *
 * One table holds the cases, one row per line of the table in spec 09 ("Facts
 * and the fence") and then the rows of the rules around it. Each row plays a
 * story on a fresh database and then reads the Task's stage, fence and cause,
 * and what each delivery of a fact did. The facts come from the code that
 * writes them: a link (`create`, `update`) and an entity write
 * (`recordEntityFacts`), never from hand-written rows. A link and an unlink
 * go through `linkEntity` and `unlinkEntity`.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import type { ExternalRef, TaskStage } from "@hercule/contract";
import { uuidFromString, uuidToString } from "../db";
import { readEventsOfKind } from "../events/testing";
import { TaskService } from "./index";
import {
  A_MINUTE,
  arrange,
  arrangeConnection,
  pr,
  readFacts,
  run,
  setAccess,
  setLifecycle,
  writeEntities,
  type ArrangedRecord,
} from "./testing";

/** What one delivery of a fact did to the Task. */
type WriteKind =
  /** Nothing was written: not the stage, not the fence, no event. */
  | "nothing"
  /** Only the fence moved. */
  | "fence-only"
  /** The stage changed, with its event and revision. */
  | "moved"
  /** The write failed with a `Validation` error that names `stageFactId`. */
  | "refused-as-invalid"
  | "something else";

interface StageState {
  readonly stage: TaskStage;
  readonly fence: number;
  readonly cause: number | null;
}

interface Outcome extends StageState {
  /** What each delivery of a fact did, in order. */
  readonly deliveries: ReadonlyArray<WriteKind>;
}

/** Records what a delivery did to the Task, for the story to return. */
type Deliver = (
  taskId: string,
  delivery: Effect.Effect<unknown, unknown, TaskService | SqlClient.SqlClient>,
) => Effect.Effect<void, never, TaskService | SqlClient.SqlClient>;

interface Observation extends StageState {
  readonly revision: number;
  readonly updatedAt: string;
  readonly stageRevision: number;
  readonly updatedEvents: number;
}

const readObservation = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      readonly stage: TaskStage;
      readonly revision: number;
      readonly updated_at: string;
      readonly stage_revision: number;
      readonly stage_fact_fence: number;
      readonly stage_cause_fact_id: number | null;
    }>`SELECT stage, revision, updated_at, stage_revision, stage_fact_fence, stage_cause_fact_id
       FROM tasks WHERE id = ${uuidFromString(taskId)}`;
    const updatedEvents = (yield* readEventsOfKind("task.updated")).filter(
      (event) => event.payload["taskId"] === taskId,
    ).length;
    return {
      stage: row!.stage,
      fence: row!.stage_fact_fence,
      cause: row!.stage_cause_fact_id,
      revision: row!.revision,
      updatedAt: row!.updated_at,
      stageRevision: row!.stage_revision,
      updatedEvents,
    } satisfies Observation;
  });

/**
 * Tells what happened to the Task between two observations of it. A write
 * that comes from a fact never raises the stage revision or the revision,
 * because a fact is not someone deciding or editing: any change of them is
 * "something else".
 */
const classifyWrite = (before: Observation, after: Observation): WriteKind => {
  const sameRow = before.revision === after.revision && before.updatedAt === after.updatedAt;
  const noEvent = before.updatedEvents === after.updatedEvents;
  const sameStageRevision = before.stageRevision === after.stageRevision;
  if (sameRow && noEvent && sameStageRevision && before.stage === after.stage) {
    return before.fence === after.fence ? "nothing" : "fence-only";
  }
  if (
    sameStageRevision &&
    before.stage !== after.stage &&
    after.revision === before.revision &&
    after.updatedEvents === before.updatedEvents + 1
  ) {
    return "moved";
  }
  return "something else";
};

/** Returns true when `error` is the `Validation` error that a bad `stageFactId` gets. */
const isStageFactRefusal = (error: unknown): boolean => {
  const issues = (
    error as {
      error?: {
        code?: string;
        details?: { issues?: ReadonlyArray<{ path: ReadonlyArray<string> }> };
      };
    }
  ).error;
  return (
    issues?.code === "validation" &&
    issues.details?.issues?.some((issue) => issue.path.join(".") === "stageFactId") === true
  );
};

/** Creates a Task at `stage` that links `refs`, a minute after the last write. */
const createTaskAt = (stage: TaskStage, ...refs: ReadonlyArray<ExternalRef>) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    return yield* tasks.create({
      title: `At ${stage}`,
      description: "",
      stage,
      provenance: refs.map((ref) => ({ ref })),
    });
  });

/** Sends the stage write a workflow sends when a fact arrives. */
const deliverFact = (
  taskId: string,
  factId: number,
  stage: TaskStage,
  options: { readonly onlyWhenLinkedWorkFinished?: true } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    return yield* tasks.update({ id: taskId, stage, stageFactId: factId, ...options });
  });

/** Takes away a Task's link by hand, as a person does. */
const unlink = (taskId: string, ref: ExternalRef) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    yield* tasks.unlinkEntity({ id: taskId, ref });
  });

/** Links the Task to `ref` by hand, as a person does. */
const relink = (taskId: string, ref: ExternalRef) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    yield* tasks.linkEntity({ id: taskId, ref });
  });

/** Returns the id of the newest fact. */
const readNewestFactId = Effect.map(readFacts, (facts) => facts.at(-1)!.id);

interface Row {
  readonly name: string;
  /** Plays the story and returns the id of the Task it is about. */
  readonly story: (
    deliver: Deliver,
  ) => Effect.Effect<string, unknown, TaskService | SqlClient.SqlClient>;
  readonly expected: Outcome;
}

const open = (number: number): ArrangedRecord => ({ ref: pr(number), lifecycle: "open" });
const completed = (number: number): ArrangedRecord => ({ ref: pr(number), lifecycle: "completed" });

/**
 * The rows. Fact ids can be read off each story: a Task that is created
 * with links gets one fact per link that has a lifecycle, in the order of the
 * links, and each entity write after that gets the next ids.
 */
const ROWS: ReadonlyArray<Row> = [
  {
    name: "a fact committed before a drag, delivered after it, is refused",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1)); // fact 1
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* tasks.move({ id: task.id, stage: "planned" });
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "planned", fence: 2, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "the same fact twice is applied once",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "in-review", fence: 2, cause: 2, deliveries: ["moved", "nothing"] },
  },
  {
    name: "a replayed run does not undo a drag made after the first run",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        yield* tasks.move({ id: task.id, stage: "planned" });
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "planned", fence: 2, cause: null, deliveries: ["moved", "nothing"] },
  },
  {
    name: "two facts of one poll have different ids and apply in order",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1), open(2));
        const task = yield* createTaskAt("building", pr(1), pr(2)); // facts 1, 2
        yield* writeEntities(
          [pr(1), pr(2)],
          Effect.andThen(setLifecycle(pr(1), "completed"), setLifecycle(pr(2), "abandoned")),
        ); // facts 3, 4, one poll
        yield* deliver(task.id, deliverFact(task.id, 3, "in-review"));
        yield* deliver(task.id, deliverFact(task.id, 4, "landed"));
        return task.id;
      }),
    expected: { stage: "landed", fence: 4, cause: 4, deliveries: ["moved", "moved"] },
  },
  {
    name: "two facts delivered in reverse order: the newer applies, the older is refused",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1), open(2));
        const task = yield* createTaskAt("building", pr(1), pr(2));
        yield* writeEntities(
          [pr(1), pr(2)],
          Effect.andThen(setLifecycle(pr(1), "completed"), setLifecycle(pr(2), "abandoned")),
        ); // facts 3, 4
        yield* deliver(task.id, deliverFact(task.id, 4, "landed"));
        yield* deliver(task.id, deliverFact(task.id, 3, "in-review"));
        return task.id;
      }),
    expected: { stage: "landed", fence: 4, cause: 4, deliveries: ["moved", "nothing"] },
  },
  {
    name: "a newer fact that asks for the stage already held moves the fence, so the older fact is refused",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1), open(2));
        const task = yield* createTaskAt("landed", pr(1), pr(2));
        yield* writeEntities(
          [pr(1), pr(2)],
          Effect.andThen(setLifecycle(pr(1), "completed"), setLifecycle(pr(2), "abandoned")),
        ); // facts 3, 4
        yield* deliver(task.id, deliverFact(task.id, 4, "landed"));
        yield* deliver(task.id, deliverFact(task.id, 3, "in-review"));
        return task.id;
      }),
    expected: { stage: "landed", fence: 4, cause: null, deliveries: ["fence-only", "nothing"] },
  },
  {
    name: "a new fact after a drag applies",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* tasks.move({ id: task.id, stage: "planned" });
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "open")); // fact 3
        yield* deliver(task.id, deliverFact(task.id, 3, "in-review"));
        return task.id;
      }),
    expected: { stage: "in-review", fence: 3, cause: 3, deliveries: ["moved"] },
  },
  {
    name: "a clock that steps back changes nothing: facts apply in the order of their ids",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* TestClock.setTime(0);
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "abandoned")); // fact 3, observed earlier
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        yield* deliver(task.id, deliverFact(task.id, 3, "landed"));
        return task.id;
      }),
    expected: { stage: "landed", fence: 3, cause: 3, deliveries: ["moved", "moved"] },
  },
  {
    name: "a Task unlinked before delivery is not moved: the fact is voided",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* unlink(task.id, pr(1));
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "building", fence: 0, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "unlinked and linked again, the old fact arrives before the relink's fact and moves nothing; the relink's fact applies",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* unlink(task.id, pr(1));
        yield* relink(task.id, pr(1)); // fact 3
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        yield* deliver(task.id, deliverFact(task.id, 3, "in-review"));
        return task.id;
      }),
    expected: { stage: "in-review", fence: 3, cause: 3, deliveries: ["nothing", "moved"] },
  },
  {
    name: "a Task the user marked Done is never moved by a fact",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* tasks.update({ id: task.id, stage: "done" });
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "done", fence: 2, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "a Task finished by a fact is not brought back by a newer fact",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "open")); // fact 3
        yield* deliver(task.id, deliverFact(task.id, 2, "done"));
        yield* deliver(task.id, deliverFact(task.id, 3, "in-review"));
        return task.id;
      }),
    expected: { stage: "done", fence: 2, cause: 2, deliveries: ["moved", "nothing"] },
  },
  {
    name: "two linked pull requests, one merged: the card does not land",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1), open(2));
        const task = yield* createTaskAt("in-review", pr(1), pr(2)); // facts 1, 2
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 3
        yield* deliver(
          task.id,
          deliverFact(task.id, 3, "landed", { onlyWhenLinkedWorkFinished: true }),
        );
        return task.id;
      }),
    expected: { stage: "in-review", fence: 0, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "the second merges and a third thing stays open: the card does not land",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1), open(2), open(3));
        const task = yield* createTaskAt("in-review", pr(1), pr(2), pr(3));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed"));
        yield* writeEntities([pr(2)], setLifecycle(pr(2), "completed")); // fact 5
        yield* deliver(
          task.id,
          deliverFact(task.id, 5, "landed", { onlyWhenLinkedWorkFinished: true }),
        );
        return task.id;
      }),
    expected: { stage: "in-review", fence: 0, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "everything merged or completed and one link abandoned: the card lands",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1), open(2));
        const task = yield* createTaskAt("in-review", pr(1), pr(2));
        yield* writeEntities([pr(2)], setLifecycle(pr(2), "abandoned")); // fact 3
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 4
        yield* deliver(
          task.id,
          deliverFact(task.id, 4, "landed", { onlyWhenLinkedWorkFinished: true }),
        );
        return task.id;
      }),
    expected: { stage: "landed", fence: 4, cause: 4, deliveries: ["moved"] },
  },
  {
    name: "every link abandoned: nothing moves",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1), open(2));
        const task = yield* createTaskAt("in-review", pr(1), pr(2));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "abandoned"));
        yield* writeEntities([pr(2)], setLifecycle(pr(2), "abandoned")); // fact 4
        yield* deliver(
          task.id,
          deliverFact(task.id, 4, "landed", { onlyWhenLinkedWorkFinished: true }),
        );
        return task.id;
      }),
    expected: { stage: "in-review", fence: 0, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "a link added after the last fact and before its run: the write counts again and does not land",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1), open(2));
        const task = yield* createTaskAt("in-review", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* relink(task.id, pr(2)); // fact 3: a new open link
        yield* deliver(
          task.id,
          deliverFact(task.id, 2, "landed", { onlyWhenLinkedWorkFinished: true }),
        );
        return task.id;
      }),
    expected: { stage: "in-review", fence: 0, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "the only completed link removed before an abandoned link's fact runs: nothing moves",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(completed(1), open(2));
        const task = yield* createTaskAt("in-review", pr(1), pr(2));
        yield* writeEntities([pr(2)], setLifecycle(pr(2), "abandoned")); // fact 3
        yield* unlink(task.id, pr(1));
        yield* deliver(
          task.id,
          deliverFact(task.id, 3, "landed", { onlyWhenLinkedWorkFinished: true }),
        );
        return task.id;
      }),
    expected: { stage: "in-review", fence: 0, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "a completed link unreadable and then readable with the same lifecycle lands the card with its own fact",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "completed", access: "inaccessible" });
        const task = yield* createTaskAt("in-review", pr(1));
        yield* writeEntities([pr(1)], setAccess(pr(1), "ok")); // fact 2
        yield* deliver(
          task.id,
          deliverFact(task.id, 2, "landed", { onlyWhenLinkedWorkFinished: true }),
        );
        return task.id;
      }),
    expected: { stage: "landed", fence: 2, cause: 2, deliveries: ["moved"] },
  },
  {
    name: "the last open link unlinked lands the card with its own fact",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(completed(1), open(2));
        const task = yield* createTaskAt("in-review", pr(1), pr(2)); // facts 1, 2
        yield* unlink(task.id, pr(2)); // fact 3, for the completed link
        yield* deliver(
          task.id,
          deliverFact(task.id, yield* readNewestFactId, "landed", {
            onlyWhenLinkedWorkFinished: true,
          }),
        );
        return task.id;
      }),
    expected: { stage: "landed", fence: 3, cause: 3, deliveries: ["moved"] },
  },
  {
    name: "a fact that does not exist is refused as invalid",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* deliver(task.id, deliverFact(task.id, 999, "in-review"));
        return task.id;
      }),
    expected: { stage: "building", fence: 0, cause: null, deliveries: ["refused-as-invalid"] },
  },
  {
    name: "a fact of another Task is refused as invalid",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1), open(2));
        const task = yield* createTaskAt("building", pr(1)); // fact 1
        yield* createTaskAt("building", pr(2)); // fact 2, of the other Task
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "building", fence: 0, cause: null, deliveries: ["refused-as-invalid"] },
  },
  {
    name: "a drag to the stage the card is in moves the fence",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* tasks.move({ id: task.id, stage: "building" });
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "building", fence: 2, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "an update to the stage the card is in moves the fence",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* tasks.update({ id: task.id, stage: "building" });
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "building", fence: 2, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "a reorder inside a column does not move the fence",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        const other = yield* createTaskAt("building");
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* tasks.move({ id: task.id, afterTaskId: other.id });
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "in-review", fence: 2, cause: 2, deliveries: ["moved"] },
  },
  {
    name: "a legacy status write that changes the stage moves the fence",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* tasks.update({ id: task.id, status: "open" }); // building to planned
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "planned", fence: 2, cause: null, deliveries: ["nothing"] },
  },
  {
    name: "a legacy status write that leaves the stage as it is does not move the fence",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* tasks.update({ id: task.id, status: "in-progress" }); // building stays
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        return task.id;
      }),
    expected: { stage: "in-review", fence: 2, cause: 2, deliveries: ["moved"] },
  },
  {
    name: "a fact that asks for the stage already held moves the fence and keeps the cause",
    story: (deliver) =>
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(open(1), open(2));
        const task = yield* createTaskAt("building", pr(1), pr(2));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 3
        yield* writeEntities([pr(2)], setLifecycle(pr(2), "completed")); // fact 4
        yield* deliver(task.id, deliverFact(task.id, 3, "in-review"));
        yield* deliver(task.id, deliverFact(task.id, 4, "in-review"));
        return task.id;
      }),
    expected: { stage: "in-review", fence: 4, cause: 3, deliveries: ["moved", "fence-only"] },
  },
  {
    name: "a fact that moves the card sets the cause, and a drag clears it",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1));
        const task = yield* createTaskAt("building", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        yield* deliver(task.id, deliverFact(task.id, 2, "in-review"));
        const placed = yield* readObservation(task.id);
        expect(placed.cause).toBe(2);
        yield* tasks.move({ id: task.id, stage: "planned" });
        return task.id;
      }),
    expected: { stage: "planned", fence: 2, cause: null, deliveries: ["moved"] },
  },
  {
    name: "a merge overrules a fact queued before it, and a fact after the merge applies",
    story: (deliver) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1), open(2));
        const merged = yield* createTaskAt("building", pr(1)); // fact 1
        const survivor = yield* createTaskAt("planned", pr(2)); // fact 2
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 3, queued
        yield* TestClock.adjust(A_MINUTE);
        yield* tasks.merge(merged.id, { intoTaskId: survivor.id });
        // The old id reaches the survivor, and the fact moved with the link.
        yield* deliver(merged.id, deliverFact(merged.id, 3, "in-review"));
        yield* writeEntities([pr(2)], setLifecycle(pr(2), "completed")); // fact 4
        yield* deliver(survivor.id, deliverFact(survivor.id, 4, "in-review"));
        return survivor.id;
      }),
    expected: { stage: "in-review", fence: 4, cause: 4, deliveries: ["nothing", "moved"] },
  },
];

describe("a stage write that comes from a fact, and the stage writes that overrule facts", () => {
  it.each(ROWS)("$name", async ({ story, expected }) => {
    const outcome = await run(
      Effect.gen(function* () {
        const deliveries: Array<WriteKind> = [];
        const deliver: Deliver = (taskId, delivery) =>
          Effect.gen(function* () {
            const survivorId = (yield* Effect.flatMap(TaskService, (tasks) =>
              Effect.orDie(tasks.read(taskId)),
            )).id;
            const before = yield* readObservation(survivorId);
            const kind = yield* Effect.matchEffect(delivery, {
              onFailure: (error) =>
                Effect.succeed<WriteKind>(
                  isStageFactRefusal(error) ? "refused-as-invalid" : "something else",
                ),
              onSuccess: () =>
                Effect.map(readObservation(survivorId), (after) => classifyWrite(before, after)),
            });
            deliveries.push(kind);
          }).pipe(Effect.orDie);
        const taskId = yield* story(deliver);
        const { stage, fence, cause } = yield* readObservation(
          (yield* Effect.flatMap(TaskService, (tasks) => tasks.read(taskId))).id,
        );
        return { stage, fence, cause, deliveries } satisfies Outcome;
      }),
    );
    expect(outcome).toEqual(expected);
  });
});

describe("a stage write that counts the links it adds", () => {
  it("does not land a card in the same call that links an open thing", async () => {
    const { stage, linkedRefs } = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(completed(1), open(2));
        const task = yield* createTaskAt("in-review", pr(1)); // fact 1
        yield* TestClock.adjust(A_MINUTE);
        const written = yield* tasks.update({
          id: task.id,
          stage: "landed",
          stageFactId: 1,
          onlyWhenLinkedWorkFinished: true,
          provenance: [{ ref: pr(2) }],
        });
        return {
          stage: written.stage,
          linkedRefs: written.provenance.flatMap((entry) => (entry.ref ? [entry.ref] : [])),
        };
      }),
    );
    expect(stage).toBe("in-review");
    expect(linkedRefs).toEqual([pr(1), pr(2)]);
  });

  it("lands the card when the link it adds is completed too", async () => {
    const stage = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(completed(1), completed(2));
        const task = yield* createTaskAt("in-review", pr(1)); // fact 1
        yield* TestClock.adjust(A_MINUTE);
        return (yield* tasks.update({
          id: task.id,
          stage: "landed",
          stageFactId: 1,
          onlyWhenLinkedWorkFinished: true,
          provenance: [{ ref: pr(2) }],
        })).stage;
      }),
    );
    expect(stage).toBe("landed");
  });
});

describe("a merge and the facts and unlink records of the Tasks", () => {
  it("gives the survivor the facts, keeps a voided fact voided, and lets a link win over an unlink record", async () => {
    const state = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange(open(1), open(2), open(3));
        const source = yield* createTaskAt("building", pr(1), pr(2)); // facts 1, 2
        const survivor = yield* createTaskAt("building", pr(1), pr(3)); // facts 3, 4
        // Both Tasks unlinked pr(1), so the merge has to record it once.
        yield* unlink(source.id, pr(1));
        yield* unlink(survivor.id, pr(1));
        // The survivor unlinked pr(3), and the source links it: the link wins.
        yield* unlink(survivor.id, pr(3));
        yield* relink(source.id, pr(3)); // fact 5
        yield* TestClock.adjust(A_MINUTE);
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        const factRows = yield* sql<{
          readonly id: number;
          readonly task_id: Uint8Array;
          readonly voided_at: string | null;
        }>`SELECT id, task_id, voided_at FROM task_entity_facts ORDER BY id`;
        const records = yield* sql<{ readonly task_id: Uint8Array; readonly ref: string }>`
          SELECT task_id, ref FROM task_entity_link_suppressions ORDER BY ref`;
        return {
          survivorId: survivor.id,
          owners: new Set(factRows.map((fact) => uuidToString(fact.task_id))),
          voidedIds: factRows.filter((fact) => fact.voided_at !== null).map((fact) => fact.id),
          records: records.map((record) => ({
            taskId: uuidToString(record.task_id),
            ref: record.ref,
          })),
        };
      }),
    );
    expect([...state.owners]).toEqual([state.survivorId]);
    expect(state.voidedIds).toEqual([1, 3, 4]);
    expect(state.records).toEqual([{ taskId: state.survivorId, ref: pr(1) }]);
  });
});

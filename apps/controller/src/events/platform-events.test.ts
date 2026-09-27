import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Task } from "@hercule/contract";
import { AfterCommit, type Change } from "../db";
import { withTransaction } from "../db/client";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "./audit-log";
import { readPipelineEventsAfter } from "./log";
import { PlatformEvents, PlatformEventsLayer, type PlatformEvent } from "./platform-events";

const AT = "2026-09-27T09:30:00.000Z";
const RUN_ID = "0199f0b7-0000-7000-8000-00000000a001";
const WORKFLOW_ID = "0199f0b7-0000-7000-8000-00000000b001";
const TASK_ID = "0199f0b7-0000-7000-8000-00000000c001";
const SESSION_ACTOR = "session:0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" as const;

const TASK: Task = {
  id: TASK_ID,
  title: "Fix the lid",
  description: "It does not close.",
  status: "open",
  priority: "normal",
  labels: ["hardware"],
  provenance: [{ ref: "github:issue:o/r#42", at: AT, actor: "user" }],
  createdAt: AT,
  updatedAt: AT,
  statusChangedAt: AT,
};

const RUN_COMPLETED: PlatformEvent = {
  kind: "run.completed",
  actor: null,
  at: AT,
  payload: {
    runId: RUN_ID,
    workflowId: WORKFLOW_ID,
    origin: { kind: "manual", actor: "user" },
    inputs: { title: "Fix the lid" },
    startedAt: "2026-09-27T09:29:00.000Z",
    finishedAt: AT,
    output: { released: true },
  },
};

const TASK_CREATED: PlatformEvent = {
  kind: "task.created",
  actor: SESSION_ACTOR,
  at: AT,
  payload: { task: TASK },
};

const TASK_UPDATED: PlatformEvent = {
  kind: "task.updated",
  actor: "user",
  at: AT,
  payload: { taskId: TASK_ID, changes: { status: { old: "open", new: "done" } } },
};

type Deps = PlatformEvents | AuditLog | SqlClient.SqlClient;

/**
 * Runs `effect` against a fresh database, and returns its value with every
 * change announced after a commit, in order. The listener stands in for the
 * live socket, which is the only other thing that receives announcements.
 */
const runRecordingAnnouncements = async <A, E>(
  effect: Effect.Effect<A, E, Deps>,
): Promise<{ readonly value: A; readonly announced: ReadonlyArray<Change> }> => {
  const announced: Array<Change> = [];
  const listener = Layer.succeed(AfterCommit, {
    publish: (changes) =>
      Effect.sync(() => {
        announced.push(...changes);
      }),
  });
  const layer = Layer.mergeAll(PlatformEventsLayer, AuditLogLayer).pipe(
    Layer.provideMerge(TestDatabase),
  );
  const value = await Effect.runPromise(
    effect.pipe(Effect.provide(layer), Effect.provide(listener)),
  );
  return { value, announced };
};

describe("PlatformEvents", () => {
  it("writes one platform row with the kind, the encoded payload, the actor and the timestamp", async () => {
    const { value: rows } = await runRecordingAnnouncements(
      Effect.gen(function* () {
        const platformEvents = yield* PlatformEvents;
        yield* platformEvents.emit(TASK_CREATED);
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          readonly source: string;
          readonly connection_id: Uint8Array | null;
          readonly system: string;
          readonly kind: string;
          readonly occurred_at: string;
          readonly received_at: string;
          readonly dedup_key: string;
          readonly refs: string;
          readonly url: string | null;
          readonly payload: string;
          readonly raw: string | null;
          readonly actor: string | null;
        }>`SELECT * FROM events`;
      }),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.source).toBe("platform");
    expect(row.connection_id).toBeNull();
    expect(row.system).toBe("platform");
    expect(row.kind).toBe("task.created");
    expect(row.occurred_at).toBe(AT);
    expect(row.received_at).toBe(AT);
    expect(row.dedup_key).not.toBe("");
    expect(row.refs).toBe("[]");
    expect(row.url).toBeNull();
    expect(JSON.parse(row.payload)).toEqual({ task: TASK });
    expect(row.raw).toBeNull();
    expect(row.actor).toBe(SESSION_ACTOR);
  });

  it("writes a null actor for a run that ended on its own, and keeps the run's payload whole", async () => {
    const { value: rows } = await runRecordingAnnouncements(
      Effect.gen(function* () {
        const platformEvents = yield* PlatformEvents;
        yield* platformEvents.emit(RUN_COMPLETED);
        return yield* platformEvents.listByKind("run.completed");
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBeNull();
    expect(rows[0]!.receivedAt).toBe(AT);
    expect(rows[0]!.payload).toEqual(RUN_COMPLETED.payload);
  });

  it("writes a row the event router reads, where it skips an audit entry", async () => {
    const { value: routed } = await runRecordingAnnouncements(
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const platformEvents = yield* PlatformEvents;
        yield* audit.append({
          kind: "auth.login.succeeded",
          actor: "user",
          payload: { username: "rogier" },
        });
        yield* platformEvents.emit(TASK_CREATED);
        yield* platformEvents.emit(TASK_UPDATED);
        yield* platformEvents.emit(RUN_COMPLETED);
        const sql = yield* SqlClient.SqlClient;
        return yield* readPipelineEventsAfter(sql, 0, 10);
      }),
    );
    expect(routed.map((event) => event.kind)).toEqual([
      "task.created",
      "task.updated",
      "run.completed",
    ]);
  });

  it("announces the log and the created task for task.created", async () => {
    const { announced } = await runRecordingAnnouncements(
      Effect.flatMap(PlatformEvents, (platformEvents) => platformEvents.emit(TASK_CREATED)),
    );
    expect(announced).toEqual([
      { _tag: "event" },
      { _tag: "record", topic: "task", id: TASK_ID, kind: "created" },
    ]);
  });

  it("announces the log and the updated task for task.updated", async () => {
    const { announced } = await runRecordingAnnouncements(
      Effect.flatMap(PlatformEvents, (platformEvents) => platformEvents.emit(TASK_UPDATED)),
    );
    expect(announced).toEqual([
      { _tag: "event" },
      { _tag: "record", topic: "task", id: TASK_ID, kind: "updated" },
    ]);
  });

  it("announces only the log for a run event, because the runs domain announces the run", async () => {
    const { announced } = await runRecordingAnnouncements(
      Effect.flatMap(PlatformEvents, (platformEvents) => platformEvents.emit(RUN_COMPLETED)),
    );
    expect(announced).toEqual([{ _tag: "event" }]);
  });

  it("rolls back with the change it reports, and announces nothing", async () => {
    const { value: rows, announced } = await runRecordingAnnouncements(
      Effect.gen(function* () {
        const platformEvents = yield* PlatformEvents;
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* platformEvents.emit(TASK_CREATED);
            return yield* Effect.fail(new Error("the operation failed after the event"));
          }),
        ).pipe(Effect.ignore);
        return yield* platformEvents.listByKind("task.created");
      }),
    );
    expect(rows).toEqual([]);
    expect(announced).toEqual([]);
  });

  it("keeps the row and announces it once the transaction commits", async () => {
    const { value: rows, announced } = await runRecordingAnnouncements(
      Effect.gen(function* () {
        const platformEvents = yield* PlatformEvents;
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(sql, platformEvents.emit(TASK_UPDATED));
        return yield* platformEvents.listByKind("task.updated");
      }),
    );
    expect(rows).toHaveLength(1);
    expect(announced).toEqual([
      { _tag: "event" },
      { _tag: "record", topic: "task", id: TASK_ID, kind: "updated" },
    ]);
  });
});

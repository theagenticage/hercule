/**
 * Tests how the controller writes a platform event: the row it appends to the
 * event log, that the event router reads it where it skips an audit entry,
 * that it commits or rolls back with the change it reports, and what it
 * announces once it has committed.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Task } from "@hercule/contract";
import type { Change } from "../db";
import { withTransaction } from "../db/client";
import { buildAnnouncementRecorder, TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "./audit-log";
import { readEventsOfKind } from "./testing";
import { EVENT_COLUMNS, readPipelineEventsAfter, type EventRow } from "./log";
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

/** The event of a run that ended on its own, so no request caused it. */
const RUN_COMPLETED: PlatformEvent = {
  kind: "run.completed",
  actor: "system",
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

/** The services every test here runs with: both writers of the event log, and the database. */
type EventLogServices = PlatformEvents | AuditLog | SqlClient.SqlClient;

/**
 * Runs `effect` against a fresh database, and returns its value with every
 * change announced after a commit, in order.
 */
const runRecordingAnnouncements = async <A, E>(
  effect: Effect.Effect<A, E, EventLogServices>,
): Promise<{ readonly value: A; readonly announced: ReadonlyArray<Change> }> => {
  const { listener, announced } = buildAnnouncementRecorder();
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
        return yield* sql<EventRow>`SELECT ${sql.literal(EVENT_COLUMNS)} FROM events`;
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

  it("writes the system actor for a run that ended on its own, and keeps the run's payload whole", async () => {
    const { value: rows } = await runRecordingAnnouncements(
      Effect.gen(function* () {
        const platformEvents = yield* PlatformEvents;
        yield* platformEvents.emit(RUN_COMPLETED);
        return yield* readEventsOfKind("run.completed");
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("system");
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

  it("announces only a change to the log, because the domain an event is about announces its own record", async () => {
    for (const event of [TASK_CREATED, TASK_UPDATED, RUN_COMPLETED]) {
      const { announced } = await runRecordingAnnouncements(
        Effect.flatMap(PlatformEvents, (platformEvents) => platformEvents.emit(event)),
      );
      expect(announced, event.kind).toEqual([{ _tag: "event" }]);
    }
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
        return yield* readEventsOfKind("task.created");
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
        return yield* readEventsOfKind("task.updated");
      }),
    );
    expect(rows).toHaveLength(1);
    expect(announced).toEqual([{ _tag: "event" }]);
  });
});

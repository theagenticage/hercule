/**
 * The record of each handoff of an External Entity to a workflow
 * (`entity_handoffs`), kept by the Task module that writes the handoff's Task.
 * The record says what the handoff did to the Task, so
 * its Undo can tell what may be taken back, and it keeps the first answer of
 * that Undo, so a repeat returns it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { HandOffUndo, type TaskStage } from "@hercule/contract";
import { uuidFromString, uuidToString } from "../db";

/** What a handoff did to its Task, and the first answer of its Undo once there is one. */
export interface HandoffRecord {
  readonly runId: string;
  readonly ref: string;
  readonly taskId: string;
  /** True when the handoff made the Task. */
  readonly taskCreated: boolean;
  /** The stage a continued Task had before the handoff, or `undefined` for a Task the handoff made. */
  readonly stageBefore: TaskStage | undefined;
  /** The Task's `stage_revision` and `join_revision` once the handoff had written everything. */
  readonly stageRevision: number;
  readonly joinRevision: number;
  /** The first answer of the Undo, or `undefined` while nobody has undone the handoff. */
  readonly undo: HandOffUndo | undefined;
}

interface RecordRow {
  readonly run_id: Uint8Array;
  readonly ref: string;
  readonly task_id: Uint8Array;
  readonly task_created: number;
  readonly stage_before: string | null;
  readonly stage_revision: number;
  readonly join_revision: number;
  readonly undo_result: string | null;
}

const decodeUndo = Schema.decodeUnknownSync(Schema.fromJsonString(HandOffUndo));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Writes the record of a handoff. Run it in the transaction that starts the run. */
    insert: (record: Omit<HandoffRecord, "undo">): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO entity_handoffs
          (run_id, ref, task_id, task_created, stage_before, stage_revision,
           join_revision)
        VALUES (${uuidFromString(record.runId)}, ${record.ref}, ${uuidFromString(record.taskId)},
                ${record.taskCreated ? 1 : 0}, ${record.stageBefore ?? null},
                ${record.stageRevision}, ${record.joinRevision})`),

    /** Returns the record of the handoff that started the run, or none. */
    read: (runId: string): Effect.Effect<Option.Option<HandoffRecord>, SqlError> =>
      Effect.map(
        sql<RecordRow>`SELECT * FROM entity_handoffs WHERE run_id = ${uuidFromString(runId)}`,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row): HandoffRecord => ({
            runId: uuidToString(row.run_id),
            ref: row.ref,
            taskId: uuidToString(row.task_id),
            taskCreated: row.task_created === 1,
            stageBefore: (row.stage_before ?? undefined) as TaskStage | undefined,
            stageRevision: row.stage_revision,
            joinRevision: row.join_revision,
            undo: row.undo_result === null ? undefined : decodeUndo(row.undo_result),
          })),
      ),

    /** Stores the first answer of the Undo of a handoff, with the time it was given. */
    storeUndo: (runId: string, undo: HandOffUndo, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE entity_handoffs SET undone_at = ${at}, undo_result = ${JSON.stringify(undo)}
        WHERE run_id = ${uuidFromString(runId)}`),
  };
});

/** Builds the repository of handoff records. It needs the database. */
export const handoffRecordRepository = make;

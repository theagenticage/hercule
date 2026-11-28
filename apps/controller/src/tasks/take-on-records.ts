/**
 * The record of each `takeOnTogether` call (`entity_take_ons`), kept by the
 * Task module that writes the Task. The record says what the call wrote to
 * the Task's links, so its Undo can reverse exactly that, and it keeps the
 * answer of an Undo that succeeded, so a repeat returns it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { EntityUndoTakeOnResult } from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString } from "../db";

/** A link of the Task, by ref, with the time the call wrote on it. */
export interface RecordedWrite {
  readonly ref: string;
  readonly at: string;
}

/** What a `takeOnTogether` call did to the links of its Task. */
export interface TakeOnRecord {
  readonly id: string;
  readonly taskId: string;
  /** True when the call made the Task. */
  readonly taskCreated: boolean;
  /** The links the call inserted, each with the `linked_at` it holds. */
  readonly linksAdded: ReadonlyArray<RecordedWrite>;
  /** The links the call marked taken, each with the `taken_at` it holds. */
  readonly marksTaken: ReadonlyArray<RecordedWrite>;
  /** The answer of the Undo that took the call back, or `undefined` while nobody has. */
  readonly undo: EntityUndoTakeOnResult | undefined;
}

interface RecordRow {
  readonly id: Uint8Array;
  readonly task_id: Uint8Array;
  readonly task_created: number;
  readonly links_added: string;
  readonly marks_taken: string;
  readonly undo_result: string | null;
}

const RecordedWrites = Schema.Array(Schema.Struct({ ref: Schema.String, at: Schema.String }));
const decodeWrites = Schema.decodeUnknownSync(Schema.fromJsonString(RecordedWrites));
const decodeUndo = Schema.decodeUnknownSync(Schema.fromJsonString(EntityUndoTakeOnResult));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Writes the record of a call and returns its id. Run it in the
     * transaction that writes the call's links.
     */
    insert: (
      record: Omit<TakeOnRecord, "id" | "undo">,
      at: string,
    ): Effect.Effect<string, SqlError> => {
      const id = mintUuid();
      return Effect.as(
        sql`
          INSERT INTO entity_take_ons
            (id, task_id, task_created, links_added, marks_taken, created_at)
          VALUES (${id}, ${uuidFromString(record.taskId)}, ${record.taskCreated ? 1 : 0},
                  ${JSON.stringify(record.linksAdded)}, ${JSON.stringify(record.marksTaken)}, ${at})`,
        uuidToString(id),
      );
    },

    /** Returns the record with that id, or none. */
    read: (id: string): Effect.Effect<Option.Option<TakeOnRecord>, SqlError> =>
      Effect.map(
        sql<RecordRow>`SELECT * FROM entity_take_ons WHERE id = ${uuidFromString(id)}`,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row): TakeOnRecord => ({
            id: uuidToString(row.id),
            taskId: uuidToString(row.task_id),
            taskCreated: row.task_created === 1,
            linksAdded: decodeWrites(row.links_added),
            marksTaken: decodeWrites(row.marks_taken),
            undo: row.undo_result === null ? undefined : decodeUndo(row.undo_result),
          })),
      ),

    /** Stores the answer of the Undo that took the call back, with the time it was given. */
    storeUndo: (
      id: string,
      undo: EntityUndoTakeOnResult,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE entity_take_ons SET undone_at = ${at}, undo_result = ${JSON.stringify(undo)}
        WHERE id = ${uuidFromString(id)}`),
  };
});

/** Builds the repository of Take on records. It needs the database. */
export const takeOnRecordRepository = make;

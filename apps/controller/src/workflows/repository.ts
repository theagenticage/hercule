/**
 * Workflow rows and trigger rows. This module only reads and writes them. It
 * decides no policy: who may write, what a source means and whether it is
 * valid are the service's questions.
 *
 * A workflow listing is one walk: a keyset over `updated_at` and the id, which
 * the index on `workflows` serves. A trigger listing is one walk too, over
 * `created_at`, the workflow and the trigger id, which is how a trigger is
 * named.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Fragment } from "effect/unstable/sql/Statement";
import type {
  SortDirection,
  Trigger,
  TriggerKind,
  TriggerStatus,
  Workflow,
  WorkflowDefinition,
  WorkflowSummary,
} from "@hercule/contract";
import {
  decodeCursor,
  decodeOwnedCursor,
  encodeCursor,
  encodeOwnedCursor,
  keysetOver,
  mintUuid,
  pageOf,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** A text and the definition it parses to, which are always written together. */
export interface ParsedSource {
  readonly source: string;
  readonly definition: WorkflowDefinition;
}

/** What an edit sets. An absent field is left as it was. */
export interface WorkflowEdit {
  readonly parsedSource?: ParsedSource;
  readonly enabled?: boolean;
}

/** A trigger as a source declares it: every field of its row that the source gives. */
export interface DeclaredTrigger {
  readonly triggerId: string;
  readonly kind: TriggerKind;
  readonly eventKind: string;
  readonly connectionId: string | undefined;
  readonly filter: string | undefined;
  readonly schedule: string | undefined;
  readonly timezone: string | undefined;
}

export interface WorkflowPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  readonly enabled: boolean | undefined;
}

export interface TriggerPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  readonly workflowId: string | undefined;
  readonly kind: TriggerKind | undefined;
  readonly eventKind: string | undefined;
  readonly status: TriggerStatus | undefined;
}

interface WorkflowRow {
  readonly id: Uint8Array;
  readonly enabled: number;
  readonly source: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SummaryRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: number;
  readonly updated_at: string;
}

interface TriggerRow {
  readonly workflow_id: Uint8Array;
  readonly workflow_name: string;
  readonly trigger_id: string;
  readonly kind: TriggerKind;
  readonly event_kind: string;
  readonly connection_id: string | null;
  readonly filter: string | null;
  readonly schedule: string | null;
  readonly timezone: string | null;
  readonly status: TriggerStatus | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const WORKFLOW_COLUMNS = "id, enabled, source, created_at, updated_at";

/** The name is read out of the definition, which is where the source puts it. */
const NAME_FROM_DEFINITION = "json_extract(workflows.definition, '$.name')";

const toWorkflow = (row: WorkflowRow): Workflow => ({
  id: uuidToString(row.id),
  enabled: row.enabled === 1,
  source: row.source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toSummary = (row: SummaryRow): WorkflowSummary => ({
  id: uuidToString(row.id),
  name: row.name,
  ...(row.description === null ? {} : { description: row.description }),
  enabled: row.enabled === 1,
  updatedAt: row.updated_at,
});

/** A field the trigger does not have is absent from the record, not null. */
const toTrigger = (row: TriggerRow): Trigger => ({
  workflowId: uuidToString(row.workflow_id),
  workflowName: row.workflow_name,
  triggerId: row.trigger_id,
  kind: row.kind,
  eventKind: row.event_kind,
  ...(row.connection_id === null ? {} : { connectionId: row.connection_id }),
  ...(row.filter === null ? {} : { filter: row.filter }),
  ...(row.schedule === null ? {} : { schedule: row.schedule }),
  ...(row.timezone === null ? {} : { timezone: row.timezone }),
  ...(row.status === null ? {} : { status: row.status }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const utf8 = new TextEncoder();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * A string bound as its UTF-8 bytes and stored as text, so that the stored
   * text has every character of the string. A string that is not Latin-1 is
   * bound as UTF-16, and SQLite reads a U+FEFF at the start of UTF-16 text as
   * a byte order mark and drops it. The author's text can start with one.
   */
  const bindExactText = (text: string): Fragment => sql`CAST(${utf8.encode(text)} AS TEXT)`;

  const bindOptionalText = (text: string | undefined): Fragment =>
    text === undefined ? sql`NULL` : bindExactText(text);

  return {
    read: (id: string): Effect.Effect<Option.Option<Workflow>, SqlError> =>
      Effect.map(
        sql<WorkflowRow>`
          SELECT ${sql.literal(WORKFLOW_COLUMNS)} FROM workflows WHERE id = ${uuidFromString(id)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toWorkflow),
      ),

    /** Stores a new workflow. A new workflow is off. */
    insert: (parsedSource: ParsedSource, savedAt: string): Effect.Effect<Workflow, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO workflows (id, source, definition, enabled, created_at, updated_at)
          VALUES (${id}, ${bindExactText(parsedSource.source)},
                  ${JSON.stringify(parsedSource.definition)}, 0, ${savedAt}, ${savedAt})
        `;
        return {
          id: uuidToString(id),
          enabled: false,
          source: parsedSource.source,
          createdAt: savedAt,
          updatedAt: savedAt,
        };
      }),

    /**
     * Applies an edit, and answers the workflow as the edit left it, or nothing
     * where no workflow has the id. Only the columns the edit names are
     * written, and the text and its definition are only written together.
     */
    update: (
      id: string,
      edit: WorkflowEdit,
      savedAt: string,
    ): Effect.Effect<Option.Option<Workflow>, SqlError> => {
      const assignments = [sql`updated_at = ${savedAt}`];
      if (edit.parsedSource !== undefined) {
        assignments.push(
          sql`source = ${bindExactText(edit.parsedSource.source)}`,
          sql`definition = ${JSON.stringify(edit.parsedSource.definition)}`,
        );
      }
      if (edit.enabled !== undefined) assignments.push(sql`enabled = ${edit.enabled ? 1 : 0}`);
      return Effect.map(
        sql<WorkflowRow>`
          UPDATE workflows SET ${sql.csv(assignments)} WHERE id = ${uuidFromString(id)}
          RETURNING ${sql.literal(WORKFLOW_COLUMNS)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toWorkflow),
      );
    },

    /**
     * Removes the workflow, and answers the name it had, or nothing where no
     * workflow has the id. Its trigger rows go with it, through the foreign
     * key.
     */
    delete: (id: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly name: string }>`
          DELETE FROM workflows WHERE id = ${uuidFromString(id)}
          RETURNING ${sql.literal(NAME_FROM_DEFINITION)} AS name
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.name),
      ),

    list: (
      request: WorkflowPageRequest,
    ): Effect.Effect<Page<WorkflowSummary>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope: CursorScope = {
          op: "workflow.query",
          field: "updatedAt",
          direction: request.direction,
        };
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = keysetOver(
          sql,
          ["updated_at", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const clauses = [keyset];
        if (request.enabled !== undefined) {
          clauses.push(sql`enabled = ${request.enabled ? 1 : 0}`);
        }
        const rows = yield* sql<SummaryRow>`
          SELECT id, ${sql.literal(NAME_FROM_DEFINITION)} AS name,
                 json_extract(definition, '$.description') AS description, enabled, updated_at
          FROM workflows WHERE ${sql.and(clauses)} ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* pageOf(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toSummary)),
          (last) => encodeCursor(scope, last.updatedAt, last.id),
        );
      }),

    /**
     * Makes the workflow's trigger rows the triggers its source declares.
     *
     * A trigger whose id the source no longer has loses its row. A trigger
     * whose id is new gets a row: `active` for a start trigger, and no status
     * for a signal trigger. A trigger whose id stays keeps its row, its
     * `created_at` and its status, and its other fields become what the source
     * says now; its `updated_at` moves only when one of them changed.
     *
     * A trigger whose id stays but whose kind changes is a new trigger: a
     * start trigger and a signal trigger are different things. It gets a new
     * `created_at`, and a start trigger is `active` again.
     */
    reconcileTriggers: (
      workflowId: string,
      triggers: ReadonlyArray<DeclaredTrigger>,
      savedAt: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const workflow = uuidFromString(workflowId);
        const kept = triggers.map((trigger) => trigger.triggerId);
        yield* sql`
          DELETE FROM triggers
          WHERE workflow_id = ${workflow}
            AND ${kept.length === 0 ? sql`1 = 1` : sql`trigger_id NOT IN ${sql.in(kept)}`}
        `;
        for (const trigger of triggers) {
          yield* sql`
            INSERT INTO triggers
              (workflow_id, trigger_id, kind, event_kind, connection_id, filter, schedule,
               timezone, status, created_at, updated_at)
            VALUES
              (${workflow}, ${trigger.triggerId}, ${trigger.kind},
               ${bindExactText(trigger.eventKind)}, ${trigger.connectionId ?? null},
               ${bindOptionalText(trigger.filter)}, ${bindOptionalText(trigger.schedule)},
               ${bindOptionalText(trigger.timezone)},
               ${trigger.kind === "start" ? "active" : null}, ${savedAt}, ${savedAt})
            ON CONFLICT (workflow_id, trigger_id) DO UPDATE SET
              kind = excluded.kind,
              event_kind = excluded.event_kind,
              connection_id = excluded.connection_id,
              filter = excluded.filter,
              schedule = excluded.schedule,
              timezone = excluded.timezone,
              status = CASE WHEN triggers.kind = excluded.kind THEN triggers.status
                            ELSE excluded.status END,
              created_at = CASE WHEN triggers.kind = excluded.kind THEN triggers.created_at
                                ELSE excluded.created_at END,
              updated_at = excluded.updated_at
            WHERE (triggers.kind, triggers.event_kind, triggers.connection_id, triggers.filter,
                   triggers.schedule, triggers.timezone)
               IS NOT (excluded.kind, excluded.event_kind, excluded.connection_id,
                       excluded.filter, excluded.schedule, excluded.timezone)
          `;
        }
      }),

    listTriggers: (
      request: TriggerPageRequest,
    ): Effect.Effect<Page<Trigger>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope: CursorScope = {
          op: "trigger.query",
          field: "createdAt",
          direction: request.direction,
        };
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeOwnedCursor(request.cursor, scope);
        const { keyset, order } = keysetOver(
          sql,
          ["triggers.created_at", "triggers.workflow_id", "triggers.trigger_id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1]), after[2]],
          request.direction,
        );
        const clauses = [keyset];
        if (request.workflowId !== undefined) {
          clauses.push(sql`triggers.workflow_id = ${uuidFromString(request.workflowId)}`);
        }
        if (request.kind !== undefined) clauses.push(sql`triggers.kind = ${request.kind}`);
        if (request.eventKind !== undefined) {
          clauses.push(sql`triggers.event_kind = ${bindExactText(request.eventKind)}`);
        }
        if (request.status !== undefined) clauses.push(sql`triggers.status = ${request.status}`);
        const rows = yield* sql<TriggerRow>`
          SELECT triggers.workflow_id, ${sql.literal(NAME_FROM_DEFINITION)} AS workflow_name,
                 triggers.trigger_id, triggers.kind, triggers.event_kind, triggers.connection_id,
                 triggers.filter, triggers.schedule, triggers.timezone, triggers.status,
                 triggers.created_at, triggers.updated_at
          FROM triggers JOIN workflows ON workflows.id = triggers.workflow_id
          WHERE ${sql.and(clauses)} ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* pageOf(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toTrigger)),
          (last) => encodeOwnedCursor(scope, last.createdAt, last.workflowId, last.triggerId),
        );
      }),
  };
});

/** Everything the workflow service reads and writes. */
export const workflowRepository = make;

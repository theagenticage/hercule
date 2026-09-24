/**
 * Reads and writes the `workflows` and `triggers` tables. This module has no
 * policy: permissions, parsing and validation belong to the service.
 *
 * Both listings use keyset pagination. Workflows are paged by `updated_at` and
 * id, which the index on `workflows` covers. Triggers are paged by
 * `created_at`, workflow id and trigger id, because a trigger is identified by
 * its workflow id and trigger id.
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
  buildKeyset,
  mintUuid,
  buildPage,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** A YAML source and the definition it parses to. They are always stored together. */
export interface ParsedSource {
  readonly source: string;
  readonly definition: WorkflowDefinition;
}

/** The fields an update sets. An absent field is left unchanged. */
export interface WorkflowEdit {
  readonly parsedSource?: ParsedSource;
  readonly enabled?: boolean;
}

/** A workflow after an update, and which of its fields the update changed. */
export interface WorkflowUpdate {
  readonly workflow: Workflow;
  /**
   * The fields whose stored value changed. A field set to the value it
   * already had is not listed, so saving the same source lists nothing.
   */
  readonly changed: ReadonlyArray<"source" | "enabled">;
}

/** A trigger as the workflow source declares it: the fields of its row that come from the source. */
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

/** The workflow's name is not a column. It is read from the stored definition. */
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

/** Maps a trigger row to a `Trigger`. A NULL column becomes an absent field, not `null`. */
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
   * Binds a string as UTF-8 bytes cast to TEXT, so that SQLite stores every
   * character. A string that is not Latin-1 is otherwise bound as UTF-16, and
   * SQLite treats a U+FEFF at the start of UTF-16 text as a byte order mark
   * and drops it. An author's YAML can start with U+FEFF.
   */
  const bindExactText = (text: string): Fragment => sql`CAST(${utf8.encode(text)} AS TEXT)`;

  const bindOptionalText = (text: string | undefined): Fragment =>
    text === undefined ? sql`NULL` : bindExactText(text);

  const read = (id: string): Effect.Effect<Option.Option<Workflow>, SqlError> =>
    Effect.map(
      sql<WorkflowRow>`
        SELECT ${sql.literal(WORKFLOW_COLUMNS)} FROM workflows WHERE id = ${uuidFromString(id)}
      `,
      (rows) => Option.map(Option.fromNullishOr(rows[0]), toWorkflow),
    );

  return {
    read,

    /**
     * Returns the stored definition of a workflow: the parsed form of its
     * source. Returns `None` if no workflow has the id.
     */
    readDefinition: (id: string): Effect.Effect<Option.Option<WorkflowDefinition>, SqlError> =>
      Effect.map(
        sql<{ readonly definition: string }>`
          SELECT definition FROM workflows WHERE id = ${uuidFromString(id)}
        `,
        (rows) =>
          Option.map(
            Option.fromNullishOr(rows[0]),
            (row) => JSON.parse(row.definition) as WorkflowDefinition,
          ),
      ),

    /** Inserts a new workflow, disabled, and returns it. */
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
     * Updates a workflow. Returns the updated workflow and the fields that
     * changed, or `None` if no workflow has the id. Writes only the columns
     * that `edit` sets, and always writes the source and the definition
     * together. The caller holds the transaction, so the row cannot change
     * between the read and the write.
     *
     * `updated_at` is when the source last changed. Enabling or disabling a
     * workflow does not change it, and neither does saving the same source.
     * The list is sorted by `updated_at`, so a workflow keeps its place in the
     * list when the user toggles it. The audit log records every update.
     */
    update: (
      id: string,
      edit: WorkflowEdit,
      savedAt: string,
    ): Effect.Effect<Option.Option<WorkflowUpdate>, SqlError> =>
      Effect.gen(function* () {
        const before = yield* read(id);
        if (Option.isNone(before)) return Option.none();
        const changed = [
          ...(edit.parsedSource !== undefined && edit.parsedSource.source !== before.value.source
            ? (["source"] as const)
            : []),
          ...(edit.enabled !== undefined && edit.enabled !== before.value.enabled
            ? (["enabled"] as const)
            : []),
        ];
        const assignments: Array<Fragment> = [];
        if (edit.parsedSource !== undefined) {
          assignments.push(
            sql`source = ${bindExactText(edit.parsedSource.source)}`,
            sql`definition = ${JSON.stringify(edit.parsedSource.definition)}`,
          );
        }
        if (changed.includes("source")) assignments.push(sql`updated_at = ${savedAt}`);
        if (edit.enabled !== undefined) assignments.push(sql`enabled = ${edit.enabled ? 1 : 0}`);
        const rows = yield* sql<WorkflowRow>`
          UPDATE workflows SET ${sql.csv(assignments)} WHERE id = ${uuidFromString(id)}
          RETURNING ${sql.literal(WORKFLOW_COLUMNS)}
        `;
        return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
          workflow: toWorkflow(row),
          changed,
        }));
      }),

    /**
     * Deletes a workflow. Returns its name, or `None` if no workflow has the
     * id. The foreign key deletes its trigger rows too.
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
        const { keyset, order } = buildKeyset(
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
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toSummary)),
          (last) => encodeCursor(scope, last.updatedAt, last.id),
        );
      }),

    /**
     * Updates a workflow's trigger rows to match the triggers its source
     * declares:
     *
     * - A trigger whose id is no longer in the source is deleted.
     * - A trigger with a new id is inserted, with status `active` for a start
     *   trigger and no status for a signal trigger.
     * - A trigger whose id stays keeps its row, `created_at` and status. Its
     *   other fields are overwritten from the source, and `updated_at` changes
     *   only if one of them changed.
     * - A trigger whose id stays but whose kind changes counts as a new
     *   trigger, because a start trigger and a signal trigger are different
     *   things. It gets a new `created_at`, and a start trigger is `active`
     *   again.
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
        const { keyset, order } = buildKeyset(
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
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toTrigger)),
          (last) => encodeOwnedCursor(scope, last.createdAt, last.workflowId, last.triggerId),
        );
      }),
  };
});

/** The repository of the `workflows` and `triggers` tables. */
export const workflowRepository = make;

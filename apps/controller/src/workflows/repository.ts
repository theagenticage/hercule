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
  SkippedTicks,
  SortDirection,
  Trigger,
  TriggerHealth,
  TriggerKey,
  TriggerKind,
  TriggerOn,
  TriggerOnShape,
  TriggerStatus,
  Workflow,
  WorkflowDefinition,
  WorkflowSummary,
} from "@hercule/contract";
import { isSchedule } from "@hercule/contract";
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
import { CRON_TICK_EVENT_KIND } from "../events";

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

/**
 * A trigger as the workflow source declares it: the fields of its row that
 * come from the source. How `on` is stored in the row's columns is a detail of
 * this module; see `isCronTriggerRow`.
 */
export interface DeclaredTrigger {
  readonly triggerId: string;
  readonly kind: TriggerKind;
  readonly on: TriggerOn;
  /** A start trigger's input mapping: each input name to an expression over `event`. */
  readonly inputs: Readonly<Record<string, string>> | undefined;
}

/**
 * Where a start trigger failed:
 *
 * - `evaluation`: the event router could not evaluate its filter or input
 *   mapping on an event;
 * - `scheduling`: the Scheduler could not compute a cron trigger's next time;
 * - `start`: the delivery could not start the run of a match.
 */
export type TriggerFailureStage = "evaluation" | "scheduling" | "start";

/**
 * A start trigger that can start a run now: it is active and its workflow is
 * enabled. The event router tests every event against these.
 */
export interface RoutableStartTrigger extends TriggerKey {
  readonly eventKind: string;
  /** A Connection id, `any`, or `undefined` for a kind the core emits. */
  readonly connectionId: string | undefined;
  readonly filter: string | undefined;
  /** Each input name to an expression over `event`. Empty when the trigger maps nothing. */
  readonly inputs: Readonly<Record<string, string>>;
  /** Whether the trigger's health records an error of its filter or input mapping. */
  readonly hasEvaluationError: boolean;
}

/** A cron trigger's schedule and the Scheduler's state for it. */
export interface CronTrigger extends TriggerKey {
  readonly schedule: string;
  /** The trigger's own timezone. `undefined` means the user's timezone setting applies. */
  readonly timezone: string | undefined;
  /** Whether a tick would start a run now: the trigger is active and its workflow is enabled. */
  readonly canFire: boolean;
  /** `undefined` until the Scheduler first computes it, and again after the schedule changes. */
  readonly nextFireAt: string | undefined;
  /** The timezone `nextFireAt` was computed in. */
  readonly nextFireZone: string | undefined;
  readonly lastFiredAt: string | undefined;
  /** The error the trigger's health records about its schedule, if any. */
  readonly schedulingErrorMessage: string | undefined;
}

/**
 * What the Scheduler writes when it moves a cron trigger on to its next
 * scheduled time.
 *
 * - `nextFireAt` and `zone`: the next scheduled time and the timezone it was
 *   computed in.
 * - `firedAt`: set when the trigger fired, to the scheduled time it fired for.
 * - `skipped`: set when the trigger missed scheduled times, to the stretch it
 *   missed. It replaces the stretch recorded before.
 */
export interface CronAdvance {
  readonly nextFireAt: string;
  readonly zone: string;
  readonly firedAt?: string;
  readonly skipped?: SkippedTicks;
}

/** A trigger that names a Connection, with its workflow's name for a message. */
export interface TriggerNamingConnection extends TriggerKey {
  readonly workflowName: string;
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
  /** `schedule` lists the cron triggers, and `event` every other trigger. */
  readonly on: TriggerOnShape | undefined;
  /** Lists the triggers that accept events of this kind. A cron trigger accepts none. */
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
  readonly health_error_message: string | null;
  readonly health_error_at: string | null;
  readonly next_fire_at: string | null;
  readonly last_fired_at: string | null;
  readonly skipped_from: string | null;
  readonly skipped_until: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The workflow's name is not a column. It is read from the stored definition. */
const NAME_FROM_DEFINITION = "json_extract(workflows.definition, '$.name')";

/**
 * The condition that picks the cron triggers out of the `triggers` table.
 *
 * A trigger's `on` is stored in its row by one rule. A start trigger whose
 * `on` is a schedule is stored with the event kind `cron.tick`, the kind of
 * the events the Scheduler emits for it, its schedule and timezone, and no
 * Connection or filter. Any other trigger is stored with the event kind,
 * Connection and filter of its event selector, and no schedule.
 * `isCronTriggerRow` reads a row by the same rule. This condition is also the
 * condition of the partial index `triggers_cron_next_fire`, so SQLite can use
 * that index only while the two match word for word.
 */
const IS_CRON_TRIGGER = `triggers.kind = 'start' AND triggers.event_kind = '${CRON_TICK_EVENT_KIND}'
  AND triggers.schedule IS NOT NULL`;

/** The columns a `TriggerRow` is read from. The query joins `workflows` for the name. */
const TRIGGER_COLUMNS = `triggers.workflow_id, ${NAME_FROM_DEFINITION} AS workflow_name,
  triggers.trigger_id, triggers.kind, triggers.event_kind, triggers.connection_id,
  triggers.filter, triggers.schedule, triggers.timezone, triggers.status,
  triggers.health_error_message, triggers.health_error_at, triggers.next_fire_at,
  triggers.last_fired_at, triggers.skipped_from, triggers.skipped_until,
  triggers.created_at, triggers.updated_at`;

const WORKFLOW_COLUMNS = "id, enabled, source, created_at, updated_at";

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

/**
 * Returns a trigger's health from its two health columns. A check on the table
 * writes them together, so one without the other cannot happen.
 */
const readHealth = (row: TriggerRow): TriggerHealth =>
  row.health_error_message === null || row.health_error_at === null
    ? { state: "ok" }
    : { state: "error", message: row.health_error_message, at: row.health_error_at };

/**
 * Checks whether a trigger row holds a cron trigger. It is the same condition
 * as `IS_CRON_TRIGGER`, which describes how a row stores a trigger's `on`.
 */
const isCronTriggerRow = (row: TriggerRow): row is TriggerRow & { readonly schedule: string } =>
  row.kind === "start" && row.event_kind === CRON_TICK_EVENT_KIND && row.schedule !== null;

/**
 * Builds a trigger's `on` from its row: a schedule for a cron trigger, and an
 * event selector for any other trigger. A cron trigger's stored event kind,
 * `cron.tick`, is left out.
 */
const buildTriggerOn = (row: TriggerRow): TriggerOn =>
  isCronTriggerRow(row)
    ? {
        schedule: row.schedule,
        ...(row.timezone === null ? {} : { timezone: row.timezone }),
      }
    : {
        kind: row.event_kind,
        ...(row.connection_id === null ? {} : { connectionId: row.connection_id }),
        ...(row.filter === null ? {} : { filter: row.filter }),
      };

/**
 * Converts a trigger's `on` to the columns of its row, by the rule described
 * at `IS_CRON_TRIGGER`. A signal trigger's `on` is always an event selector.
 */
const buildOnColumns = (on: TriggerOn) =>
  isSchedule(on)
    ? {
        eventKind: CRON_TICK_EVENT_KIND,
        connectionId: undefined,
        filter: undefined,
        schedule: on.schedule,
        timezone: on.timezone,
      }
    : {
        eventKind: on.kind,
        connectionId: on.connectionId,
        filter: on.filter,
        schedule: undefined,
        timezone: undefined,
      };

/** Maps a trigger row to a `Trigger`. A NULL column becomes an absent field, not `null`. */
const toTrigger = (row: TriggerRow): Trigger => ({
  workflowId: uuidToString(row.workflow_id),
  workflowName: row.workflow_name,
  triggerId: row.trigger_id,
  kind: row.kind,
  on: buildTriggerOn(row),
  ...(row.status === null ? {} : { status: row.status }),
  ...(row.kind === "start" ? { health: readHealth(row) } : {}),
  ...(row.next_fire_at === null ? {} : { nextFireAt: row.next_fire_at }),
  ...(row.last_fired_at === null ? {} : { lastFiredAt: row.last_fired_at }),
  ...(row.skipped_from === null || row.skipped_until === null
    ? {}
    : { skippedTicks: { from: row.skipped_from, until: row.skipped_until } }),
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
     * Deletes a workflow. Returns its name and the ids of the triggers deleted
     * with it, or `None` if no workflow has the id. The foreign key deletes
     * the trigger rows.
     */
    delete: (
      id: string,
    ): Effect.Effect<
      Option.Option<{ readonly name: string; readonly triggerIds: ReadonlyArray<string> }>,
      SqlError
    > =>
      Effect.gen(function* () {
        const workflow = uuidFromString(id);
        const triggers = yield* sql<{ readonly trigger_id: string }>`
          SELECT trigger_id FROM triggers WHERE workflow_id = ${workflow}
        `;
        const rows = yield* sql<{ readonly name: string }>`
          DELETE FROM workflows WHERE id = ${workflow}
          RETURNING ${sql.literal(NAME_FROM_DEFINITION)} AS name
        `;
        return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
          name: row.name,
          triggerIds: triggers.map((trigger) => trigger.trigger_id),
        }));
      }),

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
     * declares. Each trigger's `on` is stored in the columns of its row by the
     * rule described at `IS_CRON_TRIGGER`.
     *
     * - A trigger whose id is no longer in the source is deleted.
     * - A trigger with a new id is inserted, with status `active` for a start
     *   trigger and no status for a signal trigger.
     * - A trigger whose id stays keeps its row, `created_at` and status. Its
     *   other fields are overwritten from the source, and `updated_at` changes
     *   only if one of them changed. A change also clears the trigger's
     *   health, because the error it records was about the old definition.
     *   A trigger that did not change keeps its error, which is still true.
     * - A cron trigger whose schedule or timezone changed has its next
     *   scheduled time cleared, so the Scheduler computes it again. A cron
     *   trigger whose schedule is replaced by an event selector loses all of
     *   its schedule state.
     * - A trigger whose id stays but whose kind changes counts as a new
     *   trigger, because a start trigger and a signal trigger are different
     *   things. It gets a new `created_at`, and a start trigger is `active`
     *   again.
     *
     * Returns the ids of the triggers that no longer exist: the deleted ones,
     * and the ones whose kind changed, since those were replaced.
     */
    reconcileTriggers: (
      workflowId: string,
      triggers: ReadonlyArray<DeclaredTrigger>,
      savedAt: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        const workflow = uuidFromString(workflowId);
        const kept = triggers.map((trigger) => trigger.triggerId);
        const kindsBefore = new Map(
          (yield* sql<{ readonly trigger_id: string; readonly kind: string }>`
            SELECT trigger_id, kind FROM triggers WHERE workflow_id = ${workflow}
          `).map((row) => [row.trigger_id, row.kind]),
        );
        const replaced = triggers
          .filter((trigger) => {
            const kindBefore = kindsBefore.get(trigger.triggerId);
            return kindBefore !== undefined && kindBefore !== trigger.kind;
          })
          .map((trigger) => trigger.triggerId);
        const deleted = yield* sql<{ readonly trigger_id: string }>`
          DELETE FROM triggers
          WHERE workflow_id = ${workflow}
            AND ${kept.length === 0 ? sql`1 = 1` : sql`trigger_id NOT IN ${sql.in(kept)}`}
          RETURNING trigger_id
        `;
        for (const trigger of triggers) {
          const columns = buildOnColumns(trigger.on);
          yield* sql`
            INSERT INTO triggers
              (workflow_id, trigger_id, kind, event_kind, connection_id, filter, schedule,
               timezone, inputs, status, created_at, updated_at)
            VALUES
              (${workflow}, ${trigger.triggerId}, ${trigger.kind},
               ${bindExactText(columns.eventKind)}, ${columns.connectionId ?? null},
               ${bindOptionalText(columns.filter)}, ${bindOptionalText(columns.schedule)},
               ${bindOptionalText(columns.timezone)},
               ${bindOptionalText(trigger.inputs === undefined ? undefined : JSON.stringify(trigger.inputs))},
               ${trigger.kind === "start" ? "active" : null}, ${savedAt}, ${savedAt})
            ON CONFLICT (workflow_id, trigger_id) DO UPDATE SET
              kind = excluded.kind,
              event_kind = excluded.event_kind,
              connection_id = excluded.connection_id,
              filter = excluded.filter,
              schedule = excluded.schedule,
              timezone = excluded.timezone,
              inputs = excluded.inputs,
              status = CASE WHEN triggers.kind = excluded.kind THEN triggers.status
                            ELSE excluded.status END,
              created_at = CASE WHEN triggers.kind = excluded.kind THEN triggers.created_at
                                ELSE excluded.created_at END,
              updated_at = excluded.updated_at,
              health_error_message = NULL,
              health_error_stage = NULL,
              health_error_at = NULL,
              next_fire_at = CASE
                WHEN (triggers.kind, triggers.event_kind, triggers.schedule, triggers.timezone)
                  IS (excluded.kind, excluded.event_kind, excluded.schedule, excluded.timezone)
                THEN triggers.next_fire_at END,
              next_fire_zone = CASE
                WHEN (triggers.kind, triggers.event_kind, triggers.schedule, triggers.timezone)
                  IS (excluded.kind, excluded.event_kind, excluded.schedule, excluded.timezone)
                THEN triggers.next_fire_zone END,
              -- When it last fired and what it missed stay with the schedule
              -- only while the trigger is still the same cron trigger.
              last_fired_at = CASE
                WHEN (triggers.kind, triggers.event_kind) IS (excluded.kind, excluded.event_kind)
                THEN triggers.last_fired_at END,
              skipped_from = CASE
                WHEN (triggers.kind, triggers.event_kind) IS (excluded.kind, excluded.event_kind)
                THEN triggers.skipped_from END,
              skipped_until = CASE
                WHEN (triggers.kind, triggers.event_kind) IS (excluded.kind, excluded.event_kind)
                THEN triggers.skipped_until END
            WHERE (triggers.kind, triggers.event_kind, triggers.connection_id, triggers.filter,
                   triggers.schedule, triggers.timezone, triggers.inputs)
               IS NOT (excluded.kind, excluded.event_kind, excluded.connection_id,
                       excluded.filter, excluded.schedule, excluded.timezone, excluded.inputs)
          `;
        }
        return [...deleted.map((row) => row.trigger_id), ...replaced];
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
        if (request.on === "schedule") clauses.push(sql.literal(IS_CRON_TRIGGER));
        if (request.on === "event") clauses.push(sql.literal(`NOT (${IS_CRON_TRIGGER})`));
        if (request.eventKind !== undefined) {
          // A cron trigger's row has the event kind `cron.tick`, but it
          // accepts no events, so no event kind lists it.
          clauses.push(
            sql`triggers.event_kind = ${bindExactText(request.eventKind)}
              AND NOT (${sql.literal(IS_CRON_TRIGGER)})`,
          );
        }
        if (request.status !== undefined) clauses.push(sql`triggers.status = ${request.status}`);
        const rows = yield* sql<TriggerRow>`
          SELECT ${sql.literal(TRIGGER_COLUMNS)}
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

    /** Returns one trigger, or `None` if its workflow declares no trigger with the id. */
    readTrigger: (key: TriggerKey): Effect.Effect<Option.Option<Trigger>, SqlError> =>
      Effect.map(
        sql<TriggerRow>`
          SELECT ${sql.literal(TRIGGER_COLUMNS)}
          FROM triggers JOIN workflows ON workflows.id = triggers.workflow_id
          WHERE triggers.workflow_id = ${uuidFromString(key.workflowId)}
            AND triggers.trigger_id = ${key.triggerId}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toTrigger),
      ),

    /**
     * Sets a start trigger's status. Returns whether the status changed:
     * setting the status it already has writes nothing, and leaves
     * `updated_at` as it was.
     */
    setTriggerStatus: (
      key: TriggerKey,
      status: TriggerStatus,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly trigger_id: string }>`
          UPDATE triggers SET status = ${status}, updated_at = ${at}
          WHERE workflow_id = ${uuidFromString(key.workflowId)} AND trigger_id = ${key.triggerId}
            AND kind = 'start' AND status IS NOT ${status}
          RETURNING trigger_id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns every start trigger that can start a run now: active, on an
     * enabled workflow. The event router reads them once per pass.
     */
    listRoutableStartTriggers: (): Effect.Effect<ReadonlyArray<RoutableStartTrigger>, SqlError> =>
      Effect.map(
        sql<{
          readonly workflow_id: Uint8Array;
          readonly trigger_id: string;
          readonly event_kind: string;
          readonly connection_id: string | null;
          readonly filter: string | null;
          readonly inputs: string | null;
          readonly health_error_stage: TriggerFailureStage | null;
        }>`
          SELECT triggers.workflow_id, triggers.trigger_id, triggers.event_kind,
                 triggers.connection_id, triggers.filter, triggers.inputs,
                 triggers.health_error_stage
          FROM triggers JOIN workflows ON workflows.id = triggers.workflow_id
          WHERE triggers.kind = 'start' AND triggers.status = 'active' AND workflows.enabled = 1
        `,
        (rows) =>
          rows.map((row) => ({
            workflowId: uuidToString(row.workflow_id),
            triggerId: row.trigger_id,
            eventKind: row.event_kind,
            connectionId: row.connection_id ?? undefined,
            filter: row.filter ?? undefined,
            inputs: row.inputs === null ? {} : (JSON.parse(row.inputs) as Record<string, string>),
            hasEvaluationError: row.health_error_stage === "evaluation",
          })),
      ),

    /**
     * Checks whether a start trigger can start a run now: it is active and
     * its workflow is enabled. A trigger that no longer exists cannot.
     */
    isRoutableStartTrigger: (key: TriggerKey): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly trigger_id: string }>`
          SELECT triggers.trigger_id
          FROM triggers JOIN workflows ON workflows.id = triggers.workflow_id
          WHERE triggers.workflow_id = ${uuidFromString(key.workflowId)}
            AND triggers.trigger_id = ${key.triggerId}
            AND triggers.kind = 'start' AND triggers.status = 'active' AND workflows.enabled = 1
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Records that a start trigger failed at `stage`, with the error message
     * and when it happened. Returns true when this failure turns the health
     * to a new error: the trigger was healthy until now, or its recorded error
     * was from another stage. A failure at the stage already recorded only
     * replaces the message, and keeps the time the error began.
     */
    recordTriggerFailure: (
      key: TriggerKey,
      stage: TriggerFailureStage,
      message: string,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const workflow = uuidFromString(key.workflowId);
        const turnedToError = yield* sql<{ readonly trigger_id: string }>`
          UPDATE triggers
          SET health_error_message = ${message}, health_error_stage = ${stage},
              health_error_at = ${at}
          WHERE workflow_id = ${workflow} AND trigger_id = ${key.triggerId}
            AND health_error_stage IS NOT ${stage}
          RETURNING trigger_id
        `;
        if (turnedToError.length > 0) return true;
        yield* sql`
          UPDATE triggers SET health_error_message = ${message}
          WHERE workflow_id = ${workflow} AND trigger_id = ${key.triggerId}
        `;
        return false;
      }),

    /**
     * Clears a start trigger's recorded error if it is from `stage`, and
     * returns whether it cleared one. An error from another stage stays,
     * because only that stage can tell when it is over.
     */
    clearTriggerFailure: (
      key: TriggerKey,
      stage: TriggerFailureStage,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly trigger_id: string }>`
          UPDATE triggers
          SET health_error_message = NULL, health_error_stage = NULL, health_error_at = NULL
          WHERE workflow_id = ${uuidFromString(key.workflowId)} AND trigger_id = ${key.triggerId}
            AND health_error_stage = ${stage}
          RETURNING trigger_id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns every trigger that names the Connection, whatever its kind or
     * status, sorted by workflow name and trigger id.
     */
    listTriggersNamingConnection: (
      connectionId: string,
    ): Effect.Effect<ReadonlyArray<TriggerNamingConnection>, SqlError> =>
      Effect.map(
        sql<{
          readonly workflow_id: Uint8Array;
          readonly workflow_name: string;
          readonly trigger_id: string;
        }>`
          SELECT triggers.workflow_id, ${sql.literal(NAME_FROM_DEFINITION)} AS workflow_name,
                 triggers.trigger_id
          FROM triggers JOIN workflows ON workflows.id = triggers.workflow_id
          WHERE triggers.connection_id = ${connectionId}
          ORDER BY workflow_name, triggers.trigger_id
        `,
        (rows) =>
          rows.map((row) => ({
            workflowId: uuidToString(row.workflow_id),
            workflowName: row.workflow_name,
            triggerId: row.trigger_id,
          })),
      ),

    /**
     * Returns the cron triggers the Scheduler has work for at `now`, the
     * earliest scheduled first:
     *
     * - the ones whose next scheduled time has come;
     * - the ones with no next scheduled time yet;
     * - the ones without a timezone of their own whose next scheduled time
     *   was computed in another timezone than `defaultTimezone`, because the
     *   user changed the setting since.
     *
     * Paused triggers and triggers of disabled workflows are included, so
     * their schedule keeps moving while they cannot fire.
     */
    listCronTriggersToSchedule: (
      now: string,
      defaultTimezone: string,
    ): Effect.Effect<ReadonlyArray<TriggerKey>, SqlError> =>
      Effect.map(
        sql<{ readonly workflow_id: Uint8Array; readonly trigger_id: string }>`
          SELECT triggers.workflow_id, triggers.trigger_id
          FROM triggers
          WHERE ${sql.literal(IS_CRON_TRIGGER)}
            AND (triggers.next_fire_at IS NULL OR triggers.next_fire_at <= ${now}
                 OR (triggers.timezone IS NULL AND triggers.next_fire_zone IS NOT ${defaultTimezone}))
          ORDER BY triggers.next_fire_at, triggers.workflow_id, triggers.trigger_id
        `,
        (rows) =>
          rows.map((row) => ({
            workflowId: uuidToString(row.workflow_id),
            triggerId: row.trigger_id,
          })),
      ),

    /** Returns a cron trigger with its schedule state, or `None` if it is gone or no longer a cron trigger. */
    readCronTrigger: (key: TriggerKey): Effect.Effect<Option.Option<CronTrigger>, SqlError> =>
      Effect.map(
        sql<{
          readonly schedule: string;
          readonly timezone: string | null;
          readonly can_fire: number;
          readonly next_fire_at: string | null;
          readonly next_fire_zone: string | null;
          readonly last_fired_at: string | null;
          readonly scheduling_error_message: string | null;
        }>`
          SELECT triggers.schedule, triggers.timezone,
                 triggers.status = 'active' AND workflows.enabled = 1 AS can_fire,
                 triggers.next_fire_at, triggers.next_fire_zone, triggers.last_fired_at,
                 CASE WHEN triggers.health_error_stage = 'scheduling'
                      THEN triggers.health_error_message END AS scheduling_error_message
          FROM triggers JOIN workflows ON workflows.id = triggers.workflow_id
          WHERE triggers.workflow_id = ${uuidFromString(key.workflowId)}
            AND triggers.trigger_id = ${key.triggerId}
            AND ${sql.literal(IS_CRON_TRIGGER)}
        `,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row) => ({
            workflowId: key.workflowId,
            triggerId: key.triggerId,
            schedule: row.schedule,
            timezone: row.timezone ?? undefined,
            canFire: row.can_fire === 1,
            nextFireAt: row.next_fire_at ?? undefined,
            nextFireZone: row.next_fire_zone ?? undefined,
            lastFiredAt: row.last_fired_at ?? undefined,
            schedulingErrorMessage: row.scheduling_error_message ?? undefined,
          })),
      ),

    /** Moves a cron trigger on to its next scheduled time, as `CronAdvance` describes. */
    advanceCronTrigger: (key: TriggerKey, advance: CronAdvance): Effect.Effect<void, SqlError> => {
      const assignments = [
        sql`next_fire_at = ${advance.nextFireAt}`,
        sql`next_fire_zone = ${advance.zone}`,
        ...(advance.firedAt === undefined ? [] : [sql`last_fired_at = ${advance.firedAt}`]),
        ...(advance.skipped === undefined
          ? []
          : [
              sql`skipped_from = ${advance.skipped.from}`,
              sql`skipped_until = ${advance.skipped.until}`,
            ]),
      ];
      return Effect.asVoid(sql`
        UPDATE triggers SET ${sql.csv(assignments)}
        WHERE workflow_id = ${uuidFromString(key.workflowId)} AND trigger_id = ${key.triggerId}
      `);
    },

    /**
     * Clears a cron trigger's next scheduled time, and the timezone it was
     * computed in, so the Scheduler computes both again.
     */
    unscheduleCronTrigger: (key: TriggerKey): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE triggers SET next_fire_at = NULL, next_fire_zone = NULL
        WHERE workflow_id = ${uuidFromString(key.workflowId)} AND trigger_id = ${key.triggerId}
      `),
  };
});

/** The repository of the `workflows` and `triggers` tables. */
export const workflowRepository = make;

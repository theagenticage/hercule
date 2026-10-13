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
  SpawnBound,
  Trigger,
  TriggerHealth,
  TriggerKey,
  TriggerKind,
  TriggerOn,
  TriggerFiresOn,
  TriggerPausedBy,
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
import { CONNECTION_PARAM } from "../plugins";
import { buildRunsInWindow, HELD_COUNT } from "./spawn-bounds";
import type { Input } from "./validation";

/** A YAML source and the definition it parses to. They are always stored together. */
export interface ParsedSource {
  readonly source: string;
  readonly definition: WorkflowDefinition;
}

/**
 * A stored workflow's definition and invalid mark, as validating the stored
 * workflows again reads them. `invalidSince` is when the workflow stopped
 * validating, and is absent while it is valid. `updatedAt` is when its source
 * last changed; `setInvalidSince` compares it to skip a workflow saved since
 * it was read.
 */
export interface StoredDefinition {
  readonly id: string;
  readonly name: string;
  /** The stored JSON, not yet decoded: an older controller may have stored a shape this one refuses. */
  readonly definition: unknown;
  readonly invalidSince: string | undefined;
  readonly updatedAt: string;
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
  /** A start trigger's own spawn bound, or `undefined` when its source sets none. */
  readonly spawnBound: SpawnBound | undefined;
}

/** What `reconcileTriggers` changed besides the trigger rows. */
export interface TriggerReconciliation {
  /**
   * The ids of the triggers that no longer exist: the deleted ones, and the
   * ones whose kind changed, since those were replaced.
   */
  readonly removedTriggerIds: ReadonlyArray<string>;
  /** How many held events the save discarded, over all of the workflow's triggers. */
  readonly discardedCount: number;
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
 * A start trigger the event router tests every event against: its workflow
 * is enabled and valid, and it is active or paused by the breaker. A trigger
 * the breaker paused still matches events, and holds each match until it is
 * resumed.
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
  /** The bound the trigger runs under: its own, or the default when its source sets none. */
  readonly spawnBound: SpawnBound;
}

/**
 * The status a start trigger is set to. A paused trigger records who paused
 * it: someone, manually, or the breaker when it matched more events than its
 * spawn bound allows.
 */
export type TriggerStatusChange =
  | { readonly status: "active" }
  | { readonly status: "paused"; readonly pausedBy: TriggerPausedBy };

/** A cron trigger's schedule and the Scheduler's state for it. */
export interface CronTrigger extends TriggerKey {
  readonly schedule: string;
  /** The trigger's own timezone. `undefined` means the user's timezone setting applies. */
  readonly timezone: string | undefined;
  /**
   * Whether a tick would be matched now: the trigger is active or paused by
   * the breaker, and its workflow is enabled and valid. A tick on a trigger
   * the breaker paused is held, not dropped.
   */
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

/** An action step that names a Connection in its `connection` param, with its workflow's name for a message. */
export interface StepNamingConnection {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly stepId: string;
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
  readonly on: TriggerFiresOn | undefined;
  /** Lists the triggers that accept events of this kind. A cron trigger accepts none. */
  readonly eventKind: string | undefined;
  readonly status: TriggerStatus | undefined;
}

interface WorkflowRow {
  readonly id: Uint8Array;
  readonly enabled: number;
  readonly source: string;
  readonly invalid_since: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SummaryRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: number;
  readonly invalid_since: string | null;
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
  readonly paused_by: TriggerPausedBy | null;
  /** Both NULL when the source sets no spawn bound, and always for a signal trigger. */
  readonly spawn_bound_max_runs: number | null;
  readonly spawn_bound_window_seconds: number | null;
  /** NULL for a signal trigger, as is `held_count`. */
  readonly runs_in_window: number | null;
  readonly held_count: number | null;
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
 * `isCronTriggerRow` reads a row by the same rule.
 *
 * This condition must stay the same, term for term, as the condition of the
 * partial index `triggers_cron_next_fire`. The index writes the columns
 * without the `triggers.` prefix, which is fine. SQLite uses a partial index
 * only when it can prove that the query's WHERE implies the index's
 * condition, and it proves that by matching the terms one by one. A term
 * written differently here, even with the same meaning, stops SQLite from
 * using the index.
 */
const IS_CRON_TRIGGER = `triggers.kind = 'start' AND triggers.event_kind = '${CRON_TICK_EVENT_KIND}'
  AND triggers.schedule IS NOT NULL`;

/** The tables a trigger is read from: its row, and its workflow for the name. */
const TRIGGERS_WITH_WORKFLOWS = "triggers JOIN workflows ON workflows.id = triggers.workflow_id";

/**
 * The condition a start trigger meets while it may start runs, whatever its
 * status: its workflow is enabled and valid. The conditions below add the
 * status. Each reads `triggers` and `workflows`.
 */
const IS_RUNNABLE_START_TRIGGER = `triggers.kind = 'start'
  AND workflows.enabled = 1 AND workflows.invalid_since IS NULL`;

/**
 * The condition a start trigger meets while the event router matches events
 * against it, and while its pending rows start their runs: it is runnable,
 * and active or paused by the breaker. The pending rows a trigger had when
 * the breaker tripped were within its bound, so they still start.
 */
export const IS_ROUTABLE_START_TRIGGER = `${IS_RUNNABLE_START_TRIGGER}
  AND (triggers.status = 'active' OR triggers.paused_by = 'breaker')`;

/**
 * The condition a start trigger meets while its held events move on to
 * `pending` as its window has room: it is runnable and active.
 */
export const IS_PROMOTABLE_START_TRIGGER = `${IS_RUNNABLE_START_TRIGGER}
  AND triggers.status = 'active'`;

/**
 * The columns of a trigger's row that decide which events it matches and
 * what it maps them to: everything the source declares but its spawn bound.
 */
const MATCHING_COLUMNS = "kind, event_kind, connection_id, filter, schedule, timezone, inputs";

/** `MATCHING_COLUMNS` of the stored row, in an upsert. */
const MATCHING_COLUMNS_OF_ROW = MATCHING_COLUMNS.split(", ")
  .map((column) => `triggers.${column}`)
  .join(", ");

/** `MATCHING_COLUMNS` of the row an upsert would insert. */
const MATCHING_COLUMNS_OF_EXCLUDED = MATCHING_COLUMNS.split(", ")
  .map((column) => `excluded.${column}`)
  .join(", ");

const WORKFLOW_COLUMNS = "id, enabled, source, invalid_since, created_at, updated_at";

const toWorkflow = (row: WorkflowRow): Workflow => ({
  id: uuidToString(row.id),
  enabled: row.enabled === 1,
  source: row.source,
  ...(row.invalid_since === null ? {} : { invalidSince: row.invalid_since }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toSummary = (row: SummaryRow): WorkflowSummary => ({
  id: uuidToString(row.id),
  name: row.name,
  ...(row.description === null ? {} : { description: row.description }),
  enabled: row.enabled === 1,
  ...(row.invalid_since === null ? {} : { invalidSince: row.invalid_since }),
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

/**
 * Returns the spawn bound a trigger runs under, from its `spawn_bound_*`
 * columns: its own, or `defaultBound` when its source sets none. The two
 * columns are both set or both NULL, which a check on the table enforces.
 */
const resolveSpawnBound = (
  row: Pick<TriggerRow, "spawn_bound_max_runs" | "spawn_bound_window_seconds">,
  defaultBound: SpawnBound,
): SpawnBound =>
  row.spawn_bound_max_runs === null || row.spawn_bound_window_seconds === null
    ? defaultBound
    : { maxRuns: row.spawn_bound_max_runs, windowSeconds: row.spawn_bound_window_seconds };

/**
 * Maps a trigger row to a `Trigger`. A NULL column becomes an absent field,
 * not `null`. `defaultBound` is the spawn bound of a start trigger whose
 * source sets none.
 */
const toTrigger = (row: TriggerRow, defaultBound: SpawnBound): Trigger => ({
  workflowId: uuidToString(row.workflow_id),
  workflowName: row.workflow_name,
  triggerId: row.trigger_id,
  kind: row.kind,
  on: buildTriggerOn(row),
  ...(row.status === null ? {} : { status: row.status }),
  ...(row.paused_by === null ? {} : { pausedBy: row.paused_by }),
  ...(row.kind === "start"
    ? {
        spawnBound: {
          ...resolveSpawnBound(row, defaultBound),
          isDefault: row.spawn_bound_max_runs === null,
        },
        runsInWindow: row.runs_in_window ?? 0,
        heldCount: row.held_count ?? 0,
        health: readHealth(row),
      }
    : {}),
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

  /**
   * Builds the columns a `TriggerRow` is read from `TRIGGERS_WITH_WORKFLOWS`.
   * A start trigger's runs in its window are counted for the window that
   * ends at `now`, as `buildRunsInWindow` describes. `defaultBound` is the
   * bound of a trigger whose source sets none.
   */
  const buildTriggerColumns = (defaultBound: SpawnBound, now: string): Fragment => sql`
    triggers.workflow_id, ${sql.literal(NAME_FROM_DEFINITION)} AS workflow_name,
    triggers.trigger_id, triggers.kind, triggers.event_kind, triggers.connection_id,
    triggers.filter, triggers.schedule, triggers.timezone, triggers.status, triggers.paused_by,
    triggers.spawn_bound_max_runs, triggers.spawn_bound_window_seconds,
    CASE WHEN triggers.kind = 'start' THEN ${buildRunsInWindow(sql, defaultBound, now)} END
      AS runs_in_window,
    CASE WHEN triggers.kind = 'start' THEN ${sql.literal(HELD_COUNT)} END AS held_count,
    triggers.health_error_message, triggers.health_error_at, triggers.next_fire_at,
    triggers.last_fired_at, triggers.skipped_from, triggers.skipped_until,
    triggers.created_at, triggers.updated_at
  `;

  const read = (id: string): Effect.Effect<Option.Option<Workflow>, SqlError> =>
    Effect.map(
      sql<WorkflowRow>`
        SELECT ${sql.literal(WORKFLOW_COLUMNS)} FROM workflows WHERE id = ${uuidFromString(id)}
      `,
      (rows) => Option.map(Option.fromNullishOr(rows[0]), toWorkflow),
    );

  return {
    read,

    /** Returns a workflow's name, or `None` if no workflow has the id. */
    readName: (id: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly name: string }>`
          SELECT ${sql.literal(NAME_FROM_DEFINITION)} AS name FROM workflows
          WHERE id = ${uuidFromString(id)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.name),
      ),

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

    /**
     * Returns the id and the stored definition of every workflow `run.start`
     * accepts, oldest first: enabled, and not marked invalid. A new signal
     * reads it to offer Hand to an agent, one action per such workflow with
     * a signal input that accepts its kind. An invalid workflow is left out
     * because `run.start` would refuse the click.
     */
    listRunnableDefinitions: (): Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly definition: WorkflowDefinition }>,
      SqlError
    > =>
      Effect.map(
        sql<{ readonly id: Uint8Array; readonly definition: string }>`
          SELECT id, definition FROM workflows
          WHERE enabled = 1 AND invalid_since IS NULL ORDER BY created_at, id
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            definition: JSON.parse(row.definition) as WorkflowDefinition,
          })),
      ),

    /**
     * Returns the declared inputs of each stored workflow with one of the
     * ids, by workflow id. A workflow that declares no inputs has an empty
     * list, and an id no workflow has is not in the map.
     */
    readInputs: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<Input>>, SqlError> =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly id: Uint8Array; readonly inputs: string | null }>`
              SELECT id, json_extract(definition, '$.inputs') AS inputs
              FROM workflows WHERE id IN ${sql.in(ids.map(uuidFromString))}
            `,
            (rows) =>
              new Map(
                rows.map((row) => [
                  uuidToString(row.id),
                  row.inputs === null ? [] : (JSON.parse(row.inputs) as ReadonlyArray<Input>),
                ]),
              ),
          ),

    /**
     * Returns every stored workflow's definition and invalid mark, oldest
     * first. Validating the stored workflows again reads it.
     */
    listStoredDefinitions: (): Effect.Effect<ReadonlyArray<StoredDefinition>, SqlError> =>
      Effect.map(
        sql<{
          readonly id: Uint8Array;
          readonly name: string;
          readonly definition: string;
          readonly invalid_since: string | null;
          readonly updated_at: string;
        }>`
          SELECT id, ${sql.literal(NAME_FROM_DEFINITION)} AS name, definition, invalid_since,
                 updated_at
          FROM workflows ORDER BY created_at, id
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            name: row.name,
            definition: JSON.parse(row.definition) as unknown,
            invalidSince: row.invalid_since ?? undefined,
            updatedAt: row.updated_at,
          })),
      ),

    /**
     * Sets when a workflow stopped validating, or clears the mark with
     * `undefined`, but only while the row still has the `updatedAt` and the
     * mark that `seen` holds. Returns whether it wrote.
     *
     * The caller judged the workflow outside a transaction, so a save may
     * have changed the row since it was read. That save validated its own
     * source and set the mark itself, so it wins. Does not change
     * `updated_at`, because the source did not change.
     */
    setInvalidSince: (
      seen: Pick<StoredDefinition, "id" | "updatedAt" | "invalidSince">,
      since: string | undefined,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE workflows SET invalid_since = ${since ?? null}
          WHERE id = ${uuidFromString(seen.id)} AND updated_at = ${seen.updatedAt}
            AND invalid_since IS ${seen.invalidSince ?? null}
          RETURNING id
        `,
        (rows) => rows.length > 0,
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
     * Writing a source clears `invalid_since`, even when the source is the same:
     * the caller validated it just before, so the workflow is valid now.
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
          // The service writes only a source that validated, so a source
          // write also clears the invalid mark.
          assignments.push(
            sql`source = ${bindExactText(edit.parsedSource.source)}`,
            sql`definition = ${JSON.stringify(edit.parsedSource.definition)}`,
            sql`invalid_since = NULL`,
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
          sort: [{ field: "updatedAt", direction: request.direction }],
        };
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "updated_at", direction: request.direction }],
          ["id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const clauses = [keyset];
        if (request.enabled !== undefined) {
          clauses.push(sql`enabled = ${request.enabled ? 1 : 0}`);
        }
        const rows = yield* sql<SummaryRow>`
          SELECT id, ${sql.literal(NAME_FROM_DEFINITION)} AS name,
                 json_extract(definition, '$.description') AS description, enabled, invalid_since,
                 updated_at
          FROM workflows WHERE ${sql.and(clauses)} ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toSummary)),
          (last) => encodeCursor(scope, [last.updatedAt], last.id),
        );
      }),

    /**
     * Updates a workflow's trigger rows to match the triggers its source
     * declares. Each trigger's `on` is stored in the columns of its row by the
     * rule described at `IS_CRON_TRIGGER`.
     *
     * - A trigger whose id is no longer in the source is deleted, with the
     *   events it held.
     * - A trigger with a new id is inserted, with status `active` for a start
     *   trigger and no status for a signal trigger.
     * - A trigger whose id stays keeps its row, `created_at`, status and who
     *   paused it. Its other fields are overwritten from the source, and
     *   `updated_at` changes only if one of them changed. A change also
     *   clears the trigger's health, because the error it records was about
     *   the old definition. A trigger that did not change keeps its error,
     *   which is still true.
     * - A start trigger whose `on`, filter or inputs changed discards the
     *   events it held, because the old definition matched them and mapped
     *   their inputs. A change of the spawn bound alone keeps them.
     * - A cron trigger whose schedule or timezone changed has its next
     *   scheduled time cleared, so the Scheduler computes it again. A cron
     *   trigger whose schedule is replaced by an event selector loses all of
     *   its schedule state.
     * - A trigger whose id stays but whose kind changes counts as a new
     *   trigger, because a start trigger and a signal trigger are different
     *   things. It gets a new `created_at`, a start trigger is `active`
     *   again, and the events the old trigger held are discarded.
     *
     * Returns the ids of the triggers that no longer exist, and how many held
     * events the save discarded, the deleted triggers' included.
     */
    reconcileTriggers: (
      workflowId: string,
      triggers: ReadonlyArray<DeclaredTrigger>,
      savedAt: string,
    ): Effect.Effect<TriggerReconciliation, SqlError> =>
      Effect.gen(function* () {
        const workflow = uuidFromString(workflowId);
        const kept = triggers.map((trigger) => trigger.triggerId);
        const isRemoved = kept.length === 0 ? sql`1 = 1` : sql`trigger_id NOT IN ${sql.in(kept)}`;
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
        // Deleting a trigger deletes its rows through the foreign key, so its
        // held events are counted first.
        const heldByRemoved = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM trigger_effects
          WHERE workflow_id = ${workflow} AND ${isRemoved} AND state = 'held'
        `;
        let discardedCount = heldByRemoved[0]?.count ?? 0;
        const deleted = yield* sql<{ readonly trigger_id: string }>`
          DELETE FROM triggers WHERE workflow_id = ${workflow} AND ${isRemoved}
          RETURNING trigger_id
        `;
        for (const trigger of triggers) {
          const columns = buildOnColumns(trigger.on);
          // The columns that decide which events the trigger matches and
          // what it maps them to, in the order of `MATCHING_COLUMNS`.
          const matching = sql`
            ${trigger.kind}, ${bindExactText(columns.eventKind)}, ${columns.connectionId ?? null},
            ${bindOptionalText(columns.filter)}, ${bindOptionalText(columns.schedule)},
            ${bindOptionalText(columns.timezone)},
            ${bindOptionalText(trigger.inputs === undefined ? undefined : JSON.stringify(trigger.inputs))}
          `;
          const discarded = yield* sql<{ readonly id: number }>`
            UPDATE trigger_effects SET state = 'discarded'
            WHERE workflow_id = ${workflow} AND trigger_id = ${trigger.triggerId}
              AND state = 'held'
              AND EXISTS (
                SELECT 1 FROM triggers
                WHERE triggers.workflow_id = ${workflow} AND triggers.trigger_id = ${trigger.triggerId}
                  AND (${sql.literal(MATCHING_COLUMNS_OF_ROW)}) IS NOT (${matching}))
            RETURNING id
          `;
          discardedCount += discarded.length;
          yield* sql`
            INSERT INTO triggers
              (workflow_id, trigger_id, ${sql.literal(MATCHING_COLUMNS)},
               spawn_bound_max_runs, spawn_bound_window_seconds, status, created_at, updated_at)
            VALUES
              (${workflow}, ${trigger.triggerId}, ${matching},
               ${trigger.spawnBound?.maxRuns ?? null}, ${trigger.spawnBound?.windowSeconds ?? null},
               ${trigger.kind === "start" ? "active" : null}, ${savedAt}, ${savedAt})
            ON CONFLICT (workflow_id, trigger_id) DO UPDATE SET
              kind = excluded.kind,
              event_kind = excluded.event_kind,
              connection_id = excluded.connection_id,
              filter = excluded.filter,
              schedule = excluded.schedule,
              timezone = excluded.timezone,
              inputs = excluded.inputs,
              spawn_bound_max_runs = excluded.spawn_bound_max_runs,
              spawn_bound_window_seconds = excluded.spawn_bound_window_seconds,
              status = CASE WHEN triggers.kind = excluded.kind THEN triggers.status
                            ELSE excluded.status END,
              paused_by = CASE WHEN triggers.kind = excluded.kind THEN triggers.paused_by END,
              -- The count is kept only while the held events it counted are.
              held_at_resume = CASE
                WHEN (${sql.literal(MATCHING_COLUMNS_OF_ROW)}) IS (${sql.literal(MATCHING_COLUMNS_OF_EXCLUDED)})
                THEN triggers.held_at_resume END,
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
            WHERE (${sql.literal(MATCHING_COLUMNS_OF_ROW)}, triggers.spawn_bound_max_runs,
                   triggers.spawn_bound_window_seconds)
               IS NOT (${sql.literal(MATCHING_COLUMNS_OF_EXCLUDED)}, excluded.spawn_bound_max_runs,
                       excluded.spawn_bound_window_seconds)
          `;
        }
        return {
          removedTriggerIds: [...deleted.map((row) => row.trigger_id), ...replaced],
          discardedCount,
        };
      }),

    /**
     * Returns a page of triggers. A start trigger's spawn bound is
     * `defaultBound` when its source sets none, and its runs in the window
     * are counted for the window that ends at `now`.
     */
    listTriggers: (
      request: TriggerPageRequest,
      defaultBound: SpawnBound,
      now: string,
    ): Effect.Effect<Page<Trigger>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope: CursorScope = {
          op: "trigger.query",
          sort: [{ field: "createdAt", direction: request.direction }],
        };
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeOwnedCursor(request.cursor, scope);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "triggers.created_at", direction: request.direction }],
          ["triggers.workflow_id", "triggers.trigger_id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1]), after[2]],
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
          SELECT ${buildTriggerColumns(defaultBound, now)}
          FROM ${sql.literal(TRIGGERS_WITH_WORKFLOWS)}
          WHERE ${sql.and(clauses)} ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map((row) => toTrigger(row, defaultBound))),
          (last) => encodeOwnedCursor(scope, last.createdAt, last.workflowId, last.triggerId),
        );
      }),

    /**
     * Returns one trigger, or `None` if its workflow declares no trigger with
     * the id. `defaultBound` and `now` are as in `listTriggers`.
     */
    readTrigger: (
      key: TriggerKey,
      defaultBound: SpawnBound,
      now: string,
    ): Effect.Effect<Option.Option<Trigger>, SqlError> =>
      Effect.map(
        sql<TriggerRow>`
          SELECT ${buildTriggerColumns(defaultBound, now)}
          FROM ${sql.literal(TRIGGERS_WITH_WORKFLOWS)}
          WHERE triggers.workflow_id = ${uuidFromString(key.workflowId)}
            AND triggers.trigger_id = ${key.triggerId}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => toTrigger(row, defaultBound)),
      ),

    /** Returns a trigger's kind, or `None` if its workflow declares no trigger with the id. */
    readTriggerKind: (key: TriggerKey): Effect.Effect<Option.Option<TriggerKind>, SqlError> =>
      Effect.map(
        sql<{ readonly kind: TriggerKind }>`
          SELECT kind FROM triggers
          WHERE workflow_id = ${uuidFromString(key.workflowId)} AND trigger_id = ${key.triggerId}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.kind),
      ),

    /**
     * Sets a start trigger's status, and who paused it. Returns whether
     * either changed: setting what the trigger already has writes nothing,
     * and leaves `updated_at` as it was.
     */
    setTriggerStatus: (
      key: TriggerKey,
      change: TriggerStatusChange,
      at: string,
    ): Effect.Effect<boolean, SqlError> => {
      const pausedBy = change.status === "paused" ? change.pausedBy : null;
      return Effect.map(
        sql<{ readonly trigger_id: string }>`
          UPDATE triggers SET status = ${change.status}, paused_by = ${pausedBy}, updated_at = ${at}
          WHERE workflow_id = ${uuidFromString(key.workflowId)} AND trigger_id = ${key.triggerId}
            AND kind = 'start' AND (status, paused_by) IS NOT (${change.status}, ${pausedBy})
          RETURNING trigger_id
        `,
        (rows) => rows.length > 0,
      );
    },

    /**
     * Returns every start trigger the event router matches events against,
     * as `IS_ROUTABLE_START_TRIGGER` describes. The event router reads them
     * once per pass. A trigger's spawn bound is `defaultBound` when its
     * source sets none.
     */
    listRoutableStartTriggers: (
      defaultBound: SpawnBound,
    ): Effect.Effect<ReadonlyArray<RoutableStartTrigger>, SqlError> =>
      Effect.map(
        sql<{
          readonly workflow_id: Uint8Array;
          readonly trigger_id: string;
          readonly event_kind: string;
          readonly connection_id: string | null;
          readonly filter: string | null;
          readonly inputs: string | null;
          readonly health_error_stage: TriggerFailureStage | null;
          readonly spawn_bound_max_runs: number | null;
          readonly spawn_bound_window_seconds: number | null;
        }>`
          SELECT triggers.workflow_id, triggers.trigger_id, triggers.event_kind,
                 triggers.connection_id, triggers.filter, triggers.inputs,
                 triggers.health_error_stage, triggers.spawn_bound_max_runs,
                 triggers.spawn_bound_window_seconds
          FROM ${sql.literal(TRIGGERS_WITH_WORKFLOWS)}
          WHERE ${sql.literal(IS_ROUTABLE_START_TRIGGER)}
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
            spawnBound: resolveSpawnBound(row, defaultBound),
          })),
      ),

    /**
     * Checks whether a start trigger's pending rows may start their runs: it
     * meets `IS_ROUTABLE_START_TRIGGER`. Most rows that would fail never reach
     * this check:
     *
     * - a manual pause holds the trigger's pending rows;
     * - the pending rows of an invalid workflow are not read for delivery;
     * - a deleted trigger's rows are deleted with it.
     *
     * So in practice a failing row belongs to a workflow that was disabled
     * after the event matched.
     */
    acceptsPendingEffects: (key: TriggerKey): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly trigger_id: string }>`
          SELECT triggers.trigger_id
          FROM ${sql.literal(TRIGGERS_WITH_WORKFLOWS)}
          WHERE triggers.workflow_id = ${uuidFromString(key.workflowId)}
            AND triggers.trigger_id = ${key.triggerId}
            AND ${sql.literal(IS_ROUTABLE_START_TRIGGER)}
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns every start trigger that holds events and meets
     * `IS_PROMOTABLE_START_TRIGGER`. Starting held events reads it. The
     * query starts from the held rows, so it reads only the triggers that
     * hold some.
     */
    listTriggersWithHeldEvents: (): Effect.Effect<ReadonlyArray<TriggerKey>, SqlError> =>
      Effect.map(
        sql<{ readonly workflow_id: Uint8Array; readonly trigger_id: string }>`
          SELECT DISTINCT held.workflow_id, held.trigger_id
          FROM trigger_effects AS held
          JOIN triggers ON triggers.workflow_id = held.workflow_id
                       AND triggers.trigger_id = held.trigger_id
          JOIN workflows ON workflows.id = triggers.workflow_id
          WHERE held.state = 'held' AND ${sql.literal(IS_PROMOTABLE_START_TRIGGER)}
        `,
        (rows) =>
          rows.map((row) => ({
            workflowId: uuidToString(row.workflow_id),
            triggerId: row.trigger_id,
          })),
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
     * Returns every action step whose `connection` param is the Connection's
     * id, written as a literal, sorted by workflow name and step id. A step
     * whose param is a template reads its Connection from an input that each
     * run fills in, so it is not returned.
     *
     * Steps are not stored in a table of their own, so this reads each
     * stored definition's `steps` array.
     */
    listStepsNamingConnection: (
      connectionId: string,
    ): Effect.Effect<ReadonlyArray<StepNamingConnection>, SqlError> =>
      Effect.map(
        sql<{
          readonly workflow_id: Uint8Array;
          readonly workflow_name: string;
          readonly step_id: string;
        }>`
          SELECT workflows.id AS workflow_id, ${sql.literal(NAME_FROM_DEFINITION)} AS workflow_name,
                 json_extract(step.value, '$.id') AS step_id
          FROM workflows, json_each(workflows.definition, '$.steps') AS step
          WHERE json_extract(step.value, '$.kind') = 'action'
            AND json_extract(step.value, ${`$.params.${CONNECTION_PARAM}`}) = ${connectionId}
          ORDER BY workflow_name, step_id
        `,
        (rows) =>
          rows.map((row) => ({
            workflowId: uuidToString(row.workflow_id),
            workflowName: row.workflow_name,
            stepId: row.step_id,
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
                 ${sql.literal(IS_ROUTABLE_START_TRIGGER)} AS can_fire,
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

/**
 * Workflows as the API sees them: `workflow.query`, `read`, `create`, `update`
 * and `delete`, and `trigger.query` over the triggers their sources declare.
 *
 * The text is the truth (ADR 0029). The stored source is only ever the text a
 * caller sent, or the canonical text of the definition object a caller sent,
 * and the stored definition is only ever what that source parses to. Turning a
 * workflow on or off writes neither. A source is parsed and checked before any
 * row is written, so a refused save leaves the stored workflow as it was.
 *
 * The trigger rows are written in the transaction that writes the workflow, so
 * a listing never shows the triggers of a source that was not stored.
 *
 * Every mutation writes one event in that transaction too. The actor is
 * stamped here, on the event envelope, and the event names the workflow, so a
 * client that watches the `workflow` topic is told once the write commits.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  decodeWorkflowDefinition,
  DEFAULT_PAGE_LIMIT,
  Id,
  notFound,
  parseWorkflowSource,
  renderWorkflowSource,
  TRIGGER_SORT_FIELDS,
  TriggerFilter,
  validation,
  validationOf,
  WORKFLOW_SORT_FIELDS,
  WORKFLOW_UPDATE_FIELDS,
  WorkflowCreateInput,
  WorkflowFilter,
  type Forbidden,
  type NotFound,
  type SortDirection,
  type Trigger,
  type Unauthenticated,
  type Validation,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowSaved,
  type WorkflowSummary,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { workflowRepository, type DeclaredTrigger, type ParsedSource } from "./repository";

const QueryInput = Schema.Struct({
  ...WorkflowFilter.fields,
  ...pageInput(WORKFLOW_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...WORKFLOW_UPDATE_FIELDS });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const TriggerQueryInput = Schema.Struct({
  ...TriggerFilter.fields,
  ...pageInput(TRIGGER_SORT_FIELDS),
});

export type TriggerQueryInput = Schema.Schema.Type<typeof TriggerQueryInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(WorkflowCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeTriggerQuery = Schema.decodeUnknownEffect(TriggerQueryInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

export interface WorkflowPage {
  readonly items: ReadonlyArray<WorkflowSummary>;
  readonly nextCursor?: string;
}

export interface TriggerPage {
  readonly items: ReadonlyArray<Trigger>;
  readonly nextCursor?: string;
}

/**
 * Both listings answer the newest first when the caller names no direction:
 * the workflow changed last, and the trigger added last. A listing is read to
 * find what was worked on.
 */
const DEFAULT_DIRECTION: SortDirection = "desc";

const NO_SUCH_WORKFLOW = "no such workflow";

/** Why a save that sends the text and the object together is refused. */
const SOURCE_AND_DEFINITION_TOGETHER =
  "Send source or definition, not the two together. The stored text comes from one of them.";

/**
 * The text a save stores: the text the caller sent, or the canonical text of
 * the definition object the caller sent. `undefined` where the caller sent
 * neither. A definition object is checked before it is written as text, with
 * the check a parsed text gets, so its problems are named at the same paths.
 */
const chooseText = (input: {
  readonly source?: string;
  readonly definition?: unknown;
}): Effect.Effect<string | undefined, Validation> => {
  if (input.source !== undefined && input.definition !== undefined) {
    return Effect.fail(validation([{ path: [], message: SOURCE_AND_DEFINITION_TOGETHER }]));
  }
  if (input.definition === undefined) return Effect.succeed(input.source);
  const decoded = decodeWorkflowDefinition(input.definition);
  return Result.isSuccess(decoded)
    ? Effect.succeed(renderWorkflowSource(decoded.success))
    : Effect.fail(validation(decoded.failure));
};

/**
 * The definition a text says, or the refusal that names every problem in it.
 * Every save runs its text through this one place, the rendered text of a
 * definition object included, and nothing is written before it answers.
 */
const requireValidDefinition = (source: string): Effect.Effect<ParsedSource, Validation> => {
  const parsed = parseWorkflowSource(source);
  return Result.isSuccess(parsed)
    ? Effect.succeed({ source, definition: parsed.success })
    : Effect.fail(validation(parsed.failure));
};

/** The rows a definition's triggers are listed by, one each. */
const buildDeclaredTriggers = (definition: WorkflowDefinition): ReadonlyArray<DeclaredTrigger> =>
  (definition.triggers ?? []).map((trigger) => ({
    triggerId: trigger.id,
    kind: trigger.kind,
    eventKind: trigger.source.kind,
    connectionId: trigger.source.connectionId,
    filter: trigger.source.filter,
    schedule: trigger.kind === "start" ? trigger.schedule : undefined,
    timezone: trigger.kind === "start" ? trigger.timezone : undefined,
  }));

/** How every call can refuse, or fail on the database. */
type CallError = Unauthenticated | Forbidden | Validation | SqlError;

/** Answers the workflow an effect found, or `not_found` where it found none. */
const requireFound = <A, E>(
  found: Effect.Effect<Option.Option<A>, E>,
): Effect.Effect<A, E | NotFound> =>
  Effect.flatMap(
    found,
    Option.match({
      onNone: () => Effect.fail(notFound(NO_SUCH_WORKFLOW)),
      onSome: Effect.succeed,
    }),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workflows = yield* workflowRepository;
  const audit = yield* AuditLog;

  return {
    /** One page of the workflows, the one changed last first. */
    query: (input: QueryInput): Effect.Effect<WorkflowPage, CallError> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.query");
        const { limit, cursor, sort, enabled } = yield* Effect.mapError(
          decodeQuery(input),
          validationOf,
        );
        const listing = yield* refuseCursor(
          workflows.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            enabled,
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (input: Identified): Effect.Effect<Workflow, CallError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* requireFound(workflows.read(id));
      }),

    /** Stores a new workflow, off, from a text or from a definition object. */
    create: (input: WorkflowCreateInput): Effect.Effect<WorkflowSaved, CallError> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), validationOf);
        const text = yield* chooseText(decoded);
        if (text === undefined) {
          return yield* Effect.fail(
            validation([{ path: [], message: "Send the workflow as source or as definition." }]),
          );
        }
        const parsedSource = yield* requireValidDefinition(text);
        const workflow = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // One clock read, inside the transaction: the workflow, its
            // triggers and the event that records them carry one instant.
            const savedAt = yield* nowIso;
            const stored = yield* workflows.insert(parsedSource, savedAt);
            yield* workflows.reconcileTriggers(
              stored.id,
              buildDeclaredTriggers(parsedSource.definition),
              savedAt,
            );
            yield* audit.append({
              kind: "workflow.created",
              actor: yield* currentStamp,
              record: { topic: "workflow", id: stored.id },
              // The id and the name only. The source holds the prompts the
              // workflow's agents are given, and the log is read more widely.
              payload: { workflowId: stored.id, name: parsedSource.definition.name },
              at: savedAt,
            });
            return stored;
          }),
        );
        return { workflow, warnings: [] };
      }),

    /**
     * Changes a workflow's text, or turns it on or off. A new text takes the
     * place of the old one whole, and the trigger rows follow it.
     */
    update: (input: UpdateInput): Effect.Effect<WorkflowSaved, CallError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.update");
        const decoded = yield* Effect.mapError(decodeUpdate(input), validationOf);
        const text = yield* chooseText(decoded);
        if (text === undefined && decoded.enabled === undefined) {
          return yield* Effect.fail(validation([{ path: [], message: "name a field to change" }]));
        }
        const parsedSource = text === undefined ? undefined : yield* requireValidDefinition(text);
        const workflow = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const savedAt = yield* nowIso;
            const stored = yield* requireFound(
              workflows.update(
                decoded.id,
                {
                  ...(parsedSource === undefined ? {} : { parsedSource }),
                  ...(decoded.enabled === undefined ? {} : { enabled: decoded.enabled }),
                },
                savedAt,
              ),
            );
            if (parsedSource !== undefined) {
              yield* workflows.reconcileTriggers(
                stored.id,
                buildDeclaredTriggers(parsedSource.definition),
                savedAt,
              );
            }
            yield* audit.append({
              kind: "workflow.updated",
              actor: yield* currentStamp,
              record: { topic: "workflow", id: stored.id },
              // Which of the two changed, never the new text.
              payload: {
                workflowId: stored.id,
                changed: [
                  ...(parsedSource === undefined ? [] : ["source"]),
                  ...(decoded.enabled === undefined ? [] : ["enabled"]),
                ],
              },
              at: savedAt,
            });
            return stored;
          }),
        );
        return { workflow, warnings: [] };
      }),

    /** Removes a workflow, and the trigger rows of its source with it. */
    delete: (input: Identified): Effect.Effect<Record<string, never>, CallError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.delete");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const deletedAt = yield* nowIso;
            const name = yield* requireFound(workflows.delete(id));
            yield* audit.append({
              kind: "workflow.deleted",
              actor: yield* currentStamp,
              record: { topic: "workflow", id },
              payload: { workflowId: id, name },
              at: deletedAt,
            });
          }),
        );
        return {};
      }),

    /** One page of the triggers of every workflow, the newest first. */
    queryTriggers: (input: TriggerQueryInput): Effect.Effect<TriggerPage, CallError> =>
      Effect.gen(function* () {
        yield* requireGrant("trigger.query");
        const { limit, cursor, sort, ...filter } = yield* Effect.mapError(
          decodeTriggerQuery(input),
          validationOf,
        );
        const listing = yield* refuseCursor(
          workflows.listTriggers({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            workflowId: filter.workflowId,
            kind: filter.kind,
            eventKind: filter.eventKind,
            status: filter.status,
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),
  };
});

/** The workflow service. */
export class WorkflowService extends Context.Service<
  WorkflowService,
  Effect.Success<typeof make>
>()("hercule/controller/workflows/WorkflowService") {}

export const WorkflowServiceLayer: Layer.Layer<
  WorkflowService,
  never,
  SqlClient.SqlClient | AuditLog
> = Layer.effect(WorkflowService)(make);

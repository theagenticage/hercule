/**
 * The workflow operations: `workflow.query`, `read`, `create`, `update`,
 * `delete` and `validate`, and `trigger.query`, which lists the triggers that
 * the stored workflows declare.
 *
 * The YAML source is the source of truth (ADR 0029). The stored source is
 * either the YAML a caller sent, or the YAML generated from the definition
 * object a caller sent. The stored definition is always the result of parsing
 * the stored source. Enabling or disabling a workflow changes neither.
 *
 * A save parses and validates the workflow before it writes any row, so a
 * failed save leaves the stored workflow unchanged. `validate` runs the same
 * checks as a save, so an editor that shows the result of `validate` shows
 * the errors that a save would return.
 *
 * A save writes the workflow, its trigger rows and one audit event in a single
 * transaction. So a trigger listing never shows the triggers of a workflow
 * that failed to save. The event holds the actor and the workflow's id, so a
 * client that watches the `workflow` topic learns about the change after it
 * commits.
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
  createDecodeValidationError,
  createNotFoundError,
  createValidationError,
  decodeWorkflowDefinition,
  DEFAULT_PAGE_LIMIT,
  Id,
  parseWorkflowSource,
  renderWorkflowSource,
  TRIGGER_SORT_FIELDS,
  TriggerFilter,
  WORKFLOW_SORT_FIELDS,
  WORKFLOW_UPDATE_FIELDS,
  WorkflowCreateInput,
  WorkflowFilter,
  WorkflowValidateInput,
  type Forbidden,
  type Issue,
  type NotFound,
  type SortDirection,
  type Trigger,
  type Unauthenticated,
  type Validation,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowIssues,
  type WorkflowSaveResult,
  type WorkflowSummary,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { agentRepository } from "../agents";
import { connectionRepository } from "../connections";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog, EventKinds } from "../events";
import { PluginHost } from "../plugins";
import { workflowRepository, type DeclaredTrigger, type ParsedSource } from "./repository";
import {
  listReferencedAgentIds,
  listReferencedConnectionIds,
  validateDefinition,
  type ResolvedReferences,
} from "./validation";

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
const decodeValidate = Schema.decodeUnknownEffect(WorkflowValidateInput);
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
 * Both listings return the newest first when the caller gives no sort
 * direction: the most recently changed workflow, and the most recently added
 * trigger. People usually open a listing to find what they worked on last.
 */
const DEFAULT_DIRECTION: SortDirection = "desc";

const NO_SUCH_WORKFLOW = "no such workflow";

const SOURCE_AND_DEFINITION_TOGETHER =
  "The request sent both source and definition. Send only one of them: the workflow is stored from one or the other.";

const NO_CONTENT =
  "The request sent no workflow. Send it as source (YAML text) or as definition (an object).";

/** A workflow as a request sent it: as YAML source, or as a definition object. */
type WorkflowContent =
  | { readonly source: string; readonly definition?: undefined }
  | { readonly source?: undefined; readonly definition: unknown };

/**
 * Returns the workflow a request sent, or `undefined` if it sent none. Fails
 * with a `Validation` error if the request sent both source and definition,
 * because the stored YAML can come from only one of them.
 */
const chooseContent = (input: {
  readonly source?: string;
  readonly definition?: unknown;
}): Effect.Effect<WorkflowContent | undefined, Validation> => {
  if (input.source !== undefined && input.definition !== undefined) {
    return Effect.fail(
      createValidationError([{ path: [], message: SOURCE_AND_DEFINITION_TOGETHER }]),
    );
  }
  if (input.source !== undefined) return Effect.succeed({ source: input.source });
  if (input.definition !== undefined) return Effect.succeed({ definition: input.definition });
  return Effect.succeed(undefined);
};

/** Same as `chooseContent`, but also fails with a `Validation` error if the request sent no workflow. */
const chooseRequiredContent = (input: {
  readonly source?: string;
  readonly definition?: unknown;
}): Effect.Effect<WorkflowContent, Validation> =>
  Effect.flatMap(chooseContent(input), (content) =>
    content === undefined
      ? Effect.fail(createValidationError([{ path: [], message: NO_CONTENT }]))
      : Effect.succeed(content),
  );

/**
 * Parses the workflow a request sent. Returns its YAML source and the parsed
 * definition, or every schema error found.
 *
 * A request sends the workflow either as YAML text or as a definition object.
 * An object is first validated against the schema, then converted to YAML,
 * and that YAML is parsed like any other text. So both kinds of input report
 * errors at the same paths, and the stored definition always matches the
 * stored YAML.
 */
const parseContent = (
  content: WorkflowContent,
): Result.Result<ParsedSource, ReadonlyArray<Issue>> => {
  const text =
    content.source !== undefined
      ? Result.succeed(content.source)
      : Result.map(decodeWorkflowDefinition(content.definition), renderWorkflowSource);
  return Result.flatMap(text, (source) =>
    Result.map(parseWorkflowSource(source), (definition) => ({ source, definition })),
  );
};

/** Same as `parseContent`, but fails with a `Validation` error that lists every schema error. */
const parseContentOrFail = (content: WorkflowContent): Effect.Effect<ParsedSource, Validation> =>
  Effect.mapError(Effect.fromResult(parseContent(content)), (issues) =>
    createValidationError(issues),
  );

/** Builds one trigger row for each trigger that the definition declares. */
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

/** The errors that every method of the service can fail with. */
type CallError = Unauthenticated | Forbidden | Validation | SqlError;

/** Fails with a `Validation` error that lists every error in `problems`, if there are any. */
const failOnErrors = (problems: WorkflowIssues): Effect.Effect<void, Validation> =>
  problems.errors.length === 0 ? Effect.void : Effect.fail(createValidationError(problems.errors));

/** Returns the value that `found` produces, or fails with a `NotFound` error if it produces none. */
const failIfWorkflowNotFound = <A, E>(
  found: Effect.Effect<Option.Option<A>, E>,
): Effect.Effect<A, E | NotFound> =>
  Effect.flatMap(
    found,
    Option.match({
      onNone: () => Effect.fail(createNotFoundError(NO_SUCH_WORKFLOW)),
      onSome: Effect.succeed,
    }),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workflows = yield* workflowRepository;
  const audit = yield* AuditLog;
  const agents = yield* agentRepository;
  const connections = yield* connectionRepository;
  const host = yield* PluginHost;
  const eventKinds = yield* EventKinds;

  /**
   * Reads from the database and the plugin host what validating the definition
   * needs: the available actions, event kinds and Connection types, and which
   * of the Agents and Connections that the definition refers to exist.
   *
   * A save calls this inside its transaction, so the rows cannot change
   * between the validation and the write.
   */
  const readReferences = (
    definition: WorkflowDefinition,
  ): Effect.Effect<ResolvedReferences, SqlError> =>
    Effect.gen(function* () {
      return {
        actions: new Map(
          (yield* host.listActiveWorkflowActions()).map((action) => [action.id, action]),
        ),
        eventKinds: new Map(
          (yield* eventKinds.list()).map((eventKind) => [eventKind.kind, eventKind]),
        ),
        agentIds: yield* agents.readExistingIds(listReferencedAgentIds(definition)),
        connectionTypeById: yield* connections.readTypes(listReferencedConnectionIds(definition)),
        connectionTypes: new Set(yield* host.listActiveConnectionTypes()),
      };
    });

  /**
   * Reads what the definition refers to, then validates the definition against
   * it. Returns every error and warning found.
   */
  const readReferencesAndValidate = (
    definition: WorkflowDefinition,
  ): Effect.Effect<WorkflowIssues, SqlError> =>
    Effect.flatMap(readReferences(definition), (references) =>
      validateDefinition(definition, references),
    );

  return {
    /** Returns one page of workflows, the most recently changed first. */
    query: (input: QueryInput): Effect.Effect<WorkflowPage, CallError> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.query");
        const { limit, cursor, sort, enabled } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
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
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        return yield* failIfWorkflowNotFound(workflows.read(id));
      }),

    /** Stores a new workflow, disabled, from YAML source or from a definition object. */
    create: (input: WorkflowCreateInput): Effect.Effect<WorkflowSaveResult, CallError> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const parsedSource = yield* parseContentOrFail(yield* chooseRequiredContent(decoded));
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const problems = yield* readReferencesAndValidate(parsedSource.definition);
            yield* failOnErrors(problems);
            // Read the clock once, inside the transaction, so the workflow,
            // its triggers and the audit event all get the same timestamp.
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
              // Only the id and the name. The source contains the prompts
              // given to the workflow's agents, and more people can read the
              // audit log than can read workflows.
              payload: { workflowId: stored.id, name: parsedSource.definition.name },
              at: savedAt,
            });
            return { workflow: stored, warnings: problems.warnings };
          }),
        );
      }),

    /**
     * Replaces a workflow's source, enables or disables it, or both. A new
     * source replaces the old one completely, and the trigger rows are updated
     * to match it.
     */
    update: (input: UpdateInput): Effect.Effect<WorkflowSaveResult, CallError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.update");
        const decoded = yield* Effect.mapError(decodeUpdate(input), createDecodeValidationError);
        const content = yield* chooseContent(decoded);
        if (content === undefined && decoded.enabled === undefined) {
          return yield* Effect.fail(
            createValidationError([{ path: [], message: "name a field to change" }]),
          );
        }
        const parsedSource = content === undefined ? undefined : yield* parseContentOrFail(content);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const problems =
              parsedSource === undefined
                ? undefined
                : yield* readReferencesAndValidate(parsedSource.definition);
            if (problems !== undefined) yield* failOnErrors(problems);
            const savedAt = yield* nowIso;
            const { workflow: stored, changed } = yield* failIfWorkflowNotFound(
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
              // The event is written even when nothing changed. Clients that
              // watch the topic then read the workflow again and find it
              // unchanged. A save that changes nothing is rare, and always
              // writing the event is simpler than a separate silent path.
              record: { topic: "workflow", id: stored.id },
              // Which fields changed, never the new source. A save of the same
              // source is recorded with an empty `changed`.
              payload: { workflowId: stored.id, changed },
              at: savedAt,
            });
            // Enabling or disabling a workflow does not validate its source,
            // so it returns no warnings.
            return { workflow: stored, warnings: problems?.warnings ?? [] };
          }),
        );
      }),

    /** Deletes a workflow and its trigger rows. */
    delete: (input: Identified): Effect.Effect<Record<string, never>, CallError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.delete");
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const deletedAt = yield* nowIso;
            const name = yield* failIfWorkflowNotFound(workflows.delete(id));
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

    /**
     * Validates a workflow like a save does, but stores nothing. Returns every
     * error, schema errors included, instead of failing, because an editor
     * shows the result while the author types.
     */
    validate: (input: WorkflowValidateInput): Effect.Effect<WorkflowIssues, CallError> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.validate");
        const decoded = yield* Effect.mapError(decodeValidate(input), createDecodeValidationError);
        const parsed = parseContent(yield* chooseRequiredContent(decoded));
        return Result.isSuccess(parsed)
          ? yield* readReferencesAndValidate(parsed.success.definition)
          : { errors: parsed.failure, warnings: [] };
      }),

    /** Returns one page of triggers across all workflows, the newest first. */
    queryTriggers: (input: TriggerQueryInput): Effect.Effect<TriggerPage, CallError> =>
      Effect.gen(function* () {
        yield* requireGrant("trigger.query");
        const { limit, cursor, sort, ...filter } = yield* Effect.mapError(
          decodeTriggerQuery(input),
          createDecodeValidationError,
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

export class WorkflowService extends Context.Service<
  WorkflowService,
  Effect.Success<typeof make>
>()("hercule/controller/workflows/WorkflowService") {}

export const WorkflowServiceLayer: Layer.Layer<
  WorkflowService,
  never,
  SqlClient.SqlClient | AuditLog | PluginHost | EventKinds
> = Layer.effect(WorkflowService)(make);

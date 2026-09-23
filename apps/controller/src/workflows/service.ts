/**
 * Workflows as the API sees them: `workflow.query`, `read`, `create`,
 * `update`, `delete` and `validate`, and `trigger.query` over the triggers
 * their sources declare.
 *
 * The text is the truth (ADR 0029). The stored source is only ever the text a
 * caller sent, or the canonical text of the definition object a caller sent,
 * and the stored definition is only ever what that source parses to. Turning a
 * workflow on or off writes neither. A source is parsed and checked before any
 * row is written, so a refused save leaves the stored workflow as it was. A
 * save and a check run the same checks, so an editor that shows the answer of
 * a check shows what a save will say.
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
  type WorkflowSaved,
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
  checkDefinitionAgainst,
  listNamedAgentIds,
  listNamedConnectionIds,
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
 * Both listings answer the newest first when the caller names no direction:
 * the workflow changed last, and the trigger added last. A listing is read to
 * find what was worked on.
 */
const DEFAULT_DIRECTION: SortDirection = "desc";

const NO_SUCH_WORKFLOW = "no such workflow";

/** Why a request that sends the text and the object together is refused. */
const SOURCE_AND_DEFINITION_TOGETHER =
  "Send source or definition, not the two together. The stored text comes from one of them.";

/** Why a request that must send a workflow and sends none is refused. */
const NO_CONTENT = "Send the workflow as source or as definition.";

/** What a request sends a workflow as: its text, or a definition object. */
type WorkflowContent =
  | { readonly source: string; readonly definition?: undefined }
  | { readonly source?: undefined; readonly definition: unknown };

/**
 * The workflow a request sent, or `undefined` where it sent none. A request
 * that sends the text and the object together is refused, because the stored
 * text can come from one of them only.
 */
const chooseContent = (input: {
  readonly source?: string;
  readonly definition?: unknown;
}): Effect.Effect<WorkflowContent | undefined, Validation> => {
  if (input.source !== undefined && input.definition !== undefined) {
    return Effect.fail(validation([{ path: [], message: SOURCE_AND_DEFINITION_TOGETHER }]));
  }
  if (input.source !== undefined) return Effect.succeed({ source: input.source });
  if (input.definition !== undefined) return Effect.succeed({ definition: input.definition });
  return Effect.succeed(undefined);
};

/** The workflow a request sent, where the request must send one. */
const requireContent = (input: {
  readonly source?: string;
  readonly definition?: unknown;
}): Effect.Effect<WorkflowContent, Validation> =>
  Effect.flatMap(chooseContent(input), (content) =>
    content === undefined
      ? Effect.fail(validation([{ path: [], message: NO_CONTENT }]))
      : Effect.succeed(content),
  );

/**
 * The text a workflow is stored as, and the definition it says, or every
 * problem of shape that stops it from being one. A definition object is
 * checked, then written as its canonical text, and that text is parsed as a
 * sent text is. So a problem is named at the same path whichever way it
 * arrived, and the stored definition is always what the stored text says.
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

/** The text and definition of the workflow a save sent, or the refusal of every problem of shape. */
const requireParsedContent = (content: WorkflowContent): Effect.Effect<ParsedSource, Validation> =>
  Effect.mapError(Effect.fromResult(parseContent(content)), (issues) => validation(issues));

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

/** Refuses a save whose definition fails a check of meaning, with every error the check found. */
const requireNoErrors = (problems: WorkflowIssues): Effect.Effect<void, Validation> =>
  problems.errors.length === 0 ? Effect.void : Effect.fail(validation(problems.errors));

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
  const agents = yield* agentRepository;
  const connections = yield* connectionRepository;
  const host = yield* PluginHost;
  const eventKinds = yield* EventKinds;

  /**
   * What a definition names, as the controller holds it now: the actions,
   * event kinds and Connection types that can be named, and the Agents and
   * Connections that the definition names and that exist. A save reads it
   * inside its transaction.
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
        agentIds: yield* agents.readExistingIds(listNamedAgentIds(definition)),
        connectionTypeById: yield* connections.readTypes(listNamedConnectionIds(definition)),
        connectionTypes: new Set(yield* host.listActiveConnectionTypes()),
      };
    });

  /**
   * Every problem of a definition's meaning, and the one warning: what
   * `validate` answers. It reads what the definition names from the database,
   * and checks the definition against it.
   */
  const readReferencesAndCheck = (
    definition: WorkflowDefinition,
  ): Effect.Effect<WorkflowIssues, SqlError> =>
    Effect.flatMap(readReferences(definition), (references) =>
      checkDefinitionAgainst(definition, references),
    );

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
        const parsedSource = yield* requireParsedContent(yield* requireContent(decoded));
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const problems = yield* readReferencesAndCheck(parsedSource.definition);
            yield* requireNoErrors(problems);
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
            return { workflow: stored, warnings: problems.warnings };
          }),
        );
      }),

    /**
     * Changes a workflow's text, or turns it on or off. A new text takes the
     * place of the old one whole, and the trigger rows follow it.
     */
    update: (input: UpdateInput): Effect.Effect<WorkflowSaved, CallError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.update");
        const decoded = yield* Effect.mapError(decodeUpdate(input), validationOf);
        const content = yield* chooseContent(decoded);
        if (content === undefined && decoded.enabled === undefined) {
          return yield* Effect.fail(validation([{ path: [], message: "name a field to change" }]));
        }
        const parsedSource =
          content === undefined ? undefined : yield* requireParsedContent(content);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const problems =
              parsedSource === undefined
                ? undefined
                : yield* readReferencesAndCheck(parsedSource.definition);
            if (problems !== undefined) yield* requireNoErrors(problems);
            const savedAt = yield* nowIso;
            const { workflow: stored, changed } = yield* requireFound(
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
              // The entry names the workflow also when nothing changed, so
              // the live topic says that the workflow was updated, and a
              // client reads it again. That read finds the same workflow. A
              // save that changes nothing is rare, and one rule for every
              // update is simpler than a second path that stays silent.
              record: { topic: "workflow", id: stored.id },
              // Which of the two changed, never the new text. A save of the
              // same text is recorded with nothing in `changed`.
              payload: { workflowId: stored.id, changed },
              at: savedAt,
            });
            // Turning a workflow on or off does not read its text, so it
            // answers no warning about it.
            return { workflow: stored, warnings: problems?.warnings ?? [] };
          }),
        );
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

    /**
     * Checks a workflow as a save does, and stores nothing. Every problem is
     * in the answer, a problem of shape included, because the answer is what
     * an editor shows while the author types.
     */
    validate: (input: WorkflowValidateInput): Effect.Effect<WorkflowIssues, CallError> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.validate");
        const decoded = yield* Effect.mapError(decodeValidate(input), validationOf);
        const parsed = parseContent(yield* requireContent(decoded));
        return Result.isSuccess(parsed)
          ? yield* readReferencesAndCheck(parsed.success.definition)
          : { errors: parsed.failure, warnings: [] };
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
  SqlClient.SqlClient | AuditLog | PluginHost | EventKinds
> = Layer.effect(WorkflowService)(make);

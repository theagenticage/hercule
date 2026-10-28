/**
 * The workflow operations: `workflow.query`, `read`, `create`, `update`,
 * `delete` and `validate`; `trigger.query`, which lists the triggers that
 * the stored workflows declare; `trigger.pause` and `trigger.resume`,
 * which set a start trigger's status.
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
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { findJsonSchemaViolation } from "@hercule/protocol/json-schema";
import {
  type NotificationSubject,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  decodeWorkflowDefinition,
  DEFAULT_PAGE_LIMIT,
  Id,
  isId,
  parseWorkflowSource,
  quoteAuthorText,
  renderWorkflowSource,
  TRIGGER_SORT_FIELDS,
  TriggerFilter,
  WORKFLOW_SORT_FIELDS,
  WORKFLOW_UPDATE_FIELDS,
  WorkflowCreateInput,
  WorkflowFilter,
  WorkflowValidateInput,
  type Forbidden,
  type InvalidState,
  type Issue,
  type NotFound,
  type SortDirection,
  type Trigger,
  type TriggerKey,
  type TriggerResumeCall,
  type Unauthenticated,
  type Validation,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowIssues,
  type WorkflowSaveResult,
  type WorkflowSummary,
} from "@hercule/contract";
import { checkActorHoldsGrant, currentStamp, requireGrant, type Actor } from "../actor";
import { connectionRepository } from "../connections";
import {
  nowIso,
  buildPageInputFields,
  refuseCursor,
  resolveSortDirection,
  withTransaction,
} from "../db";
import { AuditLog, CRON_TICK_EVENT_KIND, type EventKinds } from "../events";
import { Notifier } from "../notifications";
import type { PluginHost } from "../plugins";
import { Settings } from "../settings";
import { workflowReferences } from "./references";
import { workflowRepository, type DeclaredTrigger, type ParsedSource } from "./repository";
import { WorkflowRuns } from "./runs";
import { WorkflowSignals } from "./signals";
import { readDefaultSpawnBound } from "./spawn-bounds";
import {
  RESUME_ACTION_ID,
  RESUME_AND_DISCARD_ACTION_ID,
  triggerEffectRepository,
} from "./trigger-effects";
import { listConnectionParams, validateDefinition, type ConnectionParam } from "./validation";

const QueryInput = Schema.Struct({
  ...WorkflowFilter.fields,
  ...buildPageInputFields(WORKFLOW_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const UpdateInput = Schema.Struct({ id: Id, ...WORKFLOW_UPDATE_FIELDS });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const TriggerQueryInput = Schema.Struct({
  ...TriggerFilter.fields,
  ...buildPageInputFields(TRIGGER_SORT_FIELDS),
});

export type TriggerQueryInput = Schema.Schema.Type<typeof TriggerQueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(WorkflowCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeValidate = Schema.decodeUnknownEffect(WorkflowValidateInput);
const decodeTriggerQuery = Schema.decodeUnknownEffect(TriggerQueryInput);

export interface WorkflowPage {
  readonly items: ReadonlyArray<WorkflowSummary>;
  readonly nextCursor?: string;
}

export interface TriggerPage {
  readonly items: ReadonlyArray<Trigger>;
  readonly nextCursor?: string;
}

/**
 * Both listings return the newest first when the caller gives no sort: the
 * most recently changed workflow, and the most recently added trigger. People
 * usually open a listing to find what they worked on last.
 */
const DEFAULT_DIRECTION: SortDirection = "desc";

const NO_SUCH_WORKFLOW = "no such workflow";

const SIGNAL_TRIGGER_HAS_NO_STATUS =
  "a signal trigger has no status and cannot be paused or resumed; it lives only as long as the run it resumes";

const NO_SUCH_TRIGGER =
  "no such trigger; check the workflow id, and the trigger id as the workflow's source spells it";

const CRON_TICK_IS_NO_TRIGGER_EVENT_KIND =
  `"${CRON_TICK_EVENT_KIND}" is not an event kind a trigger accepts: a cron trigger fires on a schedule. ` +
  "To list the cron triggers, filter with on set to schedule.";

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

/**
 * Checks a value against an input's JSON Schema. Returns a message that says
 * what is wrong, or `undefined` when the value is valid. A schema the
 * validator cannot use is reported as the problem, because the author has to
 * fix the workflow, not the value.
 */
const checkAgainstSchema = (
  schema: Record<string, unknown>,
  value: unknown,
): string | undefined => {
  try {
    const violation = findJsonSchemaViolation(schema, value);
    if (violation === undefined) return undefined;
    // The issue already sits at the input's path, so a violation of the
    // input's value itself needs no location; one inside it names the key.
    const where = violation.location === "#" ? "" : `${violation.location}: `;
    return `This value does not match the input's schema: ${where}${violation.message.replace(/\.$/, "")}.`;
  } catch {
    return "The input's schema is not a JSON Schema the controller can check values with. Correct the schema in the workflow.";
  }
};

/** Builds the trigger that the repository stores for each trigger the definition declares. */
const buildDeclaredTriggers = (definition: WorkflowDefinition): ReadonlyArray<DeclaredTrigger> =>
  (definition.triggers ?? []).map((trigger) => ({
    triggerId: trigger.id,
    kind: trigger.kind,
    on: trigger.on,
    inputs: trigger.kind === "start" ? trigger.inputs : undefined,
    spawnBound: trigger.kind === "start" ? trigger.spawnBound : undefined,
  }));

/** Builds the notification subjects that name these triggers of a workflow. */
const buildTriggerSubjects = (
  workflowId: string,
  triggerIds: ReadonlyArray<string>,
): ReadonlyArray<NotificationSubject> =>
  triggerIds.map((triggerId) => ({ kind: "trigger", workflowId, triggerId }));

/** The errors that every method of the service can fail with. */
type CallError = Unauthenticated | Forbidden | Validation | SqlError;

/**
 * The errors of a method that takes an id and changes what it names: every
 * method's errors but `Validation`, because the transport has decoded the id,
 * plus `NotFound` and `InvalidState`.
 */
type ChangeByIdError = Exclude<CallError, Validation> | NotFound | InvalidState;

/**
 * The message of the `Forbidden` error for a save of a workflow with a
 * connection param: a step that acts through a Connection, or that may give
 * one to a run it starts.
 */
const SAVE_CONNECTION_USE_REFUSAL =
  "This workflow has a step that acts through a Connection, or that may give a Connection to a run it starts, and choosing that Connection needs the connection.use grant, which this session lacks. Ask the user to save the workflow, or to grant connection.use.";

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
  const notifier = yield* Notifier;
  const connections = yield* connectionRepository;
  const runs = yield* WorkflowRuns;
  const signals = yield* WorkflowSignals;
  const effects = yield* triggerEffectRepository;
  const settings = yield* Settings;

  const { readConnectionParamReferences, readReferences, readReferencesAndValidate } =
    yield* workflowReferences;

  /**
   * Checks that `actor` may save `definition`, and returns its warnings.
   * Fails with:
   *
   * - `Validation` listing every error, when the definition does not
   *   validate;
   * - `Forbidden` when the definition has a connection param (see
   *   `listConnectionParams`) and the actor lacks the `connection.use`
   *   grant. The param chooses the Connection a step acts through, as an id
   *   or as the input a run fills in, and every run of the workflow acts
   *   through it, whoever starts the run.
   *
   * A save calls this inside its transaction, so the rows cannot change
   * between the checks and the write.
   */
  const checkSave = (
    definition: WorkflowDefinition,
    actor: Actor,
  ): Effect.Effect<WorkflowIssues, Validation | Forbidden | SqlError> =>
    Effect.gen(function* () {
      const references = yield* readReferences(definition);
      const problems = yield* validateDefinition(definition, references);
      yield* failOnErrors(problems);
      if (listConnectionParams(definition, references).length > 0) {
        const refused = checkActorHoldsGrant("connection.use", actor, SAVE_CONNECTION_USE_REFUSAL);
        if (refused !== undefined) return yield* Effect.fail(refused);
      }
      return problems;
    });

  /**
   * Checks that `trigger.pause` or `trigger.resume` may change a trigger.
   * Fails with `NotFound` if the workflow declares no trigger with the id,
   * and with `InvalidState` for a signal trigger, which has no status.
   */
  const checkStartTrigger = (
    key: TriggerKey,
  ): Effect.Effect<void, NotFound | InvalidState | SqlError> =>
    Effect.gen(function* () {
      const kind = yield* workflows.readTriggerKind(key);
      if (Option.isNone(kind)) return yield* Effect.fail(createNotFoundError(NO_SUCH_TRIGGER));
      if (kind.value === "signal") {
        return yield* Effect.fail(createInvalidStateError(SIGNAL_TRIGGER_HAS_NO_STATUS));
      }
    });

  /**
   * Reads a start trigger after `trigger.pause` or `trigger.resume` changed
   * it, with its spawn bound and its counts in the window that ends at
   * `now`. The caller checked the trigger in the same transaction, so it
   * exists.
   */
  const readChangedTrigger = (key: TriggerKey, now: string): Effect.Effect<Trigger, SqlError> =>
    Effect.gen(function* () {
      const found = yield* workflows.readTrigger(key, yield* readDefaultSpawnBound(settings), now);
      return Option.getOrThrow(found);
    });

  return {
    /**
     * Validates a parsed definition with the same rules as a save, against
     * what exists on the controller now. Returns every error and warning, and
     * returns only the schema errors when the definition no longer decodes.
     * Checks no grant: the run engine calls it to check a definition again
     * before it starts a run, because what the definition refers to may have
     * changed since it was saved.
     *
     * It decodes the definition again because a stored definition was decoded
     * by the controller that saved it, and a newer controller may decode it
     * more strictly: a spawn bound over the cap, say.
     */
    validateDefinition: (
      definition: WorkflowDefinition,
    ): Effect.Effect<WorkflowIssues, SqlError> => {
      const decoded = decodeWorkflowDefinition(definition);
      return Result.isSuccess(decoded)
        ? readReferencesAndValidate(decoded.success)
        : Effect.succeed({ errors: decoded.failure, warnings: [] });
    },

    /**
     * Returns the connection params of `definition`, as `listConnectionParams`
     * finds them against the actions and stored workflows that exist now.
     * Checks no grant: the run engine calls it to decide whether a start
     * chooses the Connection a step acts through.
     */
    listConnectionParams: (
      definition: WorkflowDefinition,
    ): Effect.Effect<ReadonlyArray<ConnectionParam>, SqlError> =>
      Effect.map(readConnectionParamReferences(definition), (references) =>
        listConnectionParams(definition, references),
      ),

    /**
     * Parses a workflow a request sent as `source` or `definition`, and
     * returns its definition. Fails with a `Validation` error that lists
     * every schema error, or if the request sent neither or both. Checks no
     * grant and nothing the definition refers to: the run engine calls it for
     * a `run.start` that sends a workflow, then validates the definition
     * itself.
     */
    parseDefinition: (input: {
      readonly source?: string;
      readonly definition?: unknown;
    }): Effect.Effect<WorkflowDefinition, Validation> =>
      Effect.map(
        Effect.flatMap(chooseRequiredContent(input), parseContentOrFail),
        (parsed) => parsed.definition,
      ),

    /**
     * Resolves the values a run of `definition` starts with: the caller's
     * value for each declared input, or its default. An optional input with
     * no value and no default is left out. Returns the resolved inputs, or an
     * issue at `inputs.<name>` for each of these:
     *
     * - an input the definition does not declare;
     * - a required input with no value;
     * - a value that does not match the input's JSON Schema;
     * - a Connection id for a Connection that does not exist, is of another
     *   type, or is disabled.
     *
     * Checks no grant: the run engine calls it while it starts a run.
     */
    resolveRunInputs: (
      definition: WorkflowDefinition,
      given: Readonly<Record<string, unknown>>,
    ): Effect.Effect<Result.Result<Record<string, unknown>, ReadonlyArray<Issue>>, SqlError> =>
      Effect.gen(function* () {
        const declarations = definition.inputs ?? [];
        const issues: Array<Issue> = [];
        const declared = new Set(declarations.map((input) => input.name));
        for (const name of Object.keys(given)) {
          if (!declared.has(name)) {
            issues.push({
              path: ["inputs", name],
              message: `This workflow declares no input named ${quoteAuthorText(name)}. Remove it, or use one of the declared inputs.`,
            });
          }
        }
        const resolved: Record<string, unknown> = {};
        for (const input of declarations) {
          const path = ["inputs", input.name];
          const value = Object.hasOwn(given, input.name) ? given[input.name] : input.default;
          if (value === undefined) {
            if (input.required) {
              issues.push({
                path,
                message: `Add a value for ${input.name}. This input is required.`,
              });
            }
            continue;
          }
          if (input.schema !== undefined) {
            const problem = checkAgainstSchema(input.schema, value);
            if (problem !== undefined) issues.push({ path, message: problem });
          } else if (input.connection !== undefined) {
            const wanted = input.connection.type;
            const found =
              typeof value === "string" && isId(value)
                ? yield* connections.one(value)
                : Option.none();
            if (Option.isNone(found)) {
              issues.push({
                path,
                message: `No Connection has this id. Give the id of a Connection of type ${wanted}.`,
              });
            } else if (found.value.type !== wanted) {
              issues.push({
                path,
                message: `This Connection is of type ${found.value.type}, but the input needs a Connection of type ${wanted}.`,
              });
            } else if (found.value.status === "disabled") {
              issues.push({
                path,
                message:
                  "This Connection is disabled. Enable it, or give another Connection of the same type.",
              });
            }
          } else if (input.signal !== undefined) {
            const wanted = input.signal.kinds;
            const kind =
              typeof value === "string" && isId(value)
                ? yield* signals.readKind(value)
                : Option.none();
            if (Option.isNone(kind)) {
              issues.push({
                path,
                message: `No signal has this id. Give the id of a signal of one of these kinds: ${wanted.join(", ")}.`,
              });
            } else if (!wanted.includes(kind.value)) {
              issues.push({
                path,
                message: `This signal is of kind ${kind.value}, but the input takes only these kinds: ${wanted.join(", ")}.`,
              });
            }
          }
          resolved[input.name] = value;
        }
        return issues.length === 0 ? Result.succeed(resolved) : Result.fail(issues);
      }),

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
            direction: resolveSortDirection(sort, DEFAULT_DIRECTION),
            enabled,
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (id: Id): Effect.Effect<Workflow, Exclude<CallError | NotFound, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.read");
        return yield* failIfWorkflowNotFound(workflows.read(id));
      }),

    /**
     * Stores a new workflow, disabled, from YAML source or from a definition
     * object. Fails with `Forbidden` when a step acts through a Connection and
     * the caller lacks the `connection.use` grant.
     */
    create: (input: WorkflowCreateInput): Effect.Effect<WorkflowSaveResult, CallError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("workflow.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const parsedSource = yield* parseContentOrFail(yield* chooseRequiredContent(decoded));
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const problems = yield* checkSave(parsedSource.definition, actor);
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
     * to match it. Fails with `Forbidden` when the new source has a step that
     * acts through a Connection and the caller lacks the `connection.use`
     * grant.
     *
     * A new source validated before it was written, so writing it clears the
     * workflow's invalid mark, even when the source is the same as before.
     * Enabling or disabling alone leaves the mark as it is: the source did
     * not change, and `WorkflowValidity` keeps the mark up to date when what
     * the source uses changes.
     */
    update: (input: UpdateInput): Effect.Effect<WorkflowSaveResult, CallError | NotFound> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("workflow.update");
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
                : yield* checkSave(parsedSource.definition, actor);
            const savedAt = yield* nowIso;
            let discardedCount = 0;
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
              const reconciliation = yield* workflows.reconcileTriggers(
                stored.id,
                buildDeclaredTriggers(parsedSource.definition),
                savedAt,
              );
              yield* notifier.withdrawDecisionsAbout(
                buildTriggerSubjects(stored.id, reconciliation.removedTriggerIds),
                "trigger removed",
              );
              discardedCount = reconciliation.discardedCount;
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
              // source is recorded with an empty `changed`. A save that
              // discarded held events records how many.
              payload: {
                workflowId: stored.id,
                changed,
                ...(discardedCount > 0 ? { discardedCount } : {}),
              },
              at: savedAt,
            });
            // Enabling or disabling a workflow does not validate its source,
            // so it returns no warnings.
            return { workflow: stored, warnings: problems?.warnings ?? [] };
          }),
        );
      }),

    /**
     * Deletes a workflow and its trigger rows. Fails with `InvalidState` while
     * a run of the workflow is pending or running: like every entity that
     * something live references, a workflow is not deleted from under a run
     * that is still acting. A finished run keeps the workflow's id and its own
     * copy of the definition.
     */
    delete: (id: Id): Effect.Effect<Record<string, never>, ChangeByIdError> =>
      Effect.gen(function* () {
        yield* requireGrant("workflow.delete");
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            if (yield* runs.hasUnfinishedRun(id)) {
              return yield* Effect.fail(
                createInvalidStateError(
                  "a run of this workflow is still pending or running; wait for it to finish, or cancel it, then delete the workflow",
                ),
              );
            }
            const deletedAt = yield* nowIso;
            const { name, triggerIds } = yield* failIfWorkflowNotFound(workflows.delete(id));
            yield* notifier.withdrawDecisionsAbout(
              [{ kind: "workflow", id }, ...buildTriggerSubjects(id, triggerIds)],
              "workflow deleted",
            );
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

    /**
     * Returns one page of triggers across all workflows, the newest first.
     * Fails with a `Validation` error when the filter names the event kind
     * `cron.tick`. A cron trigger's row stores that kind, but a cron trigger
     * fires on a schedule and accepts no events, so a filter on it would
     * always list nothing. The error points the caller to `on: schedule`.
     */
    queryTriggers: (input: TriggerQueryInput): Effect.Effect<TriggerPage, CallError> =>
      Effect.gen(function* () {
        yield* requireGrant("trigger.query");
        const { limit, cursor, sort, ...filter } = yield* Effect.mapError(
          decodeTriggerQuery(input),
          createDecodeValidationError,
        );
        if (filter.eventKind === CRON_TICK_EVENT_KIND) {
          return yield* Effect.fail(
            createValidationError([
              { path: ["eventKind"], message: CRON_TICK_IS_NO_TRIGGER_EVENT_KIND },
            ]),
          );
        }
        const listing = yield* refuseCursor(
          workflows.listTriggers(
            {
              limit: limit ?? DEFAULT_PAGE_LIMIT,
              cursor,
              direction: resolveSortDirection(sort, DEFAULT_DIRECTION),
              workflowId: filter.workflowId,
              kind: filter.kind,
              on: filter.on,
              eventKind: filter.eventKind,
              status: filter.status,
            },
            yield* readDefaultSpawnBound(settings),
            yield* nowIso,
          ),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * `trigger.pause`: stops a start trigger from starting runs, and returns
     * it. Events that arrive while it is paused are not kept for later. The
     * events it already matched are kept as held events, to start runs once
     * it is resumed: its held events stay held, and its pending matches
     * become held too.
     *
     * Pausing a trigger the breaker paused makes it paused manually: it holds
     * no more events, and the breaker decision stays open. Pausing a trigger
     * paused manually changes nothing and writes no audit entry. Fails with
     * `NotFound` if the workflow declares no trigger with the id, and with
     * `InvalidState` for a signal trigger.
     */
    pauseTrigger: (key: TriggerKey): Effect.Effect<Trigger, ChangeByIdError> =>
      Effect.gen(function* () {
        yield* requireGrant("trigger.pause");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* checkStartTrigger(key);
            const at = yield* nowIso;
            const paused = yield* workflows.setTriggerStatus(
              key,
              { status: "paused", pausedBy: "manual" },
              at,
            );
            if (paused) {
              yield* effects.holdPending(key);
              yield* audit.append({
                kind: "trigger.paused",
                actor: yield* currentStamp,
                record: { topic: "workflow", id: key.workflowId },
                payload: { ...key, pausedBy: "manual" },
                at,
              });
            }
            return yield* readChangedTrigger(key, at);
          }),
        );
      }),

    /**
     * `trigger.resume`: lets a paused start trigger start runs again, and
     * returns it. Its held events start runs in the order they arrived, as
     * fast as its spawn bound allows, while its workflow is enabled and
     * valid. With `discardHeld`, they are discarded first, and start none.
     * The resume records how many events the trigger holds, so a match that
     * finds them grown by more than `maxRuns` trips the breaker again.
     *
     * In the same transaction, it resolves the open breaker decision about
     * the trigger, as decided with the answer that matches the call. So the
     * decision is resolved whichever surface resumed the trigger.
     *
     * Resuming an active trigger changes nothing and writes no audit entry,
     * unless `discardHeld` has held events to discard. Fails with `NotFound`
     * if the workflow declares no trigger with the id, and with
     * `InvalidState` for a signal trigger.
     */
    resumeTrigger: (call: TriggerResumeCall): Effect.Effect<Trigger, ChangeByIdError> =>
      Effect.gen(function* () {
        yield* requireGrant("trigger.resume");
        const key: TriggerKey = { workflowId: call.workflowId, triggerId: call.triggerId };
        const discardHeld = call.discardHeld === true;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* checkStartTrigger(key);
            const at = yield* nowIso;
            const discardedCount = discardHeld ? yield* effects.discardHeld(key) : 0;
            const resumed = yield* workflows.setTriggerStatus(key, { status: "active" }, at);
            yield* notifier.answerDecisionsAbout(
              { kind: "trigger", ...key },
              discardHeld ? RESUME_AND_DISCARD_ACTION_ID : RESUME_ACTION_ID,
              "core.breaker-tripped",
            );
            if (resumed || discardedCount > 0) {
              yield* effects.recordHeldAtResume(key);
              yield* audit.append({
                kind: "trigger.resumed",
                actor: yield* currentStamp,
                record: { topic: "workflow", id: key.workflowId },
                payload: { ...key, ...(discardHeld ? { discardedCount } : {}) },
                at,
              });
            }
            return yield* readChangedTrigger(key, at);
          }),
        );
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
  | SqlClient.SqlClient
  | AuditLog
  | Notifier
  | PluginHost
  | EventKinds
  | WorkflowRuns
  | WorkflowSignals
  | Settings
> = Layer.effect(WorkflowService)(make);

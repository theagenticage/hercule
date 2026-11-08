/**
 * The handoff of an External Entity to a workflow: the execution of
 * `externalEntity.handOff` and `externalEntity.undoHandOff`. It starts a run
 * of the workflow on the thing's Task and ends the open signals the workflow
 * answers, and it takes a handoff back as far as is safe.
 *
 * It is a service of its own, in the shape of `SignalHandoffs`, because it
 * calls the run service and the signal service, which the entity service
 * does not.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import {
  createInvalidStateError,
  createNotFoundError,
  InvalidState,
  NotFound,
  Validation,
  type EntityHandOffInput,
  type EntityHandOffResult,
  type HandOffUndo,
  type WorkflowDefinition,
} from "@hercule/contract";
import { requireUserActor } from "../actor";
import { mintUuid, nowIso, uuidToString, withTransaction } from "../db";
import { PluginHost } from "../plugins";
import { resourceRepository } from "../resources";
import { isUnfinished, RunService, runRepository } from "../runs";
import { SignalClaims, SignalService, signalRepository } from "../signals";
import { TaskService, taskRepository } from "../tasks";
import { workflowRepository } from "../workflows";
import { announceEntityChanges } from "./announce";
import { handoffRecordRepository, type HandoffRecord } from "./handoff-records";
import { listEntityKindSources } from "./workflow-offers";
import { findProjectOfRemote } from "./project-of-remote";
import { externalEntityRepository, type TaskableEntity } from "./repository";

/** The refusal of a handoff for a caller who is not the user. */
const ONLY_THE_USER_HANDS_THINGS_OFF =
  "only the user may hand a thing off: it starts a workflow as the user and ends signals, so a session or a workflow step may not; ask the user instead";

/** The refusal of an Undo for a caller who is not the user. */
const ONLY_THE_USER_TAKES_HANDOFF_BACK =
  "only the user may take a handoff back: it is the user's own act, so a session or a workflow step may not; ask the user instead";

/** The refusal of a handoff while a plugin answer or a withdrawal works on one of the signals it would end. */
const REPLY_STILL_RUNNING = "A reply to this is still running. Try again in a moment.";

/** The refusal of a handoff of a record that is a place or is not read in full yet. */
const NOT_A_THING_TO_HAND_OFF =
  "This is not a piece of work that can be handed off: it is a place that groups work, or a record that is not fully read yet. Hand off one of the things in it.";

/** The refusal of a handoff when the workflow's `answers` changed after the handoff chose its signals. */
const WORKFLOW_CHANGED = "This workflow changed. Try again.";

/** The answer of an Undo for a run that had already ended: nothing changed. */
const TOO_LATE: HandOffUndo = {
  outcome: "too-late",
  stopRequested: false,
  taskRemoved: false,
  stageRestored: false,
  failureRestored: false,
};

/** Returns the `entity` input of a workflow, which a saved workflow holds at most once. */
const findEntityInput = (definition: WorkflowDefinition) =>
  definition.inputs?.find((input) => input.entity !== undefined);

/** Returns the signal kinds the workflow's entity input answers. */
const listAnswers = (definition: WorkflowDefinition): ReadonlyArray<string> =>
  findEntityInput(definition)?.entity?.answers ?? [];

/** Checks that two lists hold the same kinds, in any order. */
const holdSameKinds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((kind) => right.has(kind));
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const entities = yield* externalEntityRepository;
  const records = yield* handoffRecordRepository;
  const workflows = yield* workflowRepository;
  const signalRows = yield* signalRepository;
  const taskRows = yield* taskRepository;
  const runRows = yield* runRepository;
  const resources = yield* resourceRepository;
  const tasks = yield* TaskService;
  const runs = yield* RunService;
  const signals = yield* SignalService;
  const claims = yield* SignalClaims;
  const host = yield* PluginHost;

  /** Reads the entity with this id, or fails with `NotFound`. */
  const readEntityOrFail = (id: string) =>
    Effect.flatMap(entities.readTaskableEntity({ id }), (found) =>
      Option.isSome(found)
        ? Effect.succeed(found.value)
        : Effect.fail(createNotFoundError("no such external entity")),
    );

  /** Reads the stored definition of the workflow, or fails with `NotFound`. */
  const readDefinitionOrFail = (workflowId: string) =>
    Effect.flatMap(workflows.readDefinition(workflowId), (found) =>
      Option.isSome(found)
        ? Effect.succeed(found.value)
        : Effect.fail(createNotFoundError("no such workflow")),
    );

  /**
   * Checks that the workflow is available on the entity and that the account
   * can act on it, and returns the offer and the account that acts. It reads
   * the one workflow and the one account directly, by the same rules the
   * Inbox shows its offers by, so what a menu offered and what a handoff
   * accepts cannot disagree, and no cut list decides a handoff. Fails with
   * `InvalidState`, in words for the user, when it is not available or the
   * account cannot act.
   */
  const checkOffer = (
    entity: TaskableEntity,
    definition: WorkflowDefinition,
    input: EntityHandOffInput,
  ) =>
    Effect.gen(function* () {
      const kindSources = listEntityKindSources(yield* host.listActiveEventSources());
      const target = { ref: entity.ref, kind: entity.kind, targetRemote: entity.targetRemote };
      const offer = Option.getOrUndefined(
        yield* entities.readWorkflowOffer(target, input.workflowId, kindSources),
      );
      if (offer === undefined) {
        return yield* Effect.fail(
          createInvalidStateError(
            `${definition.name} cannot take this. Reload the Inbox and choose again.`,
          ),
        );
      }
      if (offer.unavailable !== undefined) {
        return yield* Effect.fail(createInvalidStateError(offer.unavailable.message));
      }
      const acting = Option.getOrUndefined(
        yield* entities.findActingConnection(target, input.connectionId, kindSources),
      );
      if (acting === undefined) {
        return yield* Effect.fail(
          createInvalidStateError("That account cannot act on this. Choose another account."),
        );
      }
      const connectionId = acting.id;
      return { offer, connectionId };
    });

  /**
   * Starts the run, writes the Task and ends the answered signals, in the
   * caller's transaction. See `handOff` for the order and the refusals.
   */
  const handOffInTransaction = (
    entityId: string,
    input: EntityHandOffInput,
    boundary: {
      readonly answers: ReadonlyArray<string>;
      readonly signalIds: ReadonlyArray<string>;
    },
  ) =>
    Effect.gen(function* () {
      const entity = yield* readEntityOrFail(entityId);
      if (!entity.isWorkRecord) {
        return yield* Effect.fail(createInvalidStateError(NOT_A_THING_TO_HAND_OFF));
      }
      const definition = yield* readDefinitionOrFail(input.workflowId);
      if (!holdSameKinds(listAnswers(definition), boundary.answers)) {
        return yield* Effect.fail(createInvalidStateError(WORKFLOW_CHANGED));
      }
      const { offer, connectionId } = yield* checkOffer(entity, definition, input);

      const existing = Option.getOrUndefined(yield* taskRows.findActiveTaskForRef(entity.ref));
      if (
        existing !== undefined &&
        Option.isSome(
          yield* runs.findLiveRunOnTask({ taskId: existing.id, workflowId: input.workflowId }),
        )
      ) {
        return yield* Effect.fail(
          createInvalidStateError(`${definition.name} is already working on this.`),
        );
      }
      const taskId = existing?.id ?? uuidToString(mintUuid());
      const projectId =
        existing === undefined
          ? yield* findProjectOfRemote(resources, entity.targetRemote)
          : undefined;

      const started = yield* runs.startOnTask(
        {
          workflowId: input.workflowId,
          inputs: {
            [findEntityInput(definition)!.name]: entity.ref,
            ...(offer.connectionInputName === undefined
              ? {}
              : { [offer.connectionInputName]: connectionId }),
          },
        },
        taskId,
      );

      const recorded = yield* tasks.recordEntityHandoff({
        taskId,
        entry: { ref: entity.ref, runId: started.runId },
        ...(existing === undefined
          ? {
              newTask: {
                title: entity.title,
                ...(projectId === undefined ? {} : { projectId }),
              },
            }
          : {}),
      });
      yield* signals.resolveAnswered({
        signalIds: boundary.signalIds,
        workflowId: input.workflowId,
        workflowName: definition.name,
        runId: started.runId,
      });
      // The revisions are read after every write of the handoff, so the
      // record holds the Task as the handoff left it, whatever order the
      // writes above are made in. The run's own start counts as a join.
      const revisions = Option.getOrThrow(yield* taskRows.readRevisions(recorded.task.id));
      yield* records.insert({
        runId: started.runId,
        ref: entity.ref,
        taskId: recorded.task.id,
        taskCreated: recorded.created,
        stageBefore: recorded.stageBefore,
        stageRevision: revisions.stageRevision,
        joinRevision: revisions.joinRevision,
      });
      yield* announceEntityChanges({ entityIds: [entity.id], affectedTaskIds: [recorded.task.id] });
      return { ...started, taskId: recorded.task.id } satisfies EntityHandOffResult;
    });

  /**
   * Decides what an Undo does to the Task and the run, and does it, in the
   * caller's transaction. The Task is taken back before the run is cancelled,
   * and only when nothing of the run was dispatched.
   */
  const undoInTransaction = (record: HandoffRecord) =>
    Effect.gen(function* () {
      // Runs are never deleted, and the record names this one.
      const run = Option.getOrThrow(yield* runRows.read(record.runId));
      if (!isUnfinished(run.status)) return TOO_LATE;

      const dispatched = yield* runRows.hasDispatchedWork(record.runId);
      const reversal = dispatched
        ? undefined
        : yield* tasks.reverseEntityHandoff({
            taskId: record.taskId,
            runId: record.runId,
            ref: record.ref,
            taskCreated: record.taskCreated,
            stageBefore: record.stageBefore,
            stageRevision: record.stageRevision,
            joinRevision: record.joinRevision,
          });
      // The run was found unfinished in this transaction, so the cancel
      // cannot refuse it.
      yield* runs
        .cancel(record.runId, {})
        .pipe(
          Effect.catchIf(
            (error): error is Validation | InvalidState | NotFound =>
              error instanceof Validation ||
              error instanceof InvalidState ||
              error instanceof NotFound,
            Effect.die,
          ),
        );

      if (reversal?.reversed === true) {
        return {
          outcome: "undone",
          stopRequested: true,
          taskRemoved: reversal.taskRemoved,
          stageRestored: reversal.stageRestored,
          failureRestored: reversal.failureRestored,
        } satisfies HandOffUndo;
      }
      return {
        outcome: "stopped",
        stopRequested: true,
        taskRemoved: false,
        stageRestored: false,
        failureRestored: false,
        reason: reversal === undefined ? "Its first step had started." : reversal.reason,
      } satisfies HandOffUndo;
    });

  return {
    /**
     * Hands an entity to a workflow, and returns the run it started and the
     * Task that run works on (new, or the entity's active Task). The order
     * keeps the rule that acting never ends a signal it did not answer:
     *
     * 1. checks the caller is the user and the entity exists;
     * 2. reads the boundary: the workflow's `answers`, and the ids of the open
     *    signals on this exact ref whose kind is in them, snoozed ones
     *    included. These are the only signals the handoff may end. A signal
     *    raised after this read stays open;
     * 3. claims those signals around the transaction (`SignalClaims`), so a
     *    plugin answer or a withdrawal that is still running refuses the
     *    whole handoff before anything is written;
     * 4. in one transaction: reads the workflow again and refuses if its
     *    `answers` changed since step 2; checks the offer and the account
     *    again; refuses a second run of the same workflow on the Task; starts
     *    the run with the entity's ref and the acting account as inputs;
     *    writes the Task (`building`, with the entity's title, or the active
     *    Task continued); ends the claimed signals that are still open; and
     *    writes the record the Undo reads, with the Task's revisions as they
     *    are after all of those writes.
     *
     * A run that fails to start rolls everything back.
     *
     * Fails with `Forbidden` for any caller but the user, `NotFound` for an
     * unknown entity or workflow, `InvalidState` when the entity is a place or
     * a partial record, the workflow is not available on the entity, the
     * account cannot act, the workflow changed, the same workflow already
     * works on the Task, or a reply to one of the signals is still running,
     * and with whatever starting the run fails with.
     */
    handOff: (entityId: string, input: EntityHandOffInput) =>
      Effect.gen(function* () {
        yield* requireUserActor("externalEntity.handOff", ONLY_THE_USER_HANDS_THINGS_OFF);
        const entity = yield* readEntityOrFail(entityId);
        const answers = listAnswers(yield* readDefinitionOrFail(input.workflowId));
        const signalIds = yield* signalRows.listOpenSignalIdsOfKinds(entity.ref, answers);
        return yield* claims.withSignalsClaimed(
          signalIds,
          REPLY_STILL_RUNNING,
          withTransaction(sql, handOffInTransaction(entityId, input, { answers, signalIds })),
        );
      }),

    /**
     * Takes back the handoff that started `runId`, as far as is safe, and
     * returns what was taken back. The first answer is stored, and a repeat
     * returns it again without changing anything. In one transaction:
     *
     * - a run that has ended is `too-late`: nothing changes;
     * - when nothing of the run was dispatched (every step record is still
     *   `pending` and the run has no session), the Task is taken back if
     *   nothing has changed it since (`TaskService.reverseEntityHandoff`):
     *   the Task the handoff made is deleted, the Task it continued goes back
     *   to its earlier stage, and a failure its start ended returns;
     * - the run and its unfinished sub-runs are cancelled. The runner hears
     *   after the commit, so this is a stop requested, not a stop done.
     *
     * The outcome is `undone` only when the Task was taken back, and
     * `stopped` otherwise, with a `reason`. Signals the handoff ended stay
     * ended, and a later handoff's run is never touched.
     *
     * Fails with `Forbidden` for any caller but the user, and `NotFound` when
     * no handoff of an entity started the run.
     */
    undoHandOff: (runId: string) =>
      Effect.gen(function* () {
        yield* requireUserActor("externalEntity.undoHandOff", ONLY_THE_USER_TAKES_HANDOFF_BACK);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const found = yield* records.read(runId);
            if (Option.isNone(found)) {
              return yield* Effect.fail(
                createNotFoundError("no handoff of an entity has this run"),
              );
            }
            const record = found.value;
            if (record.undo !== undefined) return record.undo;

            const undo = yield* undoInTransaction(record);
            yield* records.storeUndo(runId, undo, yield* nowIso);
            const entity = yield* entities.readTaskableEntity({ ref: record.ref });
            yield* announceEntityChanges({
              entityIds: Option.isSome(entity) ? [entity.value.id] : [],
              affectedTaskIds: [record.taskId],
            });
            return undo;
          }),
        );
      }),
  };
});

/** The entity handoff service. */
export class ExternalEntityHandoffs extends Context.Service<
  ExternalEntityHandoffs,
  Effect.Success<typeof make>
>()("hercule/controller/external-entities/ExternalEntityHandoffs") {}

export const ExternalEntityHandoffsLayer: Layer.Layer<
  ExternalEntityHandoffs,
  never,
  SqlClient.SqlClient | PluginHost | TaskService | RunService | SignalService | SignalClaims
> = Layer.effect(ExternalEntityHandoffs)(make);

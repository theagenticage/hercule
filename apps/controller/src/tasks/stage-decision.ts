/**
 * The stage decision: the one value that says what a write does about a Task's
 * stage, and the one place that works it out.
 *
 * A stage decision is made when a write names a stage (even the one the Task
 * has), when a legacy `status` moves the stage, and when a merge overrules the
 * facts recorded so far. It settles four things together:
 *
 * - the stage to write, if it differs from the stored one;
 * - the fence (`stage_fact_fence`): the highest fact id the stage now accounts
 *   for, so an older fact can never move the card afterwards;
 * - the cause (`stage_cause_fact_id`): the fact that placed the stage, or none;
 * - whether the write counts as someone deciding, which the Undo of a handoff
 *   reads through `stage_revision`, and as an edit, which it reads through
 *   `revision`.
 *
 * `TaskRepository.writeStageDecision` and `TaskRepository.update` write it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";
import {
  createValidationError,
  deriveTaskStatus,
  isFinishedStage,
  type Task,
  type TaskStage,
  type TaskStatus,
  type Validation,
} from "@hercule/contract";
import { isRunStamp } from "../actor";
import { entityFactRepository } from "./entity-facts";
import type { LinkedWorkCounts } from "./linked-work";
import { taskRepository, type ProvenanceInput } from "./repository";

/** What a write does about a Task's stage. See the top of this file. */
export interface StageDecision {
  /** The stage to write, or `undefined` when the Task keeps the stage it has. */
  readonly stage: TaskStage | undefined;
  /** The fence after the write: the highest fact id the stage accounts for. */
  readonly fence: number;
  /** The fact that placed the stage after the write, `null` for none, `undefined` to leave it. */
  readonly cause: number | null | undefined;
  /** True when the write counts as someone deciding the stage (`stage_revision` rises). */
  readonly raisesStageRevision: boolean;
  /**
   * True when the write counts as an edit of the Task. When false (a workflow
   * run placed the stage from a fact) and the stage is all the write changes,
   * `revision` stays as it was.
   */
  readonly countsAsEdit: boolean;
}

/** The fields of a patch that bear on the stage. */
export interface StagePatch {
  readonly stage?: TaskStage;
  readonly status?: TaskStatus;
  /** The fact this stage write comes from. Needs `stage`. */
  readonly stageFactId?: number;
  /** With `stageFactId`: write the stage only if the Task's linked work is finished now. */
  readonly onlyWhenLinkedWorkFinished?: boolean;
  /** The links the same write adds, which count with the stored ones. */
  readonly provenance?: ReadonlyArray<ProvenanceInput>;
}

/**
 * Returns the stage a legacy `status` write moves a Task to. A Task whose
 * stage already reads as that status stays where it is, so `in-progress` never
 * moves an `in-review` Task back to `building`. Otherwise the status gives a
 * stage outright: `open` gives `planned`, `in-progress` gives `building`,
 * `done` gives `done` and `cancelled` gives `dropped`.
 */
const chooseStageForStatus = (current: TaskStage, status: TaskStatus): TaskStage => {
  if (deriveTaskStatus(current) === status) return current;
  switch (status) {
    case "open":
      return "planned";
    case "in-progress":
      return "building";
    case "done":
      return "done";
    case "cancelled":
      return "dropped";
  }
};

/**
 * Builds the stage decisions. `countLinkedWork` counts a Task's open and
 * completed links, with the refs the same write adds.
 */
export const makeStageDecisions = (
  countLinkedWork: (
    taskId: string,
    alsoLinking: ReadonlyArray<string>,
  ) => Effect.Effect<LinkedWorkCounts, SqlError>,
) =>
  Effect.gen(function* () {
    const tasks = yield* taskRepository;
    const facts = yield* entityFactRepository;

    /**
     * Decides whether a stage write that names a fact may go on, and returns
     * the fact's id when it may, or `undefined` when the write must change
     * nothing. A refusal is not an error: a run must not fail because a person
     * dragged a card. The checks run in this order, and the first that fails
     * ends them:
     *
     * 1. The fact must exist and belong to the Task (after the merge
     *    redirect). Otherwise this fails with `Validation`: a caller cannot
     *    make up a fact.
     * 2. The Task is finished: refused. A fact never brings finished work back.
     * 3. The fact is voided, because the user unlinked its thing: refused,
     *    even if the thing was linked again since. The new link has a fact of
     *    its own.
     * 4. The fact is at or below the Task's fence: refused. A person decided
     *    the stage after the fact, or the fact (or a newer one) has been
     *    applied already.
     * 5. With `onlyWhenLinkedWorkFinished`, the links are counted now, and the
     *    write is refused unless none is open and one is completed. The counts
     *    on the event were true when it was written, and a link may have come
     *    or gone since. The refs the write itself links count too.
     */
    const acceptFact = (
      task: Task,
      patch: StagePatch & { readonly stageFactId: number },
    ): Effect.Effect<number | undefined, Validation | SqlError> =>
      Effect.gen(function* () {
        const fact = yield* facts.readFact(patch.stageFactId);
        if (Option.isNone(fact) || fact.value.taskId !== task.id) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["stageFactId"],
                message:
                  `the fact ${String(patch.stageFactId)} is not a fact of this task, so the stage was not written; ` +
                  "pass the factId of a task.entityChanged event of this task, or leave stageFactId out to set the stage yourself",
              },
            ]),
          );
        }
        if (isFinishedStage(task.stage) || fact.value.voidedAt !== null) return undefined;
        if (patch.stageFactId <= (yield* tasks.readStageFence(task.id))) return undefined;
        if (patch.onlyWhenLinkedWorkFinished === true) {
          const counts = yield* countLinkedWork(
            task.id,
            (patch.provenance ?? []).flatMap((entry) =>
              entry.ref === undefined ? [] : [entry.ref],
            ),
          );
          if (counts.openLinks > 0 || counts.completedLinks === 0) return undefined;
        }
        return patch.stageFactId;
      });

    return {
      /**
       * Turns a write's stage fields into a stage decision, or returns
       * `undefined` when the write decides nothing about the stage. `task` is
       * the live Task as stored, after the merge redirect, and `actor` is the
       * stamp of whoever writes. Fails with `Validation` for a fact that is
       * not a fact of the Task (see `acceptFact`).
       *
       * - A patch that leaves the stage alone decides nothing. So does a
       *   `status` the Task's stage already reads as, and a stage write whose
       *   fact was refused.
       * - A stage written with no fact is a person's or an agent's. It
       *   overrules every fact recorded so far (the fence becomes the highest
       *   fact id), clears the cause, and counts as a decision and an edit.
       *   That holds when the stage is the one the Task has: it is an explicit
       *   "keep it here".
       * - A stage written from an accepted fact sets the fence to the fact. If
       *   the stage differs, the cause becomes the fact; if the Task holds
       *   that stage already, only the fence moves and the cause stays, because
       *   the fact placed nothing.
       * - A workflow run that writes from a fact is not anyone deciding, so its
       *   write leaves the stage revision alone, and the revision too when the
       *   stage is all it changes. A user or a session that passes a fact is
       *   fenced the same way, but it is deciding, so it raises both.
       */
      decideStageOfPatch: (
        task: Task,
        patch: StagePatch,
        actor: string,
      ): Effect.Effect<StageDecision | undefined, Validation | SqlError> =>
        Effect.gen(function* () {
          let named = patch.stage;
          let factId: number | undefined;
          if (patch.stageFactId !== undefined) {
            factId = yield* acceptFact(task, { ...patch, stageFactId: patch.stageFactId });
            if (factId === undefined) named = undefined;
          }
          const target =
            named ??
            (patch.status === undefined
              ? undefined
              : chooseStageForStatus(task.stage, patch.status));
          const stage = target !== undefined && target !== task.stage ? target : undefined;
          if (named === undefined && stage === undefined) return undefined;
          if (factId === undefined) {
            return {
              stage,
              fence: yield* facts.readHighestFactId(),
              cause: null,
              raisesStageRevision: true,
              countsAsEdit: true,
            };
          }
          const byRun = isRunStamp(actor);
          return {
            stage,
            fence: factId,
            cause: stage === undefined ? undefined : factId,
            raisesStageRevision: !byRun,
            countsAsEdit: !byRun,
          };
        }),

      /**
       * Returns the stage decision of a merge: the survivor keeps its stage,
       * and every fact recorded so far is overruled (the fence becomes the
       * highest fact id) and the cause is cleared, because merging is a
       * person's act. Read it after the merged Task's facts have moved, so the
       * moved ones are overruled too. It raises neither revision, as a merge
       * never did.
       */
      decideStageOfMerge: (): Effect.Effect<StageDecision, SqlError> =>
        Effect.map(facts.readHighestFactId(), (fence) => ({
          stage: undefined,
          fence,
          cause: null,
          raisesStageRevision: false,
          countsAsEdit: true,
        })),
    };
  });

/**
 * Writes the facts that keep a Task's stage true to the things it links, and
 * counts a Task's linked work.
 *
 * A fact is one row (`task_entity_facts`) and one `task.entityChanged`
 * Platform Event, written in the transaction of the change it reports. The
 * rules for when a change is a fact, and for what a link counts as, are the
 * pure functions of `linked-work.ts`. This module reads the states through the
 * `LinkedEntities` port, applies the rules, and writes.
 *
 * Facts are written on these occasions:
 *
 * - an entity write changes a linked thing (`snapshotLinkedEntities` before
 *   the write, `recordEntityFacts` after it);
 * - a link is added (`recordLinkFacts`);
 * - the last open link goes away and a completed one remains
 *   (`recordLandingFact`, called by `unlinkEntity`);
 * - a shipped workflow is installed for the first time
 *   (`recordFirstInstallFacts`).
 *
 * The event carries the actor `system`: no request caused it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createValidationError,
  isFinishedStage,
  type TaskStage,
  type Validation,
} from "@hercule/contract";
import { SYSTEM_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import { PlatformEvents } from "../events";
import { entityFactRepository, type EntityLinkPair } from "./entity-facts";
import { groupByTask, removeDuplicates } from "./lists";
import { LinkedEntities, type LinkedEntityState } from "./linked-entities";
import {
  classifyLink,
  countLinkedWork,
  decideFactLifecycles,
  haveLinkedWorkCountsChanged,
  type FactLifecycles,
  type LinkedWorkCounts,
} from "./linked-work";
import { taskRepository } from "./repository";

/**
 * What `snapshotLinkedEntities` read before a write of entities, for
 * `recordEntityFacts` to compare with after it. Callers only pass it back.
 *
 * It is valid only inside the transaction that took it: it holds the states
 * of that moment, and a later transaction may see others.
 */
export interface LinkedEntitySnapshot {
  /** The live `(Task, ref)` links to the refs the write may change. */
  readonly links: ReadonlyArray<EntityLinkPair>;
  /** Every link of each Task in `links`, not only the ones to changed refs. */
  readonly linksOfTask: ReadonlyMap<string, ReadonlyArray<string>>;
  /** The state of every ref in `linksOfTask`, before the write. */
  readonly states: ReadonlyMap<string, LinkedEntityState>;
}

/** Groups the refs of `links` by Task, keeping the order of `links` within each Task. */
const groupRefsByTask = (
  links: ReadonlyArray<EntityLinkPair>,
): ReadonlyMap<string, ReadonlyArray<string>> =>
  new Map([...groupByTask(links)].map(([taskId, group]) => [taskId, group.map(({ ref }) => ref)]));

/** Counts the links in `refs` by the states in `states`. */
const countStates = (
  refs: ReadonlyArray<string>,
  states: ReadonlyMap<string, LinkedEntityState>,
): LinkedWorkCounts => countLinkedWork(refs.map((ref) => states.get(ref)));

/** What a write that names a fact asks for. */
export interface StageFactClaim {
  readonly factId: number;
  /** Move the Task only if none of its links is open and one is completed. */
  readonly onlyWhenLinkedWorkFinished: boolean;
  /**
   * The refs the same write links, which are not stored yet. The check counts
   * them with the stored links, so a write cannot land a card and add open
   * work in one call.
   */
  readonly alsoLinking: ReadonlyArray<string>;
}

/**
 * The verdict on a stage write that names a fact: `refused` means the write
 * changes nothing, and `accepted` carries the fact's id, which becomes the
 * Task's fence.
 */
export type StageFactVerdict =
  | { readonly _tag: "refused" }
  | { readonly _tag: "accepted"; readonly factId: number };

export const makeLinkedFacts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const facts = yield* entityFactRepository;
  const tasks = yield* taskRepository;
  const linkedEntities = yield* LinkedEntities;
  const platformEvents = yield* PlatformEvents;

  /**
   * Writes one fact about `ref` for the Task and its Platform Event, in the
   * caller's transaction. `counts` are the Task's counts after the change.
   */
  const writeFact = (input: {
    readonly taskId: string;
    readonly ref: string;
    readonly entityKind: string;
    readonly lifecycles: FactLifecycles;
    readonly counts: LinkedWorkCounts;
    readonly at: string;
  }): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const { taskId, ref, lifecycles, counts, at } = input;
      const factId = yield* facts.insertFact({
        taskId,
        ref,
        lifecycle: lifecycles.lifecycle,
        previousLifecycle: lifecycles.previousLifecycle,
        observedAt: at,
      });
      yield* platformEvents.emit({
        kind: "task.entityChanged",
        actor: SYSTEM_ACTOR,
        payload: {
          taskId,
          ref,
          entityKind: input.entityKind,
          lifecycle: lifecycles.lifecycle,
          previousLifecycle: lifecycles.previousLifecycle,
          factId,
          openLinks: counts.openLinks,
          completedLinks: counts.completedLinks,
          observedAt: at,
        },
        at,
      });
    });

  /**
   * Writes the first-sight fact of each of `refs` of a live Task that is a
   * piece of work with a lifecycle: `previousLifecycle` is null. The caller
   * has read `states` of every link of the Task and counted them.
   */
  const writeFirstFacts = (
    taskId: string,
    refs: ReadonlyArray<string>,
    states: ReadonlyMap<string, LinkedEntityState>,
    counts: LinkedWorkCounts,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.forEach(
      refs,
      (ref) => {
        const state = states.get(ref);
        if (state === undefined || state.classification !== "work" || state.lifecycle === null) {
          return Effect.void;
        }
        return writeFact({
          taskId,
          ref,
          entityKind: state.kind,
          lifecycles: { lifecycle: state.lifecycle, previousLifecycle: null },
          counts,
          at,
        });
      },
      { discard: true },
    );

  const countTaskLinks = (
    taskId: string,
    alsoLinking: ReadonlyArray<string> = [],
  ): Effect.Effect<LinkedWorkCounts, SqlError> =>
    Effect.gen(function* () {
      const id = yield* tasks.resolveTaskId(taskId);
      const refs = removeDuplicates([
        ...((yield* tasks.listEntityLinks([id])).get(id) ?? []),
        ...alsoLinking,
      ]);
      return countStates(refs, yield* linkedEntities.readMany(refs));
    });

  return {
    /**
     * Counts the links of the Task `taskId` (or of the Task it was merged
     * into) as open or completed, by the rules of `countLinkedWork`. One
     * batch through `LinkedEntities`. It checks no grant.
     */
    countLinkedWork: countTaskLinks,

    /**
     * Decides whether a stage write that names a fact may go on, in the
     * caller's transaction. `task` is the live Task the write is about, after
     * the merge redirect. The checks run in this order, and the first that
     * fails ends them:
     *
     * 1. The fact must exist and belong to the Task. Otherwise this fails
     *    with `Validation`: a caller cannot make up a fact.
     * 2. The Task is finished: refused. A fact never brings finished work back.
     * 3. The fact is voided, because the user unlinked its thing: refused,
     *    even if the thing was linked again since. The new link has a fact of
     *    its own.
     * 4. The fact is at or below the Task's fence: refused. A person decided
     *    the stage after the fact, or the fact (or a newer one) has been
     *    applied already.
     * 5. With `onlyWhenLinkedWorkFinished`, the links are counted now, and
     *    the write is refused unless none is open and one is completed. The
     *    counts on the event were true when it was written, and a link may
     *    have come or gone since. The refs the write itself links count too.
     *
     * A refusal is not an error: a run must not fail because a person dragged
     * a card.
     */
    judgeStageFact: (
      task: { readonly id: string; readonly stage: TaskStage },
      claim: StageFactClaim,
    ): Effect.Effect<StageFactVerdict, Validation | SqlError> =>
      Effect.gen(function* () {
        const fact = yield* facts.readFact(claim.factId);
        if (Option.isNone(fact) || fact.value.taskId !== task.id) {
          return yield* Effect.fail(
            createValidationError([
              {
                path: ["stageFactId"],
                message:
                  `the fact ${String(claim.factId)} is not a fact of this task, so the stage was not written; ` +
                  "pass the factId of a task.entityChanged event of this task, or leave stageFactId out to set the stage yourself",
              },
            ]),
          );
        }
        if (isFinishedStage(task.stage) || fact.value.voidedAt !== null) {
          return { _tag: "refused" } as const;
        }
        if (claim.factId <= (yield* facts.readFence(task.id))) return { _tag: "refused" } as const;
        if (claim.onlyWhenLinkedWorkFinished) {
          const counts = yield* countTaskLinks(task.id, claim.alsoLinking);
          if (counts.openLinks > 0 || counts.completedLinks === 0)
            return { _tag: "refused" } as const;
        }
        return { _tag: "accepted", factId: claim.factId } as const;
      }),

    /**
     * Reads, before a write of entities, the state of `refs` and of every
     * other link of the live Tasks that link them. Pass the result to
     * `recordEntityFacts` after the write, in the same transaction. A ref no
     * live Task links needs nothing and costs one statement.
     */
    snapshotLinkedEntities: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<LinkedEntitySnapshot, SqlError> =>
      Effect.gen(function* () {
        const links = yield* facts.listLiveLinksTo(removeDuplicates(refs));
        const taskIds = removeDuplicates(links.map(({ taskId }) => taskId));
        const linksOfTask =
          taskIds.length === 0
            ? new Map<string, ReadonlyArray<string>>()
            : yield* tasks.listEntityLinks(taskIds);
        const states = yield* linkedEntities.readMany(
          removeDuplicates([...linksOfTask.values()].flat()),
        );
        return { links, linksOfTask, states };
      }),

    /**
     * Writes the facts that the write since `snapshot` made, in the caller's
     * transaction: for each live Task that links a changed thing, at most one
     * fact for each thing, by `decideFactLifecycles`. Each fact and its
     * `task.entityChanged` event carry the Task's counts over all its links
     * after the write. A write that changed nothing a Task counts writes
     * nothing.
     */
    recordEntityFacts: (snapshot: LinkedEntitySnapshot): Effect.Effect<void, SqlError> =>
      snapshot.links.length === 0
        ? Effect.void
        : withTransaction(
            sql,
            Effect.gen(function* () {
              const at = yield* nowIso;
              const now = yield* linkedEntities.readMany(
                removeDuplicates([...snapshot.linksOfTask.values()].flat()),
              );
              for (const [taskId, changedRefs] of groupRefsByTask(snapshot.links)) {
                const allRefs = snapshot.linksOfTask.get(taskId) ?? [];
                const before = countStates(allRefs, snapshot.states);
                const after = countStates(allRefs, now);
                const countsChanged = haveLinkedWorkCountsChanged(before, after);
                for (const ref of changedRefs) {
                  const lifecycles = decideFactLifecycles(
                    snapshot.states.get(ref),
                    now.get(ref),
                    countsChanged,
                  );
                  if (lifecycles === undefined) continue;
                  yield* writeFact({
                    taskId,
                    ref,
                    entityKind: now.get(ref)!.kind,
                    lifecycles,
                    counts: after,
                    at,
                  });
                }
              }
            }),
          ),

    /**
     * Writes a first-sight fact (`previousLifecycle` null) for each of `refs`,
     * which the live Task `taskId` has just linked, when the thing is a piece
     * of work with a lifecycle. Does nothing for a Task that is not live. Run
     * it in the transaction that wrote the links; the Task is taken as it is.
     */
    recordLinkFacts: (
      taskId: string,
      refs: ReadonlyArray<string>,
    ): Effect.Effect<void, SqlError> =>
      refs.length === 0
        ? Effect.void
        : withTransaction(
            sql,
            Effect.gen(function* () {
              const allRefs = yield* facts.listLiveLinkRefsOf(taskId);
              if (allRefs.length === 0) return;
              const states = yield* linkedEntities.readMany(allRefs);
              yield* writeFirstFacts(
                taskId,
                removeDuplicates(refs).toSorted(),
                states,
                countStates(allRefs, states),
                yield* nowIso,
              );
            }),
          ),

    /**
     * Writes the fact that lets a card land after an unlink: when the live
     * Task `taskId` has no open link left and at least one completed link, a
     * fact for its newest completed link, whose `previousLifecycle` is its own
     * lifecycle. Does nothing otherwise. Without it, taking away the last open
     * link could never land a card. Run it in the transaction of the unlink.
     */
    recordLandingFact: (taskId: string): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          if ((yield* facts.listLiveLinkRefsOf(taskId)).length === 0) return;
          // The links come oldest first, so the newest completed one is the last.
          const oldestFirst = (yield* tasks.listEntityLinks([taskId])).get(taskId) ?? [];
          const states = yield* linkedEntities.readMany(oldestFirst);
          const counts = countStates(oldestFirst, states);
          if (counts.openLinks > 0 || counts.completedLinks === 0) return;
          const ref = oldestFirst.findLast(
            (candidate) => classifyLink(states.get(candidate)) === "completed",
          )!;
          const state = states.get(ref)!;
          yield* writeFact({
            taskId,
            ref,
            entityKind: state.kind,
            lifecycles: { lifecycle: "completed", previousLifecycle: "completed" },
            counts,
            at: yield* nowIso,
          });
        }),
      ),

    /**
     * Writes a first-sight fact (`previousLifecycle` null) for every link of
     * every live Task to a piece of work that has a lifecycle, in the
     * caller's transaction. A shipped workflow calls it when it is installed
     * for the first time, so that cards whose pull request was linked before
     * the workflow existed are corrected.
     */
    recordFirstInstallFacts: (): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const links = groupRefsByTask(yield* facts.listAllLiveLinks());
          const states = yield* linkedEntities.readMany(
            removeDuplicates([...links.values()].flat()),
          );
          const at = yield* nowIso;
          for (const [taskId, refs] of links) {
            yield* writeFirstFacts(taskId, refs, states, countStates(refs, states), at);
          }
        }),
      ),
  };
});

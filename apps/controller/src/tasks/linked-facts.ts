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
 * - an entity write changes a linked thing (`recordEntityFactsAround`, which
 *   reads before the write and writes the facts after it);
 * - a link is added (`recordLinkFacts`);
 * - the last open link goes away and a completed one remains
 *   (`recordLandingFact`, called by `unlinkEntity`);
 * - a shipped workflow is installed for the first time
 *   (`recordFirstInstallFacts`).
 *
 * The event carries the actor `system`: no request caused it.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { SYSTEM_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import { PlatformEvents } from "../events";
import { entityFactRepository, type EntityLinkPair } from "./entity-facts";
import { groupByTask } from "./lists";
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
 * What was read before a write of entities, to compare with after it. It is
 * valid only inside the transaction that took it: it holds the states of that
 * moment, and a later transaction may see others.
 */
interface LinkedEntitySnapshot {
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
      const refs = Arr.dedupe([
        ...((yield* tasks.listEntityLinks([id])).get(id) ?? []),
        ...alsoLinking,
      ]);
      return countStates(refs, yield* linkedEntities.readMany(refs));
    });

  /**
   * Reads the state of `refs` and of every other link of the live Tasks that
   * link them, to compare with after a write.
   */
  const takeSnapshot = (
    refs: ReadonlyArray<string>,
  ): Effect.Effect<LinkedEntitySnapshot, SqlError> =>
    Effect.gen(function* () {
      const links = yield* facts.listLiveLinksTo(Arr.dedupe(refs));
      const taskIds = Arr.dedupe(links.map(({ taskId }) => taskId));
      const linksOfTask =
        taskIds.length === 0
          ? new Map<string, ReadonlyArray<string>>()
          : yield* tasks.listEntityLinks(taskIds);
      const states = yield* linkedEntities.readMany(Arr.dedupe([...linksOfTask.values()].flat()));
      return { links, linksOfTask, states };
    });

  /** Writes the facts that the write since `snapshot` made. Run it in the transaction of the write. */
  const recordFactsSince = (snapshot: LinkedEntitySnapshot): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (snapshot.links.length === 0) return;
      const at = yield* nowIso;
      const now = yield* linkedEntities.readMany(
        Arr.dedupe([...snapshot.linksOfTask.values()].flat()),
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
    });

  return {
    /**
     * Counts the links of the Task `taskId` (or of the Task it was merged
     * into) as open or completed, by the rules of `countLinkedWork`. One
     * batch through `LinkedEntities`. It checks no grant.
     */
    countLinkedWork: countTaskLinks,

    /**
     * Runs `write`, which changes what is stored of `refs`, and writes the
     * facts that change makes for the live Tasks that link those things, then
     * returns what `write` returned. It joins the caller's transaction, or
     * opens one, so the snapshot, the write and the facts commit together.
     *
     * Before the write it reads the state of `refs` and of every other link of
     * the live Tasks that link them. A ref no live Task links costs one
     * statement and writes no fact, which is the usual poll. After the write
     * it compares, and for each live Task that links a changed thing writes at
     * most one fact for each thing, by `decideFactLifecycles`. Each fact and
     * its `task.entityChanged` event carry the Task's counts over all its
     * links after the write. A write that changed nothing a Task counts
     * writes nothing.
     */
    recordEntityFactsAround: <A, E, R>(
      refs: ReadonlyArray<string>,
      write: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SqlError, R> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const snapshot = yield* takeSnapshot(refs);
          const written = yield* write;
          yield* recordFactsSince(snapshot);
          return written;
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
                Arr.dedupe(refs).toSorted(),
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
          const states = yield* linkedEntities.readMany(Arr.dedupe([...links.values()].flat()));
          const at = yield* nowIso;
          for (const [taskId, refs] of links) {
            yield* writeFirstFacts(taskId, refs, states, countStates(refs, states), at);
          }
        }),
      ),
  };
});

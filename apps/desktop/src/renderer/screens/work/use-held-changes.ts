import { useEffect, useRef, type RefObject } from "react";
import {
  chooseLaneId,
  listContextLaneIds,
  type HeldChange,
  type WorkProject,
} from "@hercule/client-core/work";
import type { WorkBoard, WorkCard } from "@hercule/contract";
import { pauseFor, waitForVisibleStillHand } from "../../app/motion";

/** Returns the ids of the lanes the board draws `card` in, given how it is grouped. */
const listDrawnLaneIds = (
  card: WorkCard,
  board: WorkBoard,
  projects: readonly WorkProject[],
  groupBy: string,
): readonly string[] =>
  board.groupings.some((grouping) => grouping.kind === groupBy)
    ? listContextLaneIds(card, board.places, groupBy)
    : [chooseLaneId(card, new Set(projects.map((project) => project.id)))];

/**
 * Returns every element a held change would happen at: all drawn copies of
 * the failing card (a Task under two places has a card in each lane), or the
 * cell of each lane where the new Task would land. Returns none when the
 * change has no place on the page, for example under a filter.
 */
const findChangeTargets = (
  scroller: HTMLElement | null,
  change: HeldChange,
  card: WorkCard | undefined,
  board: WorkBoard | undefined,
  projects: readonly WorkProject[],
  groupBy: string,
): readonly Element[] => {
  if (scroller === null) return [];
  if (change.kind === "failure" || change.kind === "move")
    return [...scroller.querySelectorAll(`[data-card-id="${CSS.escape(change.cardId)}"]`)];
  if (card === undefined || board === undefined) return [];
  const cells = listDrawnLaneIds(card, board, projects, groupBy).map(
    (laneId) => `[data-lane-id="${CSS.escape(laneId)}"][data-stage="${card.stage}"]`,
  );
  return [...scroller.querySelectorAll(cells.join(","))];
};

/** What a held change is about, handed to `beforeRelease` to show it before it happens. */
export interface HeldContext {
  /** The change's card as the board was last read (the logical board), or `undefined` when it is gone. */
  readonly card: WorkCard | undefined;
  /** Returns every element the change would happen at (see `findChangeTargets`), as the page is now. */
  readonly findTargets: () => readonly Element[];
  /** Aborts when the change is no longer held, or the screen goes. */
  readonly signal: AbortSignal;
}

/**
 * Waits for a still hand (`waitForVisibleStillHand`) for each change in
 * `held`, then calls `release` with the change. A change that is no longer
 * held stops waiting.
 *
 * - `startDelays` holds back the start of the wait for a change, in
 *   milliseconds after it is first held, by key. The morning replay uses it to
 *   start its changes 1.5 seconds apart.
 * - `beforeRelease`, when given, runs once the hand is still and before the
 *   change is released. It resolves `true` to go ahead and `false` when the
 *   change must not happen (its signal aborted). A card that moves by itself
 *   shows its cause there.
 * - Nothing is waited for or released while the window is hidden.
 *
 * `board` is the board as read, not as drawn: a held card is only in this one.
 * `groupBy` is how the board is grouped, so that a change is waited for at
 * the lanes that are drawn: a Project lane, or a lane for an outside place.
 * A change that waits for a drag to end is released after the drop, not
 * during it.
 */
export const useHeldChanges = ({
  held,
  board,
  projects,
  groupBy,
  isCarrying,
  scrollRef,
  startDelays,
  beforeRelease,
  release,
}: {
  readonly held: readonly HeldChange[];
  readonly board: WorkBoard | undefined;
  readonly projects: readonly WorkProject[];
  readonly groupBy: string;
  readonly isCarrying: boolean;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly startDelays: ReadonlyMap<string, number>;
  readonly beforeRelease: (change: HeldChange, context: HeldContext) => Promise<boolean>;
  readonly release: (change: HeldChange) => void;
}): void => {
  const latest = useRef({
    held,
    board,
    projects,
    groupBy,
    isCarrying,
    release,
    startDelays,
    beforeRelease,
  });
  useEffect(() => {
    latest.current = {
      held,
      board,
      projects,
      groupBy,
      isCarrying,
      release,
      startDelays,
      beforeRelease,
    };
  });
  const waits = useRef(new Map<string, AbortController>());

  const heldKeys = held.map((change) => change.key).join("|");
  useEffect(() => {
    const wanted = new Map(latest.current.held.map((change) => [change.key, change]));
    for (const [key, controller] of waits.current) {
      if (wanted.has(key)) continue;
      controller.abort();
      waits.current.delete(key);
    }
    for (const [key, change] of wanted) {
      if (waits.current.has(key)) continue;
      const controller = new AbortController();
      const { signal } = controller;
      waits.current.set(key, controller);
      const findCard = (): WorkCard | undefined =>
        latest.current.board?.cards.find((each) => each.id === change.cardId);
      const findTargets = (): readonly Element[] =>
        findChangeTargets(
          scrollRef.current,
          change,
          findCard(),
          latest.current.board,
          latest.current.projects,
          latest.current.groupBy,
        );
      void (async () => {
        const delay = latest.current.startDelays.get(key);
        if (delay !== undefined && !(await pauseFor(delay, signal))) return;
        const isStill = await waitForVisibleStillHand({
          targets: findTargets,
          isDragging: () => latest.current.isCarrying,
          signal,
        });
        if (!isStill) return;
        const isReady = await latest.current.beforeRelease(change, {
          card: findCard(),
          findTargets,
          signal,
        });
        if (!isReady) return;
        waits.current.delete(key);
        latest.current.release(change);
      })();
    }
  }, [heldKeys, scrollRef]);
  useEffect(() => {
    const running = waits.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, []);
};

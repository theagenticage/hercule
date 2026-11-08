import { useEffect, useRef, useState, type RefObject } from "react";
import {
  chooseLaneId,
  listContextLaneIds,
  type HeldChange,
  type WorkProject,
} from "@hercule/client-core/work";
import type { WorkBoard, WorkCard } from "@hercule/contract";
import { isMotionReduced, pauseFor, waitForVisibleStillHand } from "../../app/motion";
import { showCauseLabel } from "../desk";
import { REPLAY_GAP_MS } from "./morning-replay";

/** How long the toolbar's line keeps saying what happened by itself, in milliseconds. */
const NOTE_SHOWN_MS = 10_000;

/** How long the cause label stays on a card before the card moves, in milliseconds. Under Reduce motion the card does not travel, so the label only needs to be seen. */
const CAUSE_HELD_MS = 760;
const CAUSE_HELD_REDUCED_MS = 80;

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

/** Returns the sentence for the toolbar's line when `change` shows, or `null` when the card is gone. */
const describeChange = (change: HeldChange, card: WorkCard | undefined): string | null => {
  if (card === undefined) return null;
  if (change.kind === "arrival") return `New: ${card.title}`;
  if (change.kind === "move") return card.stageCause?.text ?? `Moved: ${card.title}`;
  return `${card.failure?.workflowName ?? "A run"} failed`;
};

/**
 * Waits for a still hand (`waitForStillHand`) for each change in `held`, and
 * calls `release` with its key once the hand is still. A change that is no
 * longer held stops waiting. Returns the sentence for the toolbar's line that
 * names what the board did by itself last, such as "Review PR failed", or
 * `null` when there is nothing to show. The sentence goes away after ten
 * seconds.
 *
 * - A card moved by a fact first shows why: its cause label rises onto the
 *   card and holds for 760ms (80ms under Reduce motion), and only then is the
 *   change released. A drag that begins during the hold makes it wait for the
 *   drop.
 * - `startDelays` holds back the start of the wait for a change, in
 *   milliseconds after it is first held, by key. The morning replay uses it to
 *   start its changes 1.5 seconds apart. The sentence of such a change stays
 *   for 1.5 seconds only, so the next one can follow it.
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
  release,
  startDelays,
}: {
  readonly held: readonly HeldChange[];
  readonly board: WorkBoard | undefined;
  readonly projects: readonly WorkProject[];
  readonly groupBy: string;
  readonly isCarrying: boolean;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly release: (key: string) => void;
  readonly startDelays: ReadonlyMap<string, number>;
}): string | null => {
  const [note, setNote] = useState<{ readonly text: string; readonly shownMs: number } | null>(
    null,
  );
  const latest = useRef({ held, board, projects, groupBy, isCarrying, release, startDelays });
  useEffect(() => {
    latest.current = { held, board, projects, groupBy, isCarrying, release, startDelays };
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
      const waitForDrop = (): Promise<boolean> =>
        waitForVisibleStillHand({
          targets: () => [],
          isDragging: () => latest.current.isCarrying,
          signal,
        });
      void (async () => {
        const delay = latest.current.startDelays.get(key);
        if (delay !== undefined && !(await pauseFor(delay, signal))) return;
        const isStill = await waitForVisibleStillHand({
          targets: findTargets,
          isDragging: () => latest.current.isCarrying,
          signal,
        });
        if (!isStill) return;
        const cause = change.kind === "move" ? findCard()?.stageCause : undefined;
        if (cause !== undefined) {
          const labelled = findTargets().filter((each) => each instanceof HTMLElement);
          const removeLabel = showCauseLabel(labelled, cause.text, true);
          signal.addEventListener("abort", removeLabel, { once: true });
          const isHeld = await pauseFor(
            isMotionReduced() ? CAUSE_HELD_REDUCED_MS : CAUSE_HELD_MS,
            signal,
          );
          if (!isHeld || !(await waitForDrop())) return;
        }
        waits.current.delete(key);
        latest.current.release(key);
        const text = describeChange(change, findCard());
        if (text !== null) {
          setNote({ text, shownMs: delay === undefined ? NOTE_SHOWN_MS : REPLAY_GAP_MS });
        }
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

  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => {
      setNote(null);
    }, note.shownMs);
    return () => {
      clearTimeout(timer);
    };
  }, [note]);

  return note?.text ?? null;
};

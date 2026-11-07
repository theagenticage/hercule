import { useEffect, useRef, useState, type RefObject } from "react";
import { chooseLaneId, type HeldChange, type WorkProject } from "@hercule/client-core/work";
import type { WorkBoard, WorkCard } from "@hercule/contract";
import { waitForStillHand } from "../../app/motion";

/** How long the toolbar's line keeps saying what happened by itself, in milliseconds. */
const NOTE_SHOWN_MS = 10_000;

/** Returns the element a held change would happen at: the failing card, or the cell where the new Task would land. */
const findChangeTarget = (
  scroller: HTMLElement | null,
  change: HeldChange,
  card: WorkCard | undefined,
  projects: readonly WorkProject[],
): Element | null => {
  if (scroller === null) return null;
  if (change.kind === "failure") return scroller.querySelector(`[data-card-id="${change.cardId}"]`);
  if (card === undefined) return null;
  const laneId = chooseLaneId(card, new Set(projects.map((project) => project.id)));
  return scroller.querySelector(
    `[data-lane-id="${CSS.escape(laneId)}"][data-stage="${card.stage}"]`,
  );
};

/** Returns the sentence for the toolbar's line when `change` shows, or `null` when the card is gone. */
const describeChange = (change: HeldChange, card: WorkCard | undefined): string | null => {
  if (card === undefined) return null;
  return change.kind === "arrival"
    ? `New: ${card.title}`
    : `${card.failure?.workflowName ?? "A run"} failed`;
};

/**
 * Waits for a still hand (`waitForStillHand`) for each change in `held`, and
 * calls `release` with its key once the hand is still. A change that is no
 * longer held stops waiting. Returns the sentence for the toolbar's line that
 * names what the board did by itself last, such as "Review PR failed", or
 * `null` when there is nothing to show. The sentence goes away after ten
 * seconds.
 *
 * `board` is the board as read, not as drawn: a held card is only in this one.
 * A change that waits for a drag to end is released after the drop, not
 * during it.
 */
export const useHeldChanges = ({
  held,
  board,
  projects,
  isCarrying,
  scrollRef,
  release,
}: {
  readonly held: readonly HeldChange[];
  readonly board: WorkBoard | undefined;
  readonly projects: readonly WorkProject[];
  readonly isCarrying: boolean;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly release: (key: string) => void;
}): string | null => {
  const [note, setNote] = useState<{ readonly text: string } | null>(null);
  const latest = useRef({ held, board, projects, isCarrying, release });
  useEffect(() => {
    latest.current = { held, board, projects, isCarrying, release };
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
      waits.current.set(key, controller);
      const findCard = (): WorkCard | undefined =>
        latest.current.board?.cards.find((each) => each.id === change.cardId);
      void waitForStillHand({
        target: () =>
          findChangeTarget(scrollRef.current, change, findCard(), latest.current.projects),
        isDragging: () => latest.current.isCarrying,
        signal: controller.signal,
      }).then((isStill) => {
        if (!isStill) return;
        waits.current.delete(key);
        latest.current.release(key);
        const text = describeChange(change, findCard());
        if (text !== null) setNote({ text });
      });
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
    }, NOTE_SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [note]);

  return note?.text ?? null;
};

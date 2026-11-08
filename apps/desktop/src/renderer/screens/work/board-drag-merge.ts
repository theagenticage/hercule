/**
 * The merge gesture of a carry: when the card in the hand rests over the
 * middle of another card (or Option is held), the two are drawn together. The
 * card in the hand docks on the corner of the card it would merge into, and
 * moving off the middle of that card undoes it.
 */
import {
  describeMergeKeeps,
  type MergeCheckResult,
  type MergeCheckState,
  type WorkInitiative,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { measureLayoutRect, type LayoutRect, type MotionBody } from "../../app/motion";
import { CARRY_SCALE } from "./board-drag-carry";
import { markMergeTarget, showMergeTargetWords, unmarkMergeTarget } from "./merge-target";

/** How long, in milliseconds, the hand must rest over the middle of a card before the two are drawn together. */
const MERGE_DWELL_MS = 1000;

/** How far, in pixels, the pointer may drift from where it began to rest before the wait starts again. */
const MERGE_STILL_DISTANCE = 6;

/** Where the card in the hand docks on the card it merges into: this far across and down from its corner, in pixels. */
const DOCK_ACROSS = 10;
const DOCK_DOWN = 8;

/** How the card in the hand looks when docked: smaller, tilted, and lifted less. */
const DOCK_SCALE = 0.96;
const DOCK_TILT = 1.6;
const DOCK_LIFT = 0.6;

/** How long, in milliseconds, a card that leaves its dock glides to the pointer instead of jumping to it. */
const UNDOCK_GLIDE_MS = 200;

/**
 * The card a carry would merge into: its id, its element (which carries the
 * marks), and what the merge check found when the choice was read. A drop on
 * a `refused` choice merges nothing.
 */
export interface MergeChoice {
  readonly cardId: string;
  readonly element: HTMLElement;
  readonly check: MergeCheckState;
}

/** A place in the window, in pixels. */
export interface Pointer {
  readonly x: number;
  readonly y: number;
}

/**
 * How the card in the hand follows the pointer while a merge gesture runs:
 * - `docked`: it sits on the card it merges into and stays there.
 * - `gliding`: it just left a dock and glides to the pointer instead of jumping.
 * - `free`: it is under the pointer one to one.
 */
export type HandMotion = "docked" | "gliding" | "free";

/** The parts of the carry that the merge gesture moves and measures. */
export interface MergeCarried {
  /** The scroller that holds the cards of the board. */
  readonly scroller: HTMLElement;
  /** Returns the cards the board draws now, to read the title of the card merged into. */
  readonly readCards: () => readonly WorkCard[];
  /** Returns the open Initiatives, to name the one a merge keeps. */
  readonly readInitiatives: () => readonly WorkInitiative[];
  /** The id of the card in the hand: the card that merges away. */
  readonly sourceId: string;
  /**
   * Asks whether the card in the hand could be merged into the card
   * `targetId`. It never rejects: a question that could not be asked
   * answers `unchecked`.
   */
  readonly checkMerge: (sourceId: string, targetId: string) => Promise<MergeCheckResult>;
  /** The hollow that shows where the card would land. It closes while a merge is chosen. */
  readonly slot: HTMLElement;
  /** The body of the copy in the hand. */
  readonly body: MotionBody;
  /** Where the layout puts the copy in the hand, in window pixels. */
  readonly home: LayoutRect;
  /** Where in the card the pointer took hold of it. */
  readonly grab: Pointer;
  readonly reduced: boolean;
  /** Where the pointer is when the carry starts. */
  readonly pointer: Pointer;
  /** Whether Option (Alt) is held when the carry starts. */
  readonly isOptionHeld: boolean;
}

/**
 * The merge gesture of one carry. It owns the wait, the card chosen, the
 * dock of the card in the hand and the marks on the page. The carry only
 * feeds it what happens and asks for the result.
 *
 * Once `commit` or `cancel` has been called the gesture is over: it starts no
 * wait and chooses no card.
 */
export interface MergeGesture {
  /**
   * Tells the gesture where the pointer is now and which card's middle it is
   * over (`candidateId`, or `null`). Only a hand held still over a card's
   * middle means merge, or Option at once: passing over a card, or still
   * deciding where to put the card, starts nothing. The wait starts again
   * when the pointer moves more than 6px or reaches another card, and moving
   * off the middle of the chosen card undoes the merge at once.
   */
  readonly update: (pointer: Pointer, candidateId: string | null) => void;
  /** Tells the gesture whether Option is held. It takes effect at the next `update`. */
  readonly setOptionHeld: (isHeld: boolean) => void;
  /**
   * Tells the gesture that the page changed or scrolled, which moves the
   * card chosen: the card in the hand docks on it again. When the chosen
   * card was replaced by a new element, which lost its marks, the merge is undone.
   */
  readonly refresh: () => void;
  /** Returns how the card in the hand should follow the pointer now. */
  readonly handMotion: () => HandMotion;
  /**
   * Ends the gesture for a drop and returns the card the carry is drawn
   * into, or `null` when none is chosen. The marks stay on the page until `cancel`.
   */
  readonly commit: () => MergeChoice | null;
  /** Ends the gesture, stops its wait and takes the marks off the chosen card. Does nothing more to the card in the hand or the slot. Safe to call again. */
  readonly cancel: () => void;
}

/** Starts the merge gesture of a carry. */
export const createMergeGesture = (carried: MergeCarried): MergeGesture => {
  const {
    scroller,
    readCards,
    readInitiatives,
    sourceId,
    checkMerge,
    slot,
    body,
    home,
    grab,
    reduced,
  } = carried;
  /** The card chosen with its element, and what the check found so far. */
  let target: {
    readonly cardId: string;
    readonly element: HTMLElement;
    check: MergeCheckState;
  } | null = null;
  let isOptionHeld = carried.isOptionHeld;
  let isOver = false;
  let pointer = carried.pointer;
  /** The card whose middle the pointer is over, or `null`. A merge needs the pointer to rest there. */
  let hoverCardId: string | null = null;
  /** Where the pointer began to rest over `hoverCardId`. */
  let rest = carried.pointer;
  let dwellTimer: number | undefined;
  /** Until this time (`performance.now()`), a card that left its dock glides to the pointer. */
  let glideUntil = 0;

  /** Docks the card in the hand on the corner of the card it merges into, smaller and tilted. */
  const dock = (): void => {
    if (target === null) return;
    const place = measureLayoutRect(target.element);
    body.to(
      {
        x: place.left + DOCK_ACROSS - home.left,
        y: place.top + DOCK_DOWN - home.top,
        s: DOCK_SCALE,
        r: DOCK_TILT,
        l: DOCK_LIFT,
      },
      "hand",
      { reduced },
    );
  };

  /**
   * Draws the card in the hand into the card `cardId` for a merge, or undoes
   * it all at once when `cardId` is `null`: the card in the hand comes back
   * to the pointer, the target settles, and the slot opens again.
   */
  const setTarget = (cardId: string | null): void => {
    if (target?.cardId === cardId) return;
    if (target !== null) {
      unmarkMergeTarget(target.element);
      target = null;
      slot.classList.remove("is-shut");
      glideUntil = performance.now() + UNDOCK_GLIDE_MS;
      body.to(
        {
          x: pointer.x - grab.x - home.left,
          y: pointer.y - grab.y - home.top,
          s: CARRY_SCALE,
          l: 1,
        },
        "hand",
        { reduced },
      );
    }
    if (cardId === null) return;
    const element = scroller.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
    const card = readCards().find((each) => each.id === cardId);
    if (element === null || card === undefined) return;
    const chosen = { cardId, element, check: { kind: "checking" } as MergeCheckState };
    target = chosen;
    slot.classList.add("is-shut");
    const words = {
      title: card.title,
      keeps: describeMergeKeeps(
        card,
        readCards().find((each) => each.id === sourceId) ?? {},
        readInitiatives(),
      ),
    };
    markMergeTarget(element, { ...words, check: chosen.check });
    dock();
    // The answer counts only while this choice is the card chosen: a card left
    // or chosen again meanwhile makes it stale.
    void checkMerge(sourceId, cardId).then((result) => {
      if (target !== chosen || isOver) return;
      chosen.check = result;
      showMergeTargetWords(element, { ...words, check: result });
    });
  };

  return {
    update: (next, candidateId) => {
      if (isOver) return;
      // A copy: the caller may keep moving the object it passes.
      pointer = { x: next.x, y: next.y };
      const hasMoved = Math.hypot(pointer.x - rest.x, pointer.y - rest.y) > MERGE_STILL_DISTANCE;
      const isSameWish = candidateId === hoverCardId && !hasMoved;
      if (!isSameWish) {
        hoverCardId = candidateId;
        rest = pointer;
        window.clearTimeout(dwellTimer);
      }
      if (candidateId === null) {
        setTarget(null);
      } else if (target?.cardId === candidateId) {
        // Drifting inside the middle of the target keeps it.
      } else if (isOptionHeld) {
        setTarget(candidateId);
      } else if (!isSameWish) {
        setTarget(null);
        dwellTimer = window.setTimeout(() => {
          if (!isOver && hoverCardId === candidateId) setTarget(candidateId);
        }, MERGE_DWELL_MS);
      }
    },
    setOptionHeld: (isHeld) => {
      isOptionHeld = isHeld;
    },
    refresh: () => {
      if (isOver) return;
      if (target !== null && !target.element.isConnected) setTarget(null);
      dock();
    },
    handMotion: () => {
      if (target !== null) return "docked";
      return performance.now() < glideUntil ? "gliding" : "free";
    },
    commit: () => {
      isOver = true;
      window.clearTimeout(dwellTimer);
      return target === null
        ? null
        : { cardId: target.cardId, element: target.element, check: target.check };
    },
    cancel: () => {
      isOver = true;
      window.clearTimeout(dwellTimer);
      if (target !== null) unmarkMergeTarget(target.element);
      target = null;
    },
  };
};

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  buildDropMove,
  describeCardMove,
  describeCardsMove,
  describeMergeRefused,
  settleGroupDrop,
  type ArrangedLane,
  type CardInLane,
  type CardMove,
  type DropPlace,
  type MergeCheckResult,
  type WorkInitiative,
  type WorkProject,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import {
  ghostElement,
  HandTracker,
  isMotionReduced,
  measureLayoutRect,
  swallowNextClick,
  trackBody,
  trackCarryGesture,
  type LayoutRect,
  type SpringName,
} from "../../app/motion";
import {
  chooseDropPlace,
  computeEdgeScrollSpeed,
  findMergeCandidate,
  isSameDropPlace,
  toBoardPoint,
} from "./board-drag-geometry";
import { CARRY_SCALE, type Carry } from "./board-drag-carry";
import {
  FOLLOWER_LAND_GAP,
  liftFollowers,
  moveFollowers,
  readFollowerPose,
} from "./board-drag-followers";
import { createMergeGesture, type MergeChoice } from "./board-drag-merge";
import { waitForMergeCheck } from "./merge-target";
import { copyCardForMotion } from "../desk";
import { playMergeIn } from "./board-flights";
import { findCardElement, readCardInLane } from "./card-in-lane";
import { findCellRow, hideDraggedCard, showDraggedCard } from "./dragged-card";
import { flipBoard } from "./flip-board";
import { landCard, type ReleasePose } from "./land-card";
import { measureBoardGeometry } from "./measure-board-geometry";
import "./drag.css";

/** How far the pointer moves, in pixels, before a press becomes a carry. Up to this far is a click. */
const LIFT_DISTANCE = 5;

/** The most a carried card leans, in degrees, to either side. */
const MOST_LEAN = 1.2;

/** Degrees of lean for each pixel per millisecond of smoothed sideways speed. */
const LEAN_PER_SPEED = 0.9;

/** What `useBoardDrag` is given. */
export interface BoardDragOptions {
  /** The element that scrolls the board. It stays mounted for the life of the screen, so it holds the pointer. */
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  /**
   * The cards of the logical board, in stored order: the board as it is now.
   * The carry looks cards up in it, and a drop is checked against it. The
   * board the screen draws can differ from it during a carry, because changes
   * nobody caused wait for the hand to let go.
   */
  readonly cards: readonly WorkCard[];
  readonly projects: readonly WorkProject[];
  /**
   * The open Initiatives, which the board lists. A drop on a Project lane
   * takes a card off its Initiative only when the Initiative is in here,
   * because only then was the card drawn on it.
   */
  readonly initiatives: readonly WorkInitiative[];
  /** The lanes the board draws: which are folded, and which cards a cell hides. */
  readonly arrangedLanes: readonly ArrangedLane[];
  /**
   * The ids of the selected cards. Pressing one of them and carrying it
   * carries every selected card the board draws behind it.
   */
  readonly selectedIds: ReadonlySet<string>;
  /**
   * Moves a card and shows the move on the undo line, with `note` added to the
   * line when there is one. A move that changes nothing does nothing.
   */
  readonly moveCard: (move: CardMove, words: string, note?: string) => void;
  /**
   * Moves the cards of a drop of several as one gesture (see
   * `CardMoves.moveCards`). `describe` returns the words for the undo line
   * for the moves that remain.
   */
  readonly moveCards: (
    moves: readonly CardMove[],
    describe: (moves: readonly CardMove[]) => string,
    note?: string,
  ) => void;
  /** Shows `text` on the undo line, with no Undo, for a drop that sent nothing. */
  readonly say: (text: string) => void;
  /**
   * Merges the card `sourceCardId` into the card `targetCardId`: holds the
   * merge for the undo line and shows it done, so the source card leaves the
   * board. Called inside the drag's committed change (`flushSync`), so the
   * board is measured after it. Returns `false`, and holds nothing, when
   * either card is no longer on the board. `isChecked` is whether the merge
   * check allowed the merge; when it is `false` the undo line says the merge
   * could not be checked first.
   */
  readonly holdMerge: (sourceCardId: string, targetCardId: string, isChecked: boolean) => boolean;
  /**
   * Asks whether the card `sourceCardId` could be merged into the card
   * `targetCardId`, which the carry does when it chooses a card to merge
   * into. It never rejects: a question that could not be asked answers
   * `unchecked` (see `MergeCheckResult`).
   */
  readonly checkMerge: (sourceCardId: string, targetCardId: string) => Promise<MergeCheckResult>;
  /**
   * Called with `true` when a card enters the hand and with `false` when it
   * leaves it. The screen keeps the value and draws it as the desk's
   * `data-carrying` mark. The drag commits the change at once (`flushSync`),
   * and the one that ends a carry inside the drop's own flip, so whatever the
   * screen was holding back for the carry shows as part of the drop.
   */
  readonly onCarryingChange: (isCarrying: boolean) => void;
}

/** What a press picked up: the card pressed and the lane it stands in, and its element. */
interface Pressed {
  readonly card: CardInLane;
  readonly element: HTMLElement;
}

/**
 * What a drop sends: the moves, the card in the hand first and then the cards
 * behind it, the words for the undo line (`describe` is given the moves that
 * are sent) and the note that follows them, if any.
 */
interface DropChange {
  readonly moves: readonly CardMove[];
  readonly describe: (moves: readonly CardMove[]) => string;
  readonly note: string | undefined;
}

/** Returns the element after `element` that takes room in the layout, which is the next one not hidden because it is in the hand. */
const findNextShownSibling = (element: Element): Element | null => {
  let next = element.nextElementSibling;
  while (next instanceof HTMLElement && next.dataset["dragged"] !== undefined) {
    next = next.nextElementSibling;
  }
  return next;
};

/** Returns the line under the cards of `cell` ("13 more" or "3 landed"), or `null` when it has none. */
const findCellFoot = (cell: Element): HTMLElement | null =>
  [...cell.children].find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains("board-more"),
  ) ?? null;

/**
 * Handles the pointer on `scroller` for as long as it lives. Everything a
 * carry touches outside React (the copy in the hand, the slot, the marks) is
 * made, moved and removed here, so the hook only has to start it on mount and
 * stop it on unmount. Returns `destroy`, which stops listening and, if a card
 * is in the hand, puts the page back as it was.
 *
 * `readOptions` returns the newest options each time it is called.
 */
const createBoardDrag = (
  scroller: HTMLElement,
  readOptions: () => BoardDragOptions,
): { readonly destroy: () => void } => {
  /** The carry that was dropped on a card whose merge check has not answered yet, or `null`. */
  let waitingCarry: Carry | null = null;

  /**
   * Measures the board again after the page changed. `places` are the card
   * places a flip just measured, which spares measuring the cards twice.
   */
  const remeasure = (c: Carry, places?: ReadonlyMap<string, LayoutRect>): void => {
    const measured = measureBoardGeometry(scroller, readOptions().arrangedLanes, places);
    c.geometry = measured.geometry;
    c.view = measured.view;
  };

  /** Returns whether the slot is already in `cell`, right before `before`. */
  const isSlotAt = (c: Carry, cell: HTMLElement, before: Element | null): boolean =>
    c.slot.parentElement === cell && findNextShownSibling(c.slot) === before;

  /** Moves the slot to `cell`, before `before`, fades it in there, and lets everything below glide aside. */
  const moveSlot = (c: Carry, cell: HTMLElement, before: Element | null): void => {
    if (isSlotAt(c, cell, before)) return;
    const { places } = flipBoard(scroller, "hand", () => {
      c.slot.classList.add("is-new");
      cell.insertBefore(c.slot, before);
    });
    // The hidden slot is drawn once, so removing the class starts a fade from it.
    void c.slot.offsetHeight;
    c.slot.classList.remove("is-new");
    c.watcher.takeRecords();
    remeasure(c, places);
  };

  /** Takes the slot out of the page, for a pointer over a folded lane. */
  const removeSlot = (c: Carry): void => {
    if (c.slot.parentElement === null) return;
    const { places } = flipBoard(scroller, "hand", () => {
      c.slot.remove();
    });
    c.watcher.takeRecords();
    remeasure(c, places);
  };

  /** Marks the target of the carry on the page: the stage that answers, and the folded lane under the pointer. */
  const markPlace = (c: Carry, place: DropPlace): void => {
    const stage = place.stage;
    if (stage === null) delete c.root.dataset["dragStage"];
    else c.root.dataset["dragStage"] = stage;
    const lane =
      place.kind === "folded-lane"
        ? (c.geometry.lanes.find((each) => each.id === place.laneId)?.element ?? null)
        : null;
    if (lane === c.markedLane) return;
    if (c.markedLane !== null) delete c.markedLane.dataset["dropTarget"];
    if (lane !== null) lane.dataset["dropTarget"] = "";
    c.markedLane = lane;
  };

  /** Shows the carry at `place`: the slot opens there, or goes away over a folded lane. */
  const showPlace = (c: Carry, place: DropPlace): void => {
    c.place = place;
    markPlace(c, place);
    if (place.kind === "folded-lane") {
      removeSlot(c);
      return;
    }
    const cell = c.geometry.lanes.find((lane) => lane.id === place.laneId)?.cells.get(place.stage);
    if (cell === undefined) return;
    const before = cell.rows.find((row) => row.id === place.beforeCardId);
    moveSlot(c, cell.element, before?.element ?? findCellFoot(cell.element));
  };

  /**
   * Works out which place the pointer points at, from the measurements, and
   * shows it when it changed. Over the middle of a card, the place is the
   * one right after that card, and it is only opened when the slot is in
   * another cell: the card must stay under the pointer.
   */
  const choosePlace = (c: Carry): void => {
    const point = toBoardPoint(c.view, c.hand.x, c.hand.y);
    // A merge joins two cards, so several cards in the hand never merge.
    const candidate =
      c.followers.length > 0 ? null : findMergeCandidate(c.geometry, point.x, point.y);
    if (candidate === null) {
      c.merge.update(c.hand, null);
      const place = chooseDropPlace(c.geometry, point.x, point.y);
      if (place !== null && !isSameDropPlace(place, c.place)) showPlace(c, place);
      return;
    }
    const { place } = candidate;
    const isSlotInCell =
      c.place?.kind === "cell" &&
      place.kind === "cell" &&
      c.place.laneId === place.laneId &&
      c.place.stage === place.stage;
    if (!isSlotInCell) showPlace(c, place);
    c.merge.update(c.hand, candidate.cardId);
  };

  /** Scrolls the board for as long as the card is held near its top or bottom edge. */
  const scrollAtEdge = (c: Carry): void => {
    if (c.scrollFrame !== 0) return;
    const step = (): void => {
      c.scrollFrame = 0;
      if (gesture.readCarry() !== c) return;
      const speed = computeEdgeScrollSpeed(c.hand.y, c.view.top, c.view.bottom);
      if (speed === 0) return;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + speed;
      if (scroller.scrollTop === before) return;
      c.scrollFrame = requestAnimationFrame(step);
    };
    if (computeEdgeScrollSpeed(c.hand.y, c.view.top, c.view.bottom) === 0) return;
    c.scrollFrame = requestAnimationFrame(step);
  };

  /** Follows the pointer: the copy goes under it one to one, leans with the hand's speed, and the slot goes where it points. */
  const followHand = (c: Carry, x: number, y: number): void => {
    const { hand } = c;
    hand.moveTo(x, y);
    // Drawn into a card, the card in the hand stays docked until the pointer
    // leaves the card. It is docked when the card is chosen, and again when the
    // card moves (`onScroll`, `onPageChanged`), not when the pointer does.
    const handMotion = c.merge.handMotion();
    if (handMotion !== "docked") {
      if (handMotion === "gliding") {
        c.body.to({ x: x - c.grab.x - c.home.left, y: y - c.grab.y - c.home.top }, "hand", {
          reduced: c.reduced,
        });
      } else {
        c.body.follow(x - c.grab.x - c.home.left, y - c.grab.y - c.home.top);
      }
    }
    if (!c.reduced && handMotion !== "docked") {
      gesture.leanWithHand(c.body, hand, () => c.merge.handMotion() !== "docked");
    }
    moveFollowers(c);
    choosePlace(c);
    scrollAtEdge(c);
  };

  /** Reads how the copy looks now, and how fast the hand moves, for the landing to start from. */
  const readReleasePose = (c: Carry): ReleasePose => {
    const shown = c.body.values;
    return {
      centerX: c.home.left + c.home.width / 2 + shown.x,
      centerY: c.home.top + c.home.height / 2 + shown.y,
      scale: shown.s,
      tilt: shown.r,
      lift: shown.l,
      velocity: c.hand.readThrow(),
    };
  };

  /** Stops watching the page and the edge scroll. The copy, the slot and the carrying value are left to the caller. */
  const endCarry = (c: Carry): void => {
    cancelAnimationFrame(c.scrollFrame);
    c.watcher.disconnect();
    scroller.removeEventListener("scroll", onScroll);
  };

  /** Takes the marks of a carry off the page. */
  const clearMarks = (c: Carry): void => {
    c.merge.cancel();
    delete c.root.dataset["dragStage"];
    if (c.markedLane !== null) delete c.markedLane.dataset["dropTarget"];
  };

  /** Shows the card of a follower again, once it has left the hand. */
  const showFollower = (cardId: string): void => {
    const element = scroller.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
    if (element !== null) showDraggedCard(element);
  };

  /** Ends a carry at once, with no motion, and puts the page as it was. Used when the screen goes away. */
  const abandonCarry = (c: Carry): void => {
    endCarry(c);
    readOptions().onCarryingChange(false);
    c.slot.remove();
    showDraggedCard(c.source);
    for (const follower of c.followers) {
      showFollower(follower.card.id);
      follower.body.clear();
    }
    clearMarks(c);
    c.body.clear();
    c.layer.remove();
  };

  /**
   * Puts the card on the page at the place of `change`, or back where it was when
   * there is none, and lets it come down from where it looks now. The card
   * leaves the hand, and the moves are sent, in one committed change, so the
   * board is measured after both. The cards behind it come down after it, each
   * 40ms after the one before, at their places or at home.
   */
  const releaseCarry = (c: Carry, spring: SpringName, change: DropChange | undefined): void => {
    const pose = readReleasePose(c);
    const followerPoses = c.followers.map(readFollowerPose);
    endCarry(c);
    flipBoard(scroller, spring, () => {
      c.slot.remove();
      showDraggedCard(c.source);
      for (const follower of c.followers) {
        showFollower(follower.card.id);
      }
      clearMarks(c);
      flushSync(() => {
        const options = readOptions();
        options.onCarryingChange(false);
        if (change === undefined) return;
        if (c.followers.length === 0) {
          options.moveCard(change.moves[0]!, change.describe(change.moves), change.note);
        } else {
          options.moveCards(change.moves, change.describe, change.note);
        }
      });
    });
    landCard(scroller, c, pose, spring, change?.moves[0], 0);
    c.followers.forEach((follower, index) => {
      landCard(
        scroller,
        { ...follower, layer: c.layer, place: c.place },
        followerPoses[index]!,
        spring,
        change?.moves.find((move) => move.taskId === follower.card.id),
        (index + 1) * FOLLOWER_LAND_GAP,
      );
    });
  };

  /** Ends the drop over the card `targetCardId` once its merge check is known (`check` is never `checking`). */
  const finishMergeCarry = (c: Carry, targetCardId: string, check: MergeCheckResult): void => {
    const pose = readReleasePose(c);
    endCarry(c);
    const options = readOptions();
    // A merge the controller said it would refuse is not sent: the card goes home.
    const refusal = check.kind === "refused" ? check.refusal : undefined;
    let isHeld = false;
    flipBoard(scroller, "hand", () => {
      c.slot.remove();
      showDraggedCard(c.source);
      clearMarks(c);
      flushSync(() => {
        options.onCarryingChange(false);
        if (refusal === undefined) {
          isHeld = options.holdMerge(c.card.id, targetCardId, check.kind === "allowed");
        }
      });
    });
    if (isHeld) {
      playMergeIn(scroller, c.ghost, targetCardId);
      return;
    }
    landCard(scroller, c, pose, "travel", undefined, 0);
    options.say(
      refusal === undefined
        ? "A card left the board, so nothing was merged."
        : describeMergeRefused(c.card.title, refusal),
    );
  };

  /**
   * Lets go of the card over the card it is drawn into. The merge is held for
   * the undo line, and the copy in the hand slides in under the card it
   * merged into and fades. When either card has left the board meanwhile,
   * nothing is merged: the card goes home and the undo line says so.
   *
   * A check that has not answered is waited for, with the copy still docked
   * on the target: the card is never shown as merged before the controller
   * allowed it. A refusal sends the card home; an answer that does not come
   * in time lets the merge go ahead unchecked, and the controller's merge decides.
   */
  const mergeCarry = (c: Carry, target: MergeChoice): void => {
    swallowNextClick(true);
    if (target.check.kind !== "checking") {
      finishMergeCarry(c, target.cardId, target.check);
      return;
    }
    waitingCarry = c;
    void waitForMergeCheck(target.result).then((check) => {
      if (waitingCarry !== c) return;
      waitingCarry = null;
      finishMergeCarry(c, target.cardId, check);
    });
  };

  /**
   * Lets go of the card where the slot is, and sends the move. The move is
   * built from the board the carry showed, then checked against the board as it
   * is now (`settleDropMove`): when the card it follows has gone it lands last
   * in its cell and the undo line says so, and when the Task or the Project is
   * gone nothing is sent and the line says why.
   */
  const dropCard = (c: Carry): void => {
    const target = c.merge.commit();
    if (target !== null) {
      mergeCarry(c, target);
      return;
    }
    swallowNextClick(true);
    const options = readOptions();
    const { place } = c;
    const lane = options.arrangedLanes.find((each) => each.lane.id === place?.laneId);
    if (place === null || lane === undefined) {
      releaseCarry(c, "travel", undefined);
      return;
    }
    const followers = c.followers.map((follower) => follower.card);
    const drop = buildDropMove({
      movingCard: c.card,
      lane,
      stage: place.stage,
      beforeCardId: place.kind === "cell" ? place.beforeCardId : null,
      followerIds: followers.map((card) => card.id),
      listedInitiativeIds: new Set(options.initiatives.map((initiative) => initiative.id)),
    });
    const settled = settleGroupDrop({ cards: options.cards }, options.projects, drop, followers);
    if (settled.kind === "refuse") {
      releaseCarry(c, "travel", undefined);
      options.say(settled.reason);
      return;
    }
    // The words name the cards as they stood before the move, which is how the board is now.
    const describe = (moves: readonly CardMove[]): string => {
      const [only] = moves;
      const card =
        only === undefined
          ? undefined
          : (options.cards.find((each) => each.id === only.taskId) ??
            [c.card, ...followers].find((each) => each.id === only.taskId));
      return only !== undefined && moves.length === 1 && card !== undefined
        ? describeCardMove(card, only, options.projects, options.initiatives)
        : describeCardsMove(
            moves,
            place.stage ?? c.card.stage,
            options.projects,
            options.initiatives,
          );
    };
    releaseCarry(c, "hand", { moves: settled.moves, describe, note: settled.note });
  };

  /**
   * Sends the card home: Esc, a cancelled pointer, a lost pointer, a hidden
   * window, or a page change that took its place away. `isPointerUp` is
   * whether the pointer's button is already up.
   */
  const cancelCarry = (c: Carry, isPointerUp: boolean): void => {
    swallowNextClick(isPointerUp);
    releaseCarry(c, "travel", undefined);
  };

  /**
   * Lifts the pressed card into the hand: the card is copied into the carry
   * layer, and its place in the page becomes a slot. Returns `null` when the
   * card, its cell or the desk is not on the page.
   */
  const liftCard = (held: Pressed, event: PointerEvent): Carry | null => {
    const root = scroller.closest<HTMLElement>(".work-desk");
    const source = held.element.isConnected ? held.element : findCardElement(scroller, held.card);
    const cell = source?.closest<HTMLElement>(".board-cell") ?? null;
    const options = readOptions();
    const card = options.cards.find((each) => each.id === held.card.cardId);
    if (root === null || source === null || cell === null || card === undefined) return null;
    flushSync(() => {
      options.onCarryingChange(true);
    });

    // The press dents the card. The copy must be the card's full size.
    source.style.setProperty("scale", "1");
    const home = measureLayoutRect(source);
    const seen = source.getBoundingClientRect();
    const layer = document.createElement("div");
    layer.className = "board-carry";
    layer.setAttribute("aria-hidden", "true");
    root.appendChild(layer);
    const ghost = ghostElement(source, layer, copyCardForMotion(source));
    source.style.removeProperty("scale");
    ghost.classList.add("is-carried");

    const slot = document.createElement("div");
    slot.className = "board-slot";
    slot.setAttribute("aria-hidden", "true");
    slot.style.height = `${String(home.height)}px`;
    // A card in a stack leaves its slot where the stack stands, so only that one card is in the hand.
    cell.insertBefore(slot, findCellRow(source));
    hideDraggedCard(source);
    const followers = liftFollowers(scroller, layer, card, options);
    if (followers.length > 0) {
      // A count on the card in the hand: itself and the cards behind it.
      ghost.classList.add("has-followers");
      ghost.dataset["count"] = String(followers.length + 1);
    }

    const body = trackBody(ghost);
    const reduced = isMotionReduced();
    body.to({ s: CARRY_SCALE, l: 1 }, "hand", { reduced });

    const watcher = new MutationObserver(onPageChanged);
    watcher.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });

    const measured = measureBoardGeometry(scroller, options.arrangedLanes);
    const grab = { x: event.clientX - seen.left, y: event.clientY - seen.top };
    return {
      card,
      laneId: held.card.laneId,
      source,
      root,
      layer,
      ghost,
      body,
      followers,
      slot,
      home,
      grab,
      reduced,
      watcher,
      hand: new HandTracker(event.clientX, event.clientY),
      geometry: measured.geometry,
      view: measured.view,
      place: null,
      scrollFrame: 0,
      markedLane: null,
      merge: createMergeGesture({
        scroller,
        readCards: () => readOptions().cards,
        readInitiatives: () => readOptions().initiatives,
        sourceId: card.id,
        checkMerge: (sourceId, targetId) => readOptions().checkMerge(sourceId, targetId),
        slot,
        body,
        home,
        grab,
        reduced,
        pointer: { x: event.clientX, y: event.clientY },
        isOptionHeld: event.altKey,
      }),
    };
  };

  // ---------- Handlers for the page, the pointer and the keys ----------

  /**
   * Runs when the page's elements changed during a carry, which is a live
   * push: a card or a lane came or went. When the card in the hand, or the
   * place its slot is in, is gone, the carry is cancelled and the card goes
   * home. Otherwise the board is measured again.
   */
  function onPageChanged(): void {
    const c = gesture.readCarry();
    if (c === null) return;
    if (!c.source.isConnected || !c.slot.isConnected) {
      gesture.cancel(false);
      return;
    }
    remeasure(c);
    c.merge.refresh();
  }

  /**
   * Runs when the board scrolls under a carried card, by the wheel or at an
   * edge. The card stays in the hand. The measurements are in board
   * coordinates, so only the pointer's place on the board changes, and the
   * page is not read.
   */
  function onScroll(): void {
    const c = gesture.readCarry();
    if (c === null) return;
    c.view = { ...c.view, scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop };
    choosePlace(c);
    c.merge.refresh();
  }

  const gesture = trackCarryGesture<Pressed, Carry>({
    element: scroller,
    liftDistance: LIFT_DISTANCE,
    lean: { perSpeed: LEAN_PER_SPEED, most: MOST_LEAN },
    readPressed: (event) => {
      const element =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-card-id]")
          : null;
      const card = element === null ? null : readCardInLane(element);
      return element === null || card === null ? null : { card, element };
    },
    lift: liftCard,
    move: (c, event) => {
      c.merge.setOptionHeld(event.altKey);
      followHand(c, event.clientX, event.clientY);
    },
    drop: dropCard,
    cancel: cancelCarry,
    // Option chooses the card under the pointer to merge into at once. A card
    // already chosen stays chosen after Option is let go, until the pointer leaves it.
    onKey: (c, event) => {
      if (event.key !== "Alt") return;
      c.merge.setOptionHeld(event.type === "keydown");
      if (event.type === "keydown") choosePlace(c);
    },
  });

  return {
    destroy: () => {
      const held = gesture.destroy();
      if (held !== null) abandonCarry(held);
      if (waitingCarry !== null) abandonCarry(waitingCarry);
      waitingCarry = null;
    },
  };
};

/**
 * Lets the user carry a card of the Work board with the pointer. A press that
 * moves 5px or less is a click and opens the card as before. Past that, the
 * card lifts into a layer of its own and follows the pointer, a hollow slot
 * opens where it would land, and on release `moveCard` is called once with
 * the target stage, the lane's Project and the card to follow.
 *
 * - The pointer is held by the board's scroll element, which never goes away,
 *   because a card can be replaced by React in the middle of a carry. The
 *   carried thing is a copy of the card; the card itself stays mounted and
 *   hidden, so nothing unmounts.
 * - Esc, a cancelled or lost pointer, a hidden window, and a live push that
 *   removes the card or the place it was going to cancel the carry, and the
 *   card goes home.
 * - A drop is built from the board the carry showed, and checked against the
 *   board as it is now. If the card it follows has left, the card lands last
 *   in its cell and the undo line says so. If the Task or the Project has
 *   left, nothing is sent and the line says why.
 * - A folded lane is a target as a whole, since it has no cells to put a slot
 *   in. A slot after the last card of a cell that hides some lands before the
 *   first hidden card.
 * - Held still for a second over the middle 40% of another card, or with
 *   Option held, the carry is drawn into that card to merge: the card in the
 *   hand docks on its corner, and the target takes a ring and two labels
 *   (whom it is merged into, and what stays). Moving more than 6px starts
 *   the wait again, and moving off the middle undoes it at once. Letting go
 *   calls `holdMerge`, and the copy slides in under the target.
 * - The page is scrolled at the top and bottom edges. The board is measured
 *   when a carry starts and when the page or the slot changes, never when the
 *   pointer moves or the board scrolls.
 *
 * Whether a card is in the hand is told to the screen through
 * `onCarryingChange`, which keeps the value.
 */
export function useBoardDrag(options: BoardDragOptions): void {
  const latest = useRef(options);
  // A layout effect, so the options match the page when the observer of the
  // page's changes measures it.
  useLayoutEffect(() => {
    latest.current = options;
  });
  const { scrollRef } = options;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    return createBoardDrag(scroller, () => latest.current).destroy;
  }, [scrollRef]);
}

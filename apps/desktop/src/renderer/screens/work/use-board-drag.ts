import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  buildDropMove,
  describeCardMove,
  settleDropMove,
  type ArrangedLane,
  type CardInLane,
  type CardMove,
  type DropPlace,
  type WorkProject,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import {
  ghostElement,
  isMotionReduced,
  measureLayoutRect,
  trackBody,
  type LayoutRect,
  type MotionBody,
  type SpringName,
} from "../../app/motion";
import {
  chooseDropPlace,
  computeEdgeScrollSpeed,
  isSameDropPlace,
  toBoardPoint,
  type BoardGeometry,
  type BoardView,
} from "./board-drag-geometry";
import { findCardElement, readCardInLane } from "./card-in-lane";
import { flipBoard } from "./flip-board";
import { landCard, type ReleasePose } from "./land-card";
import { measureBoardGeometry } from "./measure-board-geometry";
import "./drag.css";

/** How far the pointer moves, in pixels, before a press becomes a carry. Less than this is a click. */
const LIFT_DISTANCE = 5;

/** How much bigger a card is in the hand. */
const CARRY_SCALE = 1.03;

/** The most a carried card leans, in degrees, to either side. */
const MOST_LEAN = 1.2;

/** Degrees of lean for each pixel per millisecond of smoothed sideways speed. */
const LEAN_PER_SPEED = 0.9;

/** How much of the old smoothed speed is kept at each pointer move: a shaky hand does not make the card shiver. */
const SPEED_KEPT = 0.7;

/** The shortest time one pointer move is taken to last, in milliseconds, so a burst of events gives no huge speed. */
const SHORTEST_MOVE_MS = 8;

/** How long the pointer must be still, in milliseconds, before the card stands straight and the hand has no speed. */
const STILL_AFTER_MS = 60;

/** The fastest a hand is taken to throw a card, in pixels a second, so a flick does not fling the landing across the page. */
const FASTEST_THROW = 2500;

/** How long, in milliseconds, a click right after a carry is swallowed. */
const CLICK_GUARD_MS = 50;

/** What `useBoardDrag` is given. */
export interface BoardDragOptions {
  /** The element that scrolls the board. It stays mounted for the life of the screen, so it holds the pointer. */
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  /** The cards the board draws, in stored order, with the pending moves applied. */
  readonly cards: readonly WorkCard[];
  /**
   * Every card of the board as it is now. During a carry the screen holds
   * back changes nobody caused, so this can differ from `cards`: a drop is
   * checked against it.
   */
  readonly currentCards: readonly WorkCard[];
  readonly projects: readonly WorkProject[];
  /** The lanes the board draws: which are folded, and which cards a cell hides. */
  readonly arrangedLanes: readonly ArrangedLane[];
  /**
   * Moves a card and shows the move on the undo line, with `note` added to the
   * line when there is one. A move that changes nothing does nothing.
   */
  readonly moveCard: (move: CardMove, words: string, note?: string) => void;
  /** Shows `text` on the undo line, with no Undo, for a drop that sent nothing. */
  readonly say: (text: string) => void;
  /**
   * Called with `true` when a card enters the hand and with `false` when it
   * leaves it. The screen keeps the value and draws it as the desk's
   * `data-carrying` mark. The drag commits the change at once (`flushSync`),
   * and the one that ends a carry inside the drop's own flip, so whatever the
   * screen was holding back for the carry shows as part of the drop.
   */
  readonly onCarryingChange: (isCarrying: boolean) => void;
}

/** The pointer's last place, and how fast it moves (pixels per millisecond, smoothed). */
interface Hand {
  x: number;
  y: number;
  vx: number;
  vy: number;
  movedAt: number;
}

/** A press on a card that has not moved far enough to be a carry. */
interface Press {
  readonly pointerId: number;
  /** The card pressed, and the lane it stands in. */
  readonly pressed: CardInLane;
  readonly element: HTMLElement;
  readonly startX: number;
  readonly startY: number;
}

/** A card in the hand. */
interface Carry {
  readonly pointerId: number;
  readonly card: WorkCard;
  /** The id of the lane the card was lifted from. */
  readonly laneId: string;
  /** The card's element in the page. It stays mounted and hidden for the whole carry. */
  readonly source: HTMLElement;
  readonly root: HTMLElement;
  readonly layer: HTMLElement;
  /** The copy of the card in the hand, the only child of `layer`. */
  readonly ghost: HTMLElement;
  readonly body: MotionBody;
  /** The hollow that shows where the card would land. It lives in the cell, outside React's reach. */
  readonly slot: HTMLElement;
  /** Where the layout puts the copy in the hand, in window pixels. */
  readonly home: LayoutRect;
  /** Where in the card the pointer took hold of it. */
  readonly grab: { readonly x: number; readonly y: number };
  readonly reduced: boolean;
  readonly watcher: MutationObserver;
  readonly hand: Hand;
  geometry: BoardGeometry;
  /** The scroller in the window, and how far it is scrolled. */
  view: BoardView;
  place: DropPlace | null;
  uprightTimer: number | undefined;
  scrollFrame: number;
  /** The folded lane that is marked as the target, if one is. */
  markedLane: HTMLElement | null;
}

/** What a drop sends, with the words for the undo line and the note that follows them, if any. */
interface DropChange {
  readonly move: CardMove;
  readonly words: string;
  readonly note: string | undefined;
}

/** Returns `value` limited to the range from `-limit` to `limit`. */
const limitSymmetric = (value: number, limit: number): number =>
  Math.max(-limit, Math.min(limit, value));

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
 * Swallows the click that follows a carry, which would otherwise open the card
 * that was dropped. `isPointerUp` is whether the button is already up. When
 * it is not (Esc was pressed with the button held), the click comes when the
 * user lets go, so the guard waits for that. A new press ends the guard, so a
 * release that never arrives cannot swallow a later click.
 */
const swallowNextClick = (isPointerUp: boolean): void => {
  let timer: number | undefined;
  const stop = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
    clear();
  };
  const startTimer = (): void => {
    timer = window.setTimeout(clear, CLICK_GUARD_MS);
  };
  function clear(): void {
    window.removeEventListener("click", stop, true);
    window.removeEventListener("pointerup", startTimer, true);
    window.removeEventListener("pointerdown", clear, true);
    window.clearTimeout(timer);
  }
  window.addEventListener("click", stop, true);
  window.addEventListener("pointerdown", clear, true);
  if (isPointerUp) startTimer();
  else window.addEventListener("pointerup", startTimer, { capture: true, once: true });
};

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
  let press: Press | null = null;
  let carry: Carry | null = null;

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

  /** Works out which place the pointer points at, from the measurements, and shows it when it changed. */
  const choosePlace = (c: Carry): void => {
    const point = toBoardPoint(c.view, c.hand.x, c.hand.y);
    const place = chooseDropPlace(c.geometry, point.x, point.y);
    if (place !== null && !isSameDropPlace(place, c.place)) showPlace(c, place);
  };

  /** Scrolls the board for as long as the card is held near its top or bottom edge. */
  const scrollAtEdge = (c: Carry): void => {
    if (c.scrollFrame !== 0) return;
    const step = (): void => {
      c.scrollFrame = 0;
      if (carry !== c) return;
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
    const now = performance.now();
    const elapsed = Math.max(SHORTEST_MOVE_MS, now - c.hand.movedAt);
    const { hand } = c;
    hand.vx = hand.vx * SPEED_KEPT + ((x - hand.x) / elapsed) * (1 - SPEED_KEPT);
    hand.vy = hand.vy * SPEED_KEPT + ((y - hand.y) / elapsed) * (1 - SPEED_KEPT);
    hand.x = x;
    hand.y = y;
    hand.movedAt = now;
    c.body.follow(x - c.grab.x - c.home.left, y - c.grab.y - c.home.top);
    if (!c.reduced) {
      c.body.to({ r: limitSymmetric(hand.vx * LEAN_PER_SPEED, MOST_LEAN) }, "hand", {
        reduced: false,
      });
      window.clearTimeout(c.uprightTimer);
      c.uprightTimer = window.setTimeout(() => {
        c.body.to({ r: 0 }, "hand", { reduced: false });
      }, STILL_AFTER_MS);
    }
    choosePlace(c);
    scrollAtEdge(c);
  };

  /** Reads how the copy looks now, and how fast the hand moves, for the landing to start from. */
  const readReleasePose = (c: Carry): ReleasePose => {
    const shown = c.body.values;
    const isStill = performance.now() - c.hand.movedAt > STILL_AFTER_MS;
    const toPixelsASecond = (speed: number): number =>
      isStill ? 0 : limitSymmetric(speed * 1000, FASTEST_THROW);
    return {
      centerX: c.home.left + c.home.width / 2 + shown.x,
      centerY: c.home.top + c.home.height / 2 + shown.y,
      scale: shown.s,
      tilt: shown.r,
      lift: shown.l,
      velocity: { x: toPixelsASecond(c.hand.vx), y: toPixelsASecond(c.hand.vy) },
    };
  };

  /** Stops watching the pointer, the page and the keys, and lets the pointer go. The copy, the slot and the carrying value are left to the caller. */
  const endCarry = (c: Carry): void => {
    carry = null;
    window.clearTimeout(c.uprightTimer);
    cancelAnimationFrame(c.scrollFrame);
    c.watcher.disconnect();
    scroller.removeEventListener("lostpointercapture", onLostCapture);
    scroller.removeEventListener("scroll", onScroll);
    if (scroller.hasPointerCapture(c.pointerId)) scroller.releasePointerCapture(c.pointerId);
    stopListening();
  };

  /** Takes the marks of a carry off the page. */
  const clearMarks = (c: Carry): void => {
    delete c.root.dataset["dragStage"];
    if (c.markedLane !== null) delete c.markedLane.dataset["dropTarget"];
  };

  /** Ends a carry at once, with no motion, and puts the page as it was. Used when the screen goes away. */
  const abandonCarry = (c: Carry): void => {
    endCarry(c);
    readOptions().onCarryingChange(false);
    c.slot.remove();
    delete c.source.dataset["dragged"];
    clearMarks(c);
    c.body.clear();
    c.layer.remove();
  };

  /**
   * Puts the card on the page at the place of `change`, or back where it was when
   * there is none, and lets it come down from where it looks now. The card
   * leaves the hand, and the move is sent, in one committed change, so the
   * board is measured after both.
   */
  const releaseCarry = (c: Carry, spring: SpringName, change: DropChange | undefined): void => {
    const pose = readReleasePose(c);
    endCarry(c);
    flipBoard(scroller, spring, () => {
      c.slot.remove();
      delete c.source.dataset["dragged"];
      clearMarks(c);
      flushSync(() => {
        const options = readOptions();
        options.onCarryingChange(false);
        if (change !== undefined) options.moveCard(change.move, change.words, change.note);
      });
    });
    landCard(scroller, c, pose, spring, change?.move);
  };

  /**
   * Lets go of the card where the slot is, and sends the move. The move is
   * built from the board the carry showed, then checked against the board as it
   * is now (`settleDropMove`): when the card it follows has gone it lands last
   * in its cell and the undo line says so, and when the Task or the Project is
   * gone nothing is sent and the line says why.
   */
  const dropCard = (c: Carry): void => {
    swallowNextClick(true);
    const options = readOptions();
    const { place } = c;
    const lane = options.arrangedLanes.find((each) => each.lane.id === place?.laneId);
    if (place === null || lane === undefined) {
      releaseCarry(c, "travel", undefined);
      return;
    }
    const drop = buildDropMove({
      movingCard: c.card,
      lane,
      stage: place.stage,
      beforeCardId: place.kind === "cell" ? place.beforeCardId : null,
    });
    const settled = settleDropMove({ cards: options.currentCards }, options.projects, drop);
    if (settled.kind === "refuse") {
      releaseCarry(c, "travel", undefined);
      options.say(settled.reason);
      return;
    }
    const card = options.currentCards.find((each) => each.id === c.card.id) ?? c.card;
    releaseCarry(c, "hand", {
      move: settled.move,
      words: describeCardMove(card, settled.move, options.projects),
      note: settled.note,
    });
  };

  /**
   * Sends the card home: Esc, a cancelled pointer, a lost pointer, a hidden
   * window, or a page change that took its place away. `isPointerUp` is
   * whether the pointer's button is already up.
   */
  const cancelCarry = (isPointerUp: boolean): void => {
    if (carry === null) return;
    swallowNextClick(isPointerUp);
    releaseCarry(carry, "travel", undefined);
  };

  /** Lifts the pressed card into the hand: the card is copied into the carry layer, and its place in the page becomes a slot. */
  const liftCard = (event: PointerEvent): void => {
    const held = press;
    press = null;
    if (held === null) return;
    const root = scroller.closest<HTMLElement>(".work-desk");
    const source = held.element.isConnected
      ? held.element
      : findCardElement(scroller, held.pressed);
    const cell = source?.closest<HTMLElement>(".board-cell") ?? null;
    const options = readOptions();
    const card = options.cards.find((each) => each.id === held.pressed.cardId);
    if (root === null || source === null || cell === null || card === undefined) {
      stopListening();
      return;
    }
    try {
      scroller.setPointerCapture(held.pointerId);
    } catch {
      // The pointer was let go before the lift, so there is nothing to carry.
      stopListening();
      return;
    }
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
    const ghost = ghostElement(source, layer);
    source.style.removeProperty("scale");
    ghost.style.removeProperty("scale");
    for (const name of ["data-card-id", "role", "aria-label", "tabindex"]) {
      ghost.removeAttribute(name);
    }
    ghost.classList.add("is-carried");

    const slot = document.createElement("div");
    slot.className = "board-slot";
    slot.setAttribute("aria-hidden", "true");
    slot.style.height = `${String(home.height)}px`;
    cell.insertBefore(slot, source);
    source.dataset["dragged"] = "";

    const body = trackBody(ghost);
    const reduced = isMotionReduced();
    body.to({ s: CARRY_SCALE, l: 1 }, "hand", { reduced });

    const watcher = new MutationObserver(onPageChanged);
    watcher.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener("lostpointercapture", onLostCapture);
    scroller.addEventListener("scroll", onScroll, { passive: true });

    const measured = measureBoardGeometry(scroller, options.arrangedLanes);
    const c: Carry = {
      pointerId: held.pointerId,
      card,
      laneId: held.pressed.laneId,
      source,
      root,
      layer,
      ghost,
      body,
      slot,
      home,
      grab: { x: event.clientX - seen.left, y: event.clientY - seen.top },
      reduced,
      watcher,
      hand: { x: event.clientX, y: event.clientY, vx: 0, vy: 0, movedAt: performance.now() },
      geometry: measured.geometry,
      view: measured.view,
      place: null,
      uprightTimer: undefined,
      scrollFrame: 0,
      markedLane: null,
    };
    carry = c;
    followHand(c, event.clientX, event.clientY);
  };

  // ---------- Handlers for the page, the pointer and the keys ----------

  /**
   * Runs when the page's elements changed during a carry, which is a live
   * push: a card or a lane came or went. When the card in the hand, or the
   * place its slot is in, is gone, the carry is cancelled and the card goes
   * home. Otherwise the board is measured again.
   */
  function onPageChanged(): void {
    const c = carry;
    if (c === null) return;
    if (!c.source.isConnected || !c.slot.isConnected) {
      cancelCarry(false);
      return;
    }
    remeasure(c);
  }

  /**
   * Runs when the board scrolls under a carried card, by the wheel or at an
   * edge. The card stays in the hand. The measurements are in board
   * coordinates, so only the pointer's place on the board changes, and the
   * page is not read.
   */
  function onScroll(): void {
    const c = carry;
    if (c === null) return;
    c.view = { ...c.view, scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop };
    choosePlace(c);
  }

  /** Runs when the system took the pointer away from the board other than by letting it go. */
  function onLostCapture(event: PointerEvent): void {
    if (carry !== null && event.pointerId === carry.pointerId) cancelCarry(true);
  }

  function onPointerMove(event: PointerEvent): void {
    if (carry !== null) {
      if (event.pointerId === carry.pointerId) followHand(carry, event.clientX, event.clientY);
      return;
    }
    if (press === null || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) < LIFT_DISTANCE) {
      return;
    }
    liftCard(event);
  }

  function onPointerUp(event: PointerEvent): void {
    if (carry !== null) {
      if (event.pointerId === carry.pointerId) dropCard(carry);
      return;
    }
    if (press !== null && event.pointerId === press.pointerId) {
      press = null;
      stopListening();
    }
  }

  function onPointerCancel(event: PointerEvent): void {
    if (carry !== null) {
      if (event.pointerId === carry.pointerId) cancelCarry(true);
      return;
    }
    if (press !== null && event.pointerId === press.pointerId) {
      press = null;
      stopListening();
    }
  }

  /** Sends the card home on Esc while a card is in the hand, and keeps the key from reaching anything else. No other key is handled. */
  function onKeyDown(event: KeyboardEvent): void {
    if (carry === null || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelCarry(false);
  }

  /** Sends the card home when the window loses the focus: the pointer's release may never arrive. */
  function onWindowAway(): void {
    if (carry !== null) cancelCarry(true);
  }

  /** Sends the card home when the window is hidden. */
  function onVisibilityChange(): void {
    if (document.hidden) onWindowAway();
  }

  function startListening(): void {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onWindowAway);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  function stopListening(): void {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onWindowAway);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  /** Starts a press when the primary button goes down on a card. Below `LIFT_DISTANCE` of movement it stays a click. */
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary || carry !== null || press !== null) return;
    const element =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-card-id]") : null;
    const pressed = element === null ? null : readCardInLane(element);
    if (element === null || pressed === null) return;
    press = {
      pointerId: event.pointerId,
      pressed,
      element,
      startX: event.clientX,
      startY: event.clientY,
    };
    startListening();
  };

  scroller.addEventListener("pointerdown", onPointerDown);

  return {
    destroy: () => {
      scroller.removeEventListener("pointerdown", onPointerDown);
      press = null;
      if (carry === null) stopListening();
      else abandonCarry(carry);
    },
  };
};

/**
 * Lets the user carry a card of the Work board with the pointer. A press that
 * moves less than 5px is a click and opens the card as before. Past that, the
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

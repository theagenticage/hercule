import { useCallback, useEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { describeCardMove } from "./describe-card-move";
import type { CardMove, WorkProject } from "@hercule/client-core/work";
import { BOARD_STAGES, type BoardStage, type WorkCard } from "@hercule/contract";
import {
  flipByKey,
  ghostElement,
  isMotionReduced,
  measureLayoutRect,
  trackBody,
  type MotionBody,
  type SpringName,
  type Velocity,
} from "../../app/motion";
import type { ArrangedLane } from "./arrange-lanes";
import {
  chooseDropPlace,
  computeEdgeScrollSpeed,
  isSameDropPlace,
  type BoardGeometry,
  type CellBox,
  type DropPlace,
  type LaneBox,
  type StageColumn,
} from "./board-drag-geometry";
import { buildDropMove } from "./board-drop";
import { buildCellId } from "./use-work-view";
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

/** How long the thin ring on a card that landed in Landed stays on it, in milliseconds. A little longer than the ring's fade. */
const LANDED_RING_MS = 600;

/** How long the roll of a stage's changed count stays marked, in milliseconds. A little longer than the roll. */
const COUNT_ROLL_MS = 260;

/** What moves when the page changes around a carried card: cards, lane heads, folded rows and the "13 more" lines. */
const FLIP_SELECTOR = "[data-card-id], [data-lane-head], [data-fold-row], [data-more-cell-id]";

/** What `useBoardDrag` is given. */
export interface BoardDragOptions {
  /** The element that scrolls the board. It stays mounted for the life of the screen, so it holds the pointer. */
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  /** Every card of the board in stored order, with the pending moves applied. */
  readonly cards: readonly WorkCard[];
  readonly projects: readonly WorkProject[];
  /** What each lane shows, which says which cards a cell hides. */
  readonly arranged: readonly ArrangedLane[];
  /** Moves a card and says so on the undo line. A move that changes nothing does nothing. */
  readonly moveCard: (move: CardMove, words: string) => void;
}

/** What `useBoardDrag` returns. */
export interface BoardDrag {
  /**
   * Returns whether a card is in the hand right now. While one is, only Esc
   * means anything, and the drag handles it. A function, not a value, so a
   * key press asks at the moment it happens and the screen does not draw again
   * when a card is lifted.
   */
  readonly isCarrying: () => boolean;
}

/** How the card in the hand looked at the moment it was let go, which the landing starts from. */
interface Look {
  readonly centerX: number;
  readonly centerY: number;
  readonly scale: number;
  readonly tilt: number;
  readonly lift: number;
  readonly velocity: Velocity;
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
  readonly cardId: string;
  readonly element: HTMLElement;
  readonly startX: number;
  readonly startY: number;
}

/** A card in the hand. */
interface Carry {
  readonly pointerId: number;
  readonly card: WorkCard;
  /** The id of the lane the card came from. */
  readonly originLaneId: string;
  /** The card's element in the page. It stays mounted and hidden for the whole carry. */
  readonly source: HTMLElement;
  readonly root: HTMLElement;
  readonly layer: HTMLElement;
  /** The copy in the hand, in the carry layer. */
  readonly ghost: HTMLElement;
  readonly body: MotionBody;
  /** The hollow that shows where the card would land. It lives in the cell, outside React's reach. */
  readonly slot: HTMLElement;
  /** Where the layout puts the ghost, in window pixels. */
  readonly home: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  /** Where in the card the pointer took hold of it. */
  readonly grab: { readonly x: number; readonly y: number };
  readonly reduced: boolean;
  readonly watcher: MutationObserver;
  readonly hand: Hand;
  geometry: BoardGeometry;
  place: DropPlace | null;
  uprightTimer: number | undefined;
  scrollFrame: number;
  /** The folded lane that is marked as the target, if one is. */
  markedLane: HTMLElement | null;
}

/** What a drop sends, with the words for the undo line. */
interface DropChange {
  readonly move: CardMove;
  readonly words: string;
}

/** Returns `value` limited to the range from `-limit` to `limit`. */
const limitSymmetric = (value: number, limit: number): number =>
  Math.max(-limit, Math.min(limit, value));

/** Returns the stage `value` names, or `undefined` when it names none. */
const readStage = (value: string | undefined): BoardStage | undefined =>
  BOARD_STAGES.find((stage) => stage === value);

/** Returns the element after `element` that takes room in the layout, which is the next one not hidden because it is in the hand. */
const findNextShownSibling = (element: Element): Element | null => {
  let next = element.nextElementSibling;
  while (next instanceof HTMLElement && next.dataset["dragged"] !== undefined) {
    next = next.nextElementSibling;
  }
  return next;
};

/** Returns the id of the card shown right after `slot`, or `null` when the cards end there. */
const findNextShownCardId = (slot: HTMLElement): string | null => {
  const next = findNextShownSibling(slot);
  return next instanceof HTMLElement ? (next.dataset["cardId"] ?? null) : null;
};

/** Returns the element under `scroller` whose data attribute `attribute` (such as `data-card-id`) holds `value`, or `null`. Compared in code, so an id needs no escaping in a selector. */
const findByData = (scroller: HTMLElement, attribute: string, value: string): HTMLElement | null =>
  [...scroller.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(
    (element) => element.getAttribute(attribute) === value,
  ) ?? null;

/** Returns the line under the cards of `cell` ("13 more"), or `null` when it has none. */
const findCellFoot = (cell: HTMLElement): HTMLElement | null =>
  [...cell.children].find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains("board-more"),
  ) ?? null;

/**
 * Returns the key that tells a thing on the board apart across a change, or
 * `null` for the card in the hand, which is moved by its own landing.
 */
const readFlipKey =
  (movingCardId: string) =>
  (element: HTMLElement): string | null => {
    const { cardId, laneHead, foldRow, moreCellId } = element.dataset;
    if (cardId !== undefined) return cardId === movingCardId ? null : `card:${cardId}`;
    if (laneHead !== undefined) return `head:${laneHead}`;
    if (foldRow !== undefined) return `fold:${foldRow}`;
    return moreCellId === undefined ? null : `more:${moreCellId}`;
  };

/**
 * Swallows the click that follows a carry, which would otherwise open the card
 * that was dropped. `isPointerUp` says whether the button is already up. When
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

/** Returns the text of each stage's count, by stage: an empty text for a stage that shows none. */
const readStageCounts = (scroller: HTMLElement): ReadonlyMap<BoardStage, string> =>
  new Map(
    BOARD_STAGES.map((stage) => [
      stage,
      scroller.querySelector(`.board-rule [data-stage="${stage}"] .desk-heading-count`)
        ?.textContent ?? "",
    ]),
  );

/**
 * The imperative half of dragging. Everything a carry touches outside React
 * (the ghost, the slot, the markers) is made, moved and removed here, so the
 * hook only has to start it on mount and stop it on unmount.
 *
 * `readOptions` returns the newest options each time it is called, and
 * `announceCarrying` is told when a card enters and leaves the hand.
 */
const createBoardDrag = (
  scroller: HTMLElement,
  readOptions: () => BoardDragOptions,
  announceCarrying: (isCarrying: boolean) => void,
): { readonly destroy: () => void } => {
  let press: Press | null = null;
  let carry: Carry | null = null;

  /**
   * Measures the board once. The rows are where the layout puts them, with the
   * offsets of cards that are still gliding taken away, so the answer is the
   * same whether or not a spring is running.
   */
  const measureBoard = (): BoardGeometry => {
    const columns: StageColumn[] = [];
    for (const element of scroller.querySelectorAll<HTMLElement>(".board-rule [data-stage]")) {
      const stage = readStage(element.dataset["stage"]);
      if (stage !== undefined) columns.push({ stage, left: element.getBoundingClientRect().left });
    }
    const lanes = [...scroller.querySelectorAll<HTMLElement>(".board-lane[data-lane-id]")].map(
      (element): LaneBox => {
        const rect = element.getBoundingClientRect();
        const cells = new Map<BoardStage, CellBox>();
        for (const cell of element.querySelectorAll<HTMLElement>(".board-cell[data-stage]")) {
          const stage = readStage(cell.dataset["stage"]);
          if (stage === undefined) continue;
          const shownCards = [...cell.children].filter(
            (child): child is HTMLElement =>
              child instanceof HTMLElement && child.dataset["cardId"] !== undefined,
          );
          const rows = shownCards.flatMap((child) => {
            const { cardId, dragged } = child.dataset;
            if (cardId === undefined || dragged !== undefined) return [];
            const place = measureLayoutRect(child);
            return [{ id: cardId, element: child, middle: place.top + place.height / 2 }];
          });
          // The card in the hand still counts as shown: it leaves a place that a drop may take again.
          const hasClosedMoreLine =
            stage !== "landed" && findCellFoot(cell)?.getAttribute("aria-expanded") === "false";
          cells.set(stage, {
            element: cell,
            rows,
            ...(hasClosedMoreLine ? { lastIndex: shownCards.length - 1 } : {}),
          });
        }
        return {
          id: element.dataset["laneId"] ?? "",
          element,
          top: rect.top,
          bottom: rect.bottom,
          isFolded: element.querySelector(":scope > [data-fold-row]") !== null,
          cells,
        };
      },
    );
    const view = scroller.getBoundingClientRect();
    return { columns, lanes, viewTop: view.top, viewBottom: view.bottom };
  };

  /** Changes the page, and glides everything that moves because of it, except the card in the hand. */
  const flipAround = (movingCardId: string, mutate: () => void, spring: SpringName): void => {
    flipByKey({
      root: scroller,
      selector: FLIP_SELECTOR,
      readKey: readFlipKey(movingCardId),
      mutate,
      spring,
    });
  };

  /** Returns whether the slot is already in `cell`, right before `before`. */
  const isSlotAt = (c: Carry, cell: HTMLElement, before: Element | null): boolean =>
    c.slot.parentElement === cell && findNextShownSibling(c.slot) === before;

  /** Moves the slot to `cell`, before `before`, fades it in there, and lets everything below glide aside. */
  const moveSlot = (c: Carry, cell: HTMLElement, before: Element | null): void => {
    if (isSlotAt(c, cell, before)) return;
    flipAround(
      c.card.id,
      () => {
        c.slot.classList.add("is-new");
        cell.insertBefore(c.slot, before);
      },
      "hand",
    );
    // The hidden slot is drawn once, so removing the class starts a fade from it.
    void c.slot.offsetHeight;
    c.slot.classList.remove("is-new");
    c.watcher.takeRecords();
    c.geometry = measureBoard();
  };

  /** Takes the slot out of the page, for a pointer over a folded lane. */
  const removeSlot = (c: Carry): void => {
    if (c.slot.parentElement === null) return;
    flipAround(
      c.card.id,
      () => {
        c.slot.remove();
      },
      "hand",
    );
    c.watcher.takeRecords();
    c.geometry = measureBoard();
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
    moveSlot(c, cell.element, cell.rows[place.index]?.element ?? findCellFoot(cell.element));
  };

  /** Follows the pointer: the ghost goes under it one to one, leans with the hand's speed, and the slot goes where it points. */
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

  /** Works out which place the pointer points at, from the measurements, and shows it when it changed. */
  const choosePlace = (c: Carry): void => {
    const place = chooseDropPlace(c.geometry, c.hand.x, c.hand.y);
    if (place !== null && !isSameDropPlace(place, c.place)) showPlace(c, place);
  };

  /** Scrolls the board for as long as the card is held near its top or bottom edge. */
  const scrollAtEdge = (c: Carry): void => {
    if (c.scrollFrame !== 0) return;
    const step = (): void => {
      c.scrollFrame = 0;
      if (carry !== c) return;
      const speed = computeEdgeScrollSpeed(c.hand.y, c.geometry.viewTop, c.geometry.viewBottom);
      if (speed === 0) return;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + speed;
      if (scroller.scrollTop === before) return;
      c.scrollFrame = requestAnimationFrame(step);
    };
    if (computeEdgeScrollSpeed(c.hand.y, c.geometry.viewTop, c.geometry.viewBottom) === 0) return;
    c.scrollFrame = requestAnimationFrame(step);
  };

  /** Reads how the ghost looks now, and how fast the hand moves, for the landing to start from. */
  const readLook = (c: Carry): Look => {
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

  /** Stops watching the pointer, the page and the keys, and lets the pointer go. The ghost and the slot are left to the caller. */
  const endCarry = (c: Carry): void => {
    carry = null;
    announceCarrying(false);
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
    delete c.root.dataset["carrying"];
    delete c.root.dataset["dragStage"];
    if (c.markedLane !== null) delete c.markedLane.dataset["dropTarget"];
  };

  /** Ends a carry at once, with no motion, and puts the page as it was. Used when the screen goes away. */
  const abandonCarry = (c: Carry): void => {
    endCarry(c);
    c.slot.remove();
    delete c.source.dataset["dragged"];
    clearMarks(c);
    c.body.clear();
    c.layer.remove();
  };

  /**
   * Puts the card on the page where `change` says, or back where it was when
   * there is none, and lets it come down from where it looks now.
   */
  const releaseCarry = (c: Carry, spring: SpringName, change: DropChange | undefined): void => {
    const look = readLook(c);
    const countsBefore = readStageCounts(scroller);
    endCarry(c);
    flipAround(
      c.card.id,
      () => {
        c.slot.remove();
        delete c.source.dataset["dragged"];
        clearMarks(c);
        if (change !== undefined) {
          flushSync(() => {
            readOptions().moveCard(change.move, change.words);
          });
        }
      },
      spring,
    );
    landCard(c, look, spring, change);
    rollChangedCounts(countsBefore);
  };

  /**
   * Brings the card in the page down from the ghost's look, and removes the
   * ghost in the same frame so nothing shows twice. The card may be a new
   * element, because a card that changed cell is a new one to React, so it is
   * found by its id. When it is not on the page (it went into a folded lane, or
   * left the board) the ghost flies to where it went, or fades.
   */
  const landCard = (
    c: Carry,
    look: Look,
    spring: SpringName,
    change: DropChange | undefined,
  ): void => {
    const card = findByData(scroller, "data-card-id", c.card.id);
    if (card === null) {
      flyAway(c, look);
      return;
    }
    const place = measureLayoutRect(card);
    const body = trackBody(card);
    body.set({ s: look.scale, r: look.tilt, l: look.lift });
    body.relocate(
      look.centerX - (place.left + place.width / 2),
      look.centerY - (place.top + place.height / 2),
      look.velocity,
    );
    card.dataset["landing"] = "";
    body.to({ x: 0, y: 0, s: 1, r: 0, l: 0 }, spring, {
      done: () => {
        delete card.dataset["landing"];
        // Gives the card back to its stylesheet: no inline style stays on it.
        body.clear();
      },
    });
    c.body.clear();
    c.layer.remove();
    // Hiding the card dropped its focus; the keyboard goes on from where the card now is.
    if (document.activeElement === null || document.activeElement === document.body) {
      card.focus({ preventScroll: true });
    }
    if (change?.move.stage === "landed" && c.card.stage !== "landed") {
      card.dataset["justLanded"] = "";
      window.setTimeout(() => {
        delete card.dataset["justLanded"];
      }, LANDED_RING_MS);
    }
  };

  /**
   * Sends the ghost to the line that now stands for the card, and fades it
   * there: the count of the folded lane it was dropped on, or the "3 landed"
   * line of a cell that hides it. A card with no such place fades where it is.
   */
  const flyAway = (c: Carry, look: Look): void => {
    const target = findHidingPlace(c);
    const remove = (): void => {
      c.body.clear();
      c.layer.remove();
    };
    if (target === null) {
      c.body.to({ s: 0.96, o: 0 }, "travel", { done: remove });
      return;
    }
    const goal = target.getBoundingClientRect();
    c.body.to(
      {
        x: goal.left + goal.width / 2 - (look.centerX - c.body.values.x),
        y: goal.top + goal.height / 2 - (look.centerY - c.body.values.y),
        s: 0.1,
        o: 0,
      },
      "travel",
      { done: remove },
    );
  };

  /** Returns the element that stands for a card dropped at the carry's place, now that the card itself is not drawn, or `null`. */
  const findHidingPlace = (c: Carry): Element | null => {
    const { place } = c;
    if (place === null) return null;
    if (place.kind === "cell") {
      return findByData(scroller, "data-more-cell-id", buildCellId(place.laneId, place.stage));
    }
    const foldRow = findByData(scroller, "data-fold-row", place.laneId);
    const stage = place.stage ?? c.card.stage;
    return (
      [...(foldRow?.children ?? [])].find(
        (cell) => cell instanceof HTMLElement && cell.dataset["stage"] === stage,
      ) ?? findByData(scroller, "data-lane-head", place.laneId)
    );
  };

  /** Rolls the number of each stage whose count changed, so the new count rises into place. */
  const rollChangedCounts = (before: ReadonlyMap<BoardStage, string>): void => {
    for (const stage of BOARD_STAGES) {
      const count = scroller.querySelector<HTMLElement>(
        `.board-rule [data-stage="${stage}"] .desk-heading-count`,
      );
      if (count === null || count.textContent === before.get(stage)) continue;
      count.dataset["rolling"] = "";
      window.setTimeout(() => {
        delete count.dataset["rolling"];
      }, COUNT_ROLL_MS);
    }
  };

  /** Lets go of the card where the slot is, and sends the move. */
  const dropCard = (c: Carry): void => {
    swallowNextClick(true);
    const options = readOptions();
    const { place } = c;
    const move =
      place === null
        ? undefined
        : buildDropMove({
            cards: options.cards,
            projects: options.projects,
            arranged: options.arranged,
            movingCardId: c.card.id,
            place,
            nextShownCardId: place.kind === "cell" ? findNextShownCardId(c.slot) : null,
          });
    if (move === undefined) {
      releaseCarry(c, "travel", undefined);
      return;
    }
    const card = options.cards.find((each) => each.id === c.card.id) ?? c.card;
    releaseCarry(c, "hand", { move, words: describeCardMove(card, move, options.projects) });
  };

  /**
   * Sends the card home: Esc, a cancelled pointer, a lost pointer, a hidden
   * window, or a page change that took its place away. `isPointerUp` says
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
      : findByData(scroller, "data-card-id", held.cardId);
    const cell = source?.closest<HTMLElement>(".board-cell") ?? null;
    const options = readOptions();
    const card = options.cards.find((each) => each.id === held.cardId);
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
    root.dataset["carrying"] = "";

    const body = trackBody(ghost);
    const reduced = isMotionReduced();
    body.to({ s: CARRY_SCALE, l: 1 }, "hand", { reduced });

    const projectIds = new Set(options.projects.map((project) => project.id));
    const watcher = new MutationObserver(onPageChanged);
    watcher.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener("lostpointercapture", onLostCapture);
    scroller.addEventListener("scroll", onScroll, { passive: true });

    const c: Carry = {
      pointerId: held.pointerId,
      card,
      originLaneId:
        card.projectId !== undefined && projectIds.has(card.projectId)
          ? card.projectId
          : "no-project",
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
      geometry: measureBoard(),
      place: null,
      uprightTimer: undefined,
      scrollFrame: 0,
      markedLane: null,
    };
    carry = c;
    announceCarrying(true);
    followHand(c, event.clientX, event.clientY);
  };

  // ---------- What the page and the pointer tell us ----------

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
    c.geometry = measureBoard();
  }

  /**
   * Runs when the board scrolls under a carried card, by the wheel or at an
   * edge. The card stays in the hand, and what lies under it is read again.
   */
  function onScroll(): void {
    const c = carry;
    if (c === null) return;
    c.geometry = measureBoard();
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

  /** Only Esc means anything while a card is in the hand, and it does not reach anything else. */
  function onKeyDown(event: KeyboardEvent): void {
    if (carry === null || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelCarry(false);
  }

  /** Sends the card home when the window is hidden or loses the focus: the pointer's release may never arrive. */
  function onWindowAway(): void {
    if (carry !== null) cancelCarry(true);
  }

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
    const cardId = element?.dataset["cardId"];
    if (element === null || cardId === undefined) return;
    press = {
      pointerId: event.pointerId,
      cardId,
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
 * - A folded lane is a target as a whole, since it has no cells to put a slot
 *   in. A slot after the last card of a cell that hides some lands before the
 *   first hidden card.
 * - The page is scrolled at the top and bottom edges, and measured again when
 *   it scrolls.
 *
 * Returns `isCarrying`, for keys to stand still while a card is in the hand.
 */
export function useBoardDrag(options: BoardDragOptions): BoardDrag {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const carrying = useRef(false);
  const { scrollRef } = options;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const drag = createBoardDrag(
      scroller,
      () => latest.current,
      (isCarrying) => {
        carrying.current = isCarrying;
      },
    );
    return drag.destroy;
  }, [scrollRef]);
  const isCarrying = useCallback(() => carrying.current, []);
  return { isCarrying };
}

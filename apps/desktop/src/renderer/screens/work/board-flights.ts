/**
 * The parts of the board's motion that are more than a card gliding to a new
 * place: copies of cards that fly into a count or a button, cards that grow
 * out of a count, and a Task that rises into its cell. Everything here moves
 * `transform` and `opacity` only, through the motion kernel, and does nothing
 * at all under Reduce motion except where a function says otherwise.
 */
import { ROWS_BEFORE_HIDING } from "@hercule/client-core/work";
import {
  computeCenter,
  findBody,
  ghostElement,
  isMotionReduced,
  measureLayoutRect,
  staggerDelay,
  trackBody,
} from "../../app/motion";

/** The class of the layer that holds the copies in flight. */
const FLIGHT_LAYER_CLASS = "board-flights";

/** How many milliseconds apart the cards of a folding lane leave, and of an opening lane arrive. */
const FOLD_GAP = 12;
const UNFOLD_GAP = 16;

/** When a card flying into a count starts to fade, and how long the fade takes, in milliseconds after it left. It stays solid until it is small. */
const FADE_AFTER = 210;
const FADE_FOR = 90;

/** The delay before the colleague of an arriving Task comes up, and before its paws reach the edge, in milliseconds. */
const HEAD_DELAY = 620;
const PAWS_DELAY = 760;

/** How far the colleague's head sits below the edge before it comes up, in pixels. */
const HEAD_DEPTH = 18;

/**
 * Returns the layer for copies in flight, making it on first use. It covers
 * the desk and sits over the board, so a copy flying across a scroll that the
 * change itself causes is not carried off with the page.
 */
const findFlightLayer = (scroller: HTMLElement): HTMLElement | null => {
  const desk = scroller.closest<HTMLElement>(".work-desk");
  if (desk === null) return null;
  let layer = desk.querySelector<HTMLElement>(`:scope > .${FLIGHT_LAYER_CLASS}`);
  if (layer === null) {
    layer = document.createElement("div");
    layer.className = FLIGHT_LAYER_CLASS;
    layer.setAttribute("aria-hidden", "true");
    desk.append(layer);
  }
  return layer;
};

/** Takes the layer away when no copy is left in it. */
const removeEmptyLayer = (layer: HTMLElement): void => {
  if (layer.childElementCount === 0) layer.remove();
};

/** Removes a copy, and the layer when it was the last. */
const removeFlight = (ghost: HTMLElement): void => {
  const layer = ghost.parentElement;
  findBody(ghost)?.clear();
  ghost.remove();
  if (layer !== null) removeEmptyLayer(layer);
};

/** A copy of a card that is about to leave the page, and where its Task goes. */
interface Flight {
  readonly ghost: HTMLElement;
  readonly cardId: string;
  readonly laneId: string;
  readonly stage: string;
  readonly delay: number;
}

/** Returns whether any of the card is inside the visible part of the scroller. */
const isInView = (card: HTMLElement, view: DOMRect): boolean => {
  const rect = card.getBoundingClientRect();
  return rect.bottom > view.top && rect.top < view.bottom;
};

/**
 * Makes a copy of each card of `lanes` that is in view, to fly while the real
 * cards are gone. Call it before the change that removes the cards. Cards out
 * of view just go, and so does everything when the user asked for no motion.
 */
export const launchFoldFlights = (
  scroller: HTMLElement,
  lanes: readonly HTMLElement[],
): readonly Flight[] => {
  const layer = isMotionReduced() ? null : findFlightLayer(scroller);
  if (layer === null) return [];
  const view = scroller.getBoundingClientRect();
  const flights: Flight[] = [];
  for (const lane of lanes) {
    for (const card of lane.querySelectorAll<HTMLElement>("[data-card-id]")) {
      if (!isInView(card, view)) continue;
      flights.push({
        ghost: ghostElement(card, layer),
        cardId: card.dataset["cardId"] ?? "",
        laneId: lane.dataset["laneId"] ?? "",
        stage: card.dataset["stage"] ?? "",
        delay: staggerDelay(flights.length, FOLD_GAP),
      });
    }
  }
  return flights;
};

/**
 * Sends each copy made by `launchFoldFlights` to the count of its stage on its
 * lane's line, shrinking to a tenth, and removes it on arrival. A copy stays
 * solid until it is small. Call it after the change, once the counts exist.
 */
export const flyFlightsIntoCounts = (scroller: HTMLElement, flights: readonly Flight[]): void => {
  for (const flight of flights) {
    const count = scroller.querySelector(
      `[data-fold-row="${flight.laneId}"] [data-stage="${flight.stage}"]`,
    );
    if (count === null) {
      removeFlight(flight.ghost);
      continue;
    }
    const from = computeCenter(measureLayoutRect(flight.ghost));
    const to = computeCenter(count.getBoundingClientRect());
    trackBody(flight.ghost).to({ x: to.x - from.x, y: to.y - from.y, s: 0.1 }, "travel", {
      delay: flight.delay,
      done: () => {
        removeFlight(flight.ghost);
      },
    });
    flight.ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
      delay: flight.delay + FADE_AFTER,
      duration: FADE_FOR,
      fill: "forwards",
    });
  }
};

/** Returns the key of the count a card grows from (`laneId` and `stage`), or of its copy in flight (`""` and the card's id). */
const buildGrowthKey = (laneId: string, stageOrCardId: string): string =>
  `${laneId}/${stageOrCardId}`;

/** Where a card that is about to grow out of a count starts: the center and size of the count, or of the copy still flying there. */
interface GrowthOrigin {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly opacity: number;
  /** True for a copy still in flight: its card follows it with no delay. */
  readonly isLive: boolean;
}

/**
 * Records where the cards of `lanes` will grow from when `lanes` open: the
 * count of each stage on the lane's line, or, for a card whose copy is still
 * flying from an earlier fold, that copy as it looks now. The copies are
 * removed, because their cards take over. Call it before the change.
 *
 * Returns the origins by a key built with `buildGrowthKey`.
 */
export const recordGrowthOrigins = (
  scroller: HTMLElement,
  lanes: readonly HTMLElement[],
): ReadonlyMap<string, GrowthOrigin> => {
  const origins = new Map<string, GrowthOrigin>();
  for (const lane of lanes) {
    const laneId = lane.dataset["laneId"] ?? "";
    for (const count of lane.querySelectorAll<HTMLElement>("[data-fold-row] [data-stage]")) {
      const place = computeCenter(count.getBoundingClientRect());
      origins.set(buildGrowthKey(laneId, count.dataset["stage"] ?? ""), {
        ...place,
        scale: 0.1,
        opacity: 0,
        isLive: false,
      });
    }
  }
  const layer = scroller.closest(".work-desk")?.querySelector(`:scope > .${FLIGHT_LAYER_CLASS}`);
  for (const ghost of layer?.querySelectorAll<HTMLElement>("[data-card-id]") ?? []) {
    const place = computeCenter(ghost.getBoundingClientRect());
    origins.set(buildGrowthKey("", ghost.dataset["cardId"] ?? ""), {
      ...place,
      scale: findBody(ghost)?.values.s ?? 1,
      opacity: 1,
      isLive: true,
    });
    for (const animation of ghost.getAnimations()) animation.cancel();
    removeFlight(ghost);
  }
  return origins;
};

/**
 * Grows each card of `lanes` out of the origin recorded for it, 16ms apart
 * (a card following a copy in flight starts at once). Under Reduce motion the
 * cards fade in where they stand. Call it after the change.
 */
export const growCardsFromOrigins = (
  lanes: readonly HTMLElement[],
  origins: ReadonlyMap<string, GrowthOrigin>,
): void => {
  const reduced = isMotionReduced();
  let index = 0;
  for (const lane of lanes) {
    const laneId = lane.dataset["laneId"] ?? "";
    for (const card of lane.querySelectorAll<HTMLElement>("[data-card-id]")) {
      const origin =
        origins.get(buildGrowthKey("", card.dataset["cardId"] ?? "")) ??
        origins.get(buildGrowthKey(laneId, card.dataset["stage"] ?? ""));
      if (origin === undefined) continue;
      const body = trackBody(card);
      if (reduced) {
        body.set({ o: 0 });
        body.to({ o: 1 }, "travel", { reduced });
        continue;
      }
      const to = computeCenter(measureLayoutRect(card));
      body.set({ x: origin.x - to.x, y: origin.y - to.y, s: origin.scale, o: origin.opacity });
      body.to({ x: 0, y: 0, s: 1, o: 1 }, "travel", {
        delay: origin.isLive ? 0 : staggerDelay(index, UNFOLD_GAP),
      });
      index += 1;
    }
  }
};

/**
 * Makes a copy of each card of `cell` past the rows a closed cell shows (all
 * of them, in the Landed cell), which may leave when the cell closes. The copies of cards that
 * stay are thrown away by `flyFlightsToButton`. Call it before the change.
 */
export const launchCloseFlights = (scroller: HTMLElement, cell: HTMLElement): readonly Flight[] => {
  const layer = isMotionReduced() ? null : findFlightLayer(scroller);
  if (layer === null) return [];
  const view = scroller.getBoundingClientRect();
  return [...cell.querySelectorAll<HTMLElement>("[data-card-id]")]
    .slice(cell.dataset["stage"] === "landed" ? 0 : ROWS_BEFORE_HIDING)
    .filter((card) => isInView(card, view))
    .map((card) => ({
      ghost: ghostElement(card, layer),
      cardId: card.dataset["cardId"] ?? "",
      laneId: cell.dataset["laneId"] ?? "",
      stage: cell.dataset["stage"] ?? "",
      delay: 0,
    }));
};

/**
 * Sends each copy made by `launchCloseFlights` whose card left the page back
 * to the button of its cell, the one that opened it, fading as it goes.
 * Copies of cards that are still there are removed. Call it after the change.
 */
export const flyFlightsToButton = (
  scroller: HTMLElement,
  cellId: string,
  flights: readonly Flight[],
): void => {
  const button = scroller.querySelector(`[data-more-cell-id="${cellId}"]`);
  for (const flight of flights) {
    const isGone = scroller.querySelector(`[data-card-id="${flight.cardId}"]`) === null;
    if (!isGone || button === null) {
      removeFlight(flight.ghost);
      continue;
    }
    const from = computeCenter(measureLayoutRect(flight.ghost));
    const to = computeCenter(button.getBoundingClientRect());
    trackBody(flight.ghost).to({ x: to.x - from.x, y: to.y - from.y, s: 0.9, o: 0 }, "travel", {
      done: () => {
        removeFlight(flight.ghost);
      },
    });
  }
};

/** Fades each card in from 6px above where it stands. `spring` is `travel` for what the user asked for and `self` for what happened by itself. */
export const fadeInCards = (cards: readonly HTMLElement[], spring: "travel" | "self"): void => {
  for (const card of cards) {
    const body = trackBody(card);
    body.set({ o: 0, y: -6 });
    body.to({ o: 1, y: 0 }, spring);
  }
};

/**
 * Lifts a Task that arrived into its cell: it rises from 12px down and 0.97
 * scale with opacity from 0 on `self`. 620ms later its colleague's head comes
 * up from behind the edge on `travel`, and then its paws reach the edge. A
 * thin ring (`data-new`) fades over 3.2 seconds and takes itself away.
 */
export const riseArrival = (card: HTMLElement): void => {
  const body = trackBody(card);
  body.set({ y: 12, s: 0.97, o: 0 });
  body.to({ y: 0, s: 1, o: 1 }, "self");
  if (isMotionReduced()) return;
  const head = card.querySelector<HTMLElement>(".card-head");
  if (head !== null) {
    trackBody(head).set({ y: HEAD_DEPTH });
    trackBody(head).to({ y: 0 }, "travel", { delay: HEAD_DELAY });
  }
  const paws = card.querySelector<HTMLElement>(".card-paws");
  if (paws !== null) {
    trackBody(paws).set({ o: 0 });
    trackBody(paws).to({ o: 1 }, "travel", { delay: PAWS_DELAY });
  }
  // A data attribute, not a class: React rewrites a card's classes.
  card.dataset["new"] = "";
  const clearRing = (event: AnimationEvent): void => {
    if (event.target !== card) return;
    delete card.dataset["new"];
    card.removeEventListener("animationend", clearRing);
  };
  card.addEventListener("animationend", clearRing);
};

/**
 * Carrying a card of the Inbox in the hand, outside React: the copy that
 * follows the pointer, the rail's targets it is pulled towards, the card whose
 * edge lights when letting go would link the two, and how the card goes home
 * or comes to land. `useInboxCarry` starts it on mount and stops it on unmount.
 *
 * It reads the page and moves elements through the motion kernel. It never
 * calls the API: a drop reaches the page through two callbacks.
 */
import { flushSync } from "react-dom";
import {
  ensureOverlayLayer,
  findBody,
  ghostElement,
  HAND_STILL_AFTER_MS,
  HandTracker,
  isMotionReduced,
  measureLayoutRect,
  swallowNextClick,
  trackBody,
  type LayoutRect,
  type MotionBody,
} from "../../app/motion";
import { copyCardForMotion } from "../desk";
import { findCardElement, readBundleLeadElement, readCardElement } from "./inbox-page-dom";
import type { RailTarget } from "./rail";
import "./carry.css";

/** How far the pointer moves, in pixels, before a press becomes a carry. Less than this is a click. */
const LIFT_DISTANCE = 6;

/** How near, in pixels, the pointer must come to the middle of a target before the target pulls the card in. */
const REACH = 96;

/** How big a card is in the hand, and how big while a target pulls it in. */
const HELD_SCALE = 1.03;
const NEAR_SCALE = 0.62;

/** How much a target's picture swells when the card is near, and how far it swells in the pulse of a drop. */
const SWELL_SCALE = 1.16;
const PULSE_SCALE = 1.26;

/** The most a carried card leans, in degrees, and the degrees of lean for each pixel per millisecond of sideways speed. */
const MOST_LEAN = 3.5;
const LEAN_PER_SPEED = 4;

/** How far below its place the rail starts, and how far below theirs its targets start, in pixels. */
const RAIL_DEPTH = 24;
const TARGET_DEPTH = 6;

/** How long, in milliseconds, each target starts after the one before it. */
const TARGET_STAGGER_MS = 28;

/** How long the rail stays after a drop on a target, so the choice is seen to land, in milliseconds. */
const ACCEPT_HOLD_MS = 340;

/** How long after a drop on a target the chosen move starts, in milliseconds: as the card comes in to land. */
const LAND_AFTER_MS = 200;

/** Where the card shrinks to when it is dropped on another card: this far in, and this far above the lower edge, in pixels. */
const LINK_INSET_X = 12;
const LINK_RISE = 24;

/**
 * Matches what starts no carry: a button, a link, a menu or a field. A press
 * on one of them is for it.
 */
const NO_CARRY_SELECTOR =
  "button, a[href], input, select, textarea, [contenteditable], [role='menu'], [role='menuitem']";

/** What the page draws of a carry: the rail (while the card is in the hand and as the rail leaves) and the card it is for. */
export interface CarryView {
  readonly cardId: string;
  readonly targets: readonly RailTarget[];
  /** Whether the card is in the hand. It is false while the rail leaves after a drop. */
  readonly isHeld: boolean;
}

/** What `createInboxCarry` is given, read at each use so it is always the newest. */
export interface InboxCarryOptions {
  /** Whether a press starts no carry at all, for as long as it is true. */
  readonly disabled: boolean;
  /** Returns whether the card `cardId` may be carried. */
  readonly canCarry: (cardId: string) => boolean;
  /** Returns the targets the rail offers for the card `cardId`, in the order it draws them. */
  readonly readRailTargets: (cardId: string) => readonly RailTarget[];
  /** Called when the card `cardId` is dropped on a target, 200 ms into its landing (at once for `dismiss`). */
  readonly onDropOnTarget: (cardId: string, target: RailTarget) => void;
  /** Called when the card `cardId` is dropped on the card `ontoCardId`, at once. */
  readonly onDropOnCard: (cardId: string, ontoCardId: string) => void;
}

/** A target of the rail, as it rests. */
interface TargetSpot {
  readonly target: RailTarget;
  readonly element: HTMLElement;
  /** The picture that swells when the card is near and pulses when it is dropped. */
  readonly face: HTMLElement;
  /** The middle of the target, in window pixels. */
  readonly x: number;
  readonly y: number;
}

/** A press on a card that has not moved far enough to be a carry. */
interface Press {
  readonly pointerId: number;
  readonly cardId: string;
  readonly element: HTMLElement;
  readonly startX: number;
  readonly startY: number;
}

/** A card in the hand, or let go and still on its way. */
interface Carry {
  readonly pointerId: number;
  readonly cardId: string;
  /** The card's element in the page. It stays mounted and is hidden (`data-carried`) while the copy is away. */
  readonly source: HTMLElement;
  /** The copy in the hand and its body. Its offsets are from `home`. */
  readonly ghost: HTMLElement;
  readonly body: MotionBody;
  /** Where the layout puts the copy, in window pixels. */
  readonly home: LayoutRect;
  /** Where in the card the pointer took hold of it. */
  readonly grab: { readonly x: number; readonly y: number };
  readonly hand: HandTracker;
  readonly spots: readonly TargetSpot[];
  readonly reduced: boolean;
  /** The target the card is near, if any. */
  near: TargetSpot | null;
  /** The card whose edge is lit, if any. */
  onto: HTMLElement | null;
  uprightTimer: number | undefined;
}

/** What `createInboxCarry` needs from the page. */
interface InboxCarryDeps {
  /** The element that holds the cards and stays mounted for the life of the screen, so it holds the pointer. */
  readonly page: HTMLElement;
  readonly readOptions: () => InboxCarryOptions;
  /** Returns the rail's element, or `null` when the page does not draw one. */
  readonly readRail: () => HTMLElement | null;
  /** Tells the page what to draw: the rail with its targets, or nothing. */
  readonly publish: (view: CarryView | null) => void;
}

const limitSymmetric = (value: number, limit: number): number =>
  Math.max(-limit, Math.min(limit, value));

/** Returns the target of `spots` whose middle is nearest to the point, within `REACH`, or `null`. */
const findNearSpot = (spots: readonly TargetSpot[], x: number, y: number): TargetSpot | null => {
  let nearest: TargetSpot | null = null;
  let nearestDistance = REACH;
  for (const spot of spots) {
    const distance = Math.hypot(x - spot.x, y - spot.y);
    if (distance < nearestDistance) {
      nearest = spot;
      nearestDistance = distance;
    }
  }
  return nearest;
};

/** Gives the rail and its targets back to their stylesheet, and takes the near mark off them. */
const resetRail = (rail: HTMLElement): void => {
  findBody(rail)?.clear();
  for (const element of rail.querySelectorAll<HTMLElement>(
    "[data-rail-target], [data-rail-face]",
  )) {
    findBody(element)?.clear();
    element.removeAttribute("data-near");
  }
};

/**
 * Handles the pointer on `page` for as long as it lives. Everything a carry
 * touches outside React (the copy, the marks on cards and targets, the layer)
 * is made, moved and removed here. Returns `destroy`, which stops listening and
 * puts the page back as it was: a drop already chosen is still sent.
 */
export const createInboxCarry = ({
  page,
  readOptions,
  readRail,
  publish,
}: InboxCarryDeps): { readonly destroy: () => void } => {
  let press: Press | null = null;
  let carry: Carry | null = null;
  /** Every copy that is in the hand or still on its way, so none outlives the screen. */
  const copies = new Set<Carry>();
  let view: CarryView | null = null;
  let railTimer: number | undefined;
  /** The drop on a target that waits for its landing. */
  let landing: { readonly carry: Carry; readonly target: RailTarget; timer: number } | null = null;

  const setView = (next: CarryView | null): void => {
    view = next;
    publish(next);
  };

  /** Returns the element of the card now: the one lifted, or the one React drew since, or `null` when the card left the page. */
  const findSource = (c: Carry): HTMLElement | null =>
    c.source.isConnected ? c.source : findCardElement(page, c.cardId);

  const revealSource = (c: Carry): void => {
    findSource(c)?.removeAttribute("data-carried");
  };

  /** Removes the copy, and its layer when it is the last one in it. */
  const removeCopy = (c: Carry): void => {
    window.clearTimeout(c.uprightTimer);
    findBody(c.ghost)?.clear();
    const layer = c.ghost.parentElement;
    c.ghost.remove();
    if (layer?.childElementCount === 0) layer.remove();
    copies.delete(c);
  };

  // ---------- The rail ----------

  /** Makes the rail rise and its targets fade up one after the other. Measures the targets first, where they rest. */
  const raiseRail = (rail: HTMLElement): TargetSpot[] => {
    resetRail(rail);
    const spots = [...rail.querySelectorAll<HTMLElement>("[data-rail-target]")].flatMap(
      (element): TargetSpot[] => {
        const target = view?.targets[Number(element.dataset["railTarget"])];
        const face = element.querySelector<HTMLElement>("[data-rail-face]");
        if (target === undefined || face === null) return [];
        const rect = element.getBoundingClientRect();
        return [
          { target, element, face, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        ];
      },
    );
    const railBody = trackBody(rail);
    railBody.set({ y: RAIL_DEPTH, o: 0 });
    railBody.to({ y: 0, o: 1 }, "travel");
    spots.forEach((spot, index) => {
      const body = trackBody(spot.element);
      body.set({ y: TARGET_DEPTH, o: 0 });
      body.to({ y: 0, o: 1 }, "hand", { delay: index * TARGET_STAGGER_MS });
    });
    return spots;
  };

  /** Makes the rail leave after `holdMs`, and then takes it off the page. A carry that starts meanwhile keeps it. */
  const dismissRail = (holdMs: number): void => {
    window.clearTimeout(railTimer);
    const leave = (): void => {
      const rail = readRail();
      if (rail === null) {
        setView(null);
        return;
      }
      trackBody(rail).to({ y: RAIL_DEPTH, o: 0 }, "travel", { done: () => setView(null) });
    };
    if (holdMs === 0) leave();
    else railTimer = window.setTimeout(leave, holdMs);
  };

  // ---------- Marks ----------

  /** Swells the picture of the target the card is near, and settles the one it left. */
  const markNear = (c: Carry, next: TargetSpot | null): void => {
    if (next === c.near) return;
    if (c.near !== null) {
      c.near.element.removeAttribute("data-near");
      trackBody(c.near.face).to({ s: 1 }, "hand");
    }
    c.near = next;
    if (next !== null) {
      next.element.setAttribute("data-near", "");
      trackBody(next.face).to({ s: SWELL_SCALE }, "hand");
    }
  };

  /** Lights the edge of the card that letting go would link, and puts out the one before. */
  const markLinkTarget = (c: Carry, next: HTMLElement | null): void => {
    if (next === c.onto) return;
    c.onto?.removeAttribute("data-link-target");
    c.onto = next;
    next?.setAttribute("data-link-target", "");
  };

  /**
   * Returns the lead card of the bundle under the point, or `null` when there
   * is none or it is the card's own bundle. The parts and hints set in under a
   * card are part of it, so a drop anywhere on the thing counts.
   */
  const findCardUnder = (c: Carry, x: number, y: number): HTMLElement | null => {
    const lead = readBundleLeadElement(document.elementFromPoint(x, y));
    return lead === null || lead === readBundleLeadElement(c.source) ? null : lead;
  };

  // ---------- Following the hand ----------

  /**
   * Puts the copy under the pointer one to one, leaning with the hand's speed.
   * Within reach of a target it is pulled towards the target's middle on a
   * smooth ramp, and shrinks.
   */
  const followHand = (c: Carry, pointerX: number, pointerY: number): void => {
    c.hand.moveTo(pointerX, pointerY);
    const near = findNearSpot(c.spots, pointerX, pointerY);
    markNear(c, near);
    markLinkTarget(c, near === null ? findCardUnder(c, pointerX, pointerY) : null);
    let x = pointerX - c.grab.x - c.home.left;
    let y = pointerY - c.grab.y - c.home.top;
    if (near !== null) {
      const pull = 1 - Math.hypot(pointerX - near.x, pointerY - near.y) / REACH;
      const ramp = pull * pull * (3 - 2 * pull);
      x += (near.x - c.home.width / 2 - c.home.left - x) * ramp;
      y += (near.y - c.home.height / 2 - c.home.top - y) * ramp;
    }
    c.body.follow(x, y);
    const lean = c.reduced ? 0 : limitSymmetric(c.hand.vx * LEAN_PER_SPEED, MOST_LEAN);
    c.body.to({ r: lean, s: near === null ? HELD_SCALE : NEAR_SCALE, l: 1 }, "hand", {
      reduced: c.reduced,
    });
    if (c.reduced) return;
    window.clearTimeout(c.uprightTimer);
    c.uprightTimer = window.setTimeout(() => c.body.to({ r: 0 }, "hand"), HAND_STILL_AFTER_MS);
  };

  // ---------- Letting go ----------

  /** Stops watching the pointer and the keys, lets the pointer go, and takes the marks off the page. */
  const endCarry = (c: Carry): void => {
    carry = null;
    window.clearTimeout(c.uprightTimer);
    page.removeEventListener("lostpointercapture", onLostCapture);
    if (page.hasPointerCapture(c.pointerId)) page.releasePointerCapture(c.pointerId);
    stopListening();
    document.documentElement.removeAttribute("data-carrying");
    markLinkTarget(c, null);
    markNear(c, null);
  };

  /** Sends the copy to where its card lies now, with the speed of the throw. `done` runs when it arrives. */
  const sendHome = (c: Carry, source: HTMLElement, done?: () => void): void => {
    const rest = measureLayoutRect(source);
    const { x, y } = c.body.values;
    c.body.relocate(x, y, c.hand.readThrow());
    c.body.to(
      { x: rest.left - c.home.left, y: rest.top - c.home.top, s: 1, r: 0, l: 0 },
      "travel",
      done === undefined ? {} : { done },
    );
  };

  /** Fades the copy out where it is, for a card that left the page while it was in the hand. */
  const fadeAway = (c: Carry): void => {
    c.body.to({ s: 0.96, o: 0 }, "travel", { done: () => removeCopy(c) });
  };

  /** Sends the card home with no choice made: the copy arrives, and the card takes its place with no blink. */
  const cancelCarry = (c: Carry, isPointerUp: boolean): void => {
    endCarry(c);
    swallowNextClick(isPointerUp);
    dismissRail(0);
    setView(view === null ? null : { ...view, isHeld: false });
    const source = findSource(c);
    if (source === null) {
      fadeAway(c);
      return;
    }
    sendHome(c, source, () => {
      revealSource(c);
      removeCopy(c);
    });
  };

  /** Hands the copy's place to the card itself in mid-air, keeping the pose and the speed, and lets the card come home. */
  const takeOver = (c: Carry, source: HTMLElement): void => {
    const box = c.ghost.getBoundingClientRect();
    const { s, r, l } = c.body.values;
    const velocity = c.body.velocity;
    const rest = measureLayoutRect(source);
    removeCopy(c);
    source.removeAttribute("data-carried");
    source.setAttribute("data-carry-landing", "");
    const body = trackBody(source);
    body.set({ s, r, l });
    body.relocate(
      box.left + box.width / 2 - (rest.left + rest.width / 2),
      box.top + box.height / 2 - (rest.top + rest.height / 2),
      velocity,
    );
    body.to({ x: 0, y: 0, s: 1, r: 0, l: 0 }, "travel", {
      done: () => {
        source.removeAttribute("data-carry-landing");
        body.clear();
      },
    });
  };

  /** Starts the move the card was dropped on a target for, and lets the card land where the copy is. */
  const land = (drop: NonNullable<typeof landing>): void => {
    landing = null;
    const { carry: c, target } = drop;
    const source = findSource(c);
    if (source === null) fadeAway(c);
    else takeOver(c, source);
    readOptions().onDropOnTarget(c.cardId, target);
  };

  /** Lets the card go on a target: it pulses, the rail holds, the copy goes home, and the move starts 200 ms in. */
  const dropOnTarget = (c: Carry, source: HTMLElement | null, spot: TargetSpot): void => {
    const face = trackBody(spot.face);
    face.to({ s: PULSE_SCALE }, "hand", { done: () => face.to({ s: 1 }, "hand") });
    dismissRail(ACCEPT_HOLD_MS);
    if (spot.target.kind === "dismiss") {
      // The card leaves from the rail. Going home first would be the gesture backwards.
      revealSource(c);
      c.body.to({ s: 0.3, o: 0 }, "hand", { done: () => removeCopy(c) });
      readOptions().onDropOnTarget(c.cardId, spot.target);
      return;
    }
    if (source !== null) sendHome(c, source);
    landing = {
      carry: c,
      target: spot.target,
      timer: window.setTimeout(() => {
        if (landing !== null) land(landing);
      }, LAND_AFTER_MS),
    };
  };

  /** Lets the card go on another card: the copy shrinks into that card's lower edge and fades, and the cards are linked. */
  const dropOnCard = (c: Carry, onto: HTMLElement): void => {
    dismissRail(0);
    const to = onto.getBoundingClientRect();
    revealSource(c);
    c.body.to(
      {
        x: to.left + LINK_INSET_X - c.home.left,
        y: to.top + to.height - LINK_RISE - c.home.top,
        s: 0.5,
        o: 0,
      },
      "travel",
      { done: () => removeCopy(c) },
    );
    readOptions().onDropOnCard(c.cardId, onto.dataset["cardId"] ?? "");
  };

  /** Lets go of the card: on a target, on another card, or nowhere, which sends it home. */
  const dropCarry = (c: Carry): void => {
    const { near, onto } = c;
    const source = findSource(c);
    if (near === null && onto === null) {
      cancelCarry(c, true);
      return;
    }
    endCarry(c);
    swallowNextClick(true);
    setView(view === null ? null : { ...view, isHeld: false });
    if (near !== null) dropOnTarget(c, source, near);
    else if (onto !== null) dropOnCard(c, onto);
  };

  /** Ends a carry at once, with no motion, and puts the page as it was. Used when the screen goes away. */
  const abandonCarry = (c: Carry): void => {
    endCarry(c);
    revealSource(c);
    removeCopy(c);
  };

  // ---------- Lifting ----------

  /** Lifts the pressed card into the hand: a copy goes up, the card's place stays open, and the rail rises. */
  const liftCard = (event: PointerEvent): void => {
    const held = press;
    press = null;
    if (held === null) return;
    const options = readOptions();
    const source = held.element.isConnected ? held.element : findCardElement(page, held.cardId);
    const desk = page.closest<HTMLElement>(".inbox-desk");
    if (source === null || desk === null) {
      stopListening();
      return;
    }
    try {
      page.setPointerCapture(held.pointerId);
    } catch {
      // The pointer was let go before the lift, so there is nothing to carry.
      stopListening();
      return;
    }
    window.clearTimeout(railTimer);
    flushSync(() => {
      setView({ cardId: held.cardId, targets: options.readRailTargets(held.cardId), isHeld: true });
    });
    const rail = readRail();
    if (rail === null) {
      if (page.hasPointerCapture(held.pointerId)) page.releasePointerCapture(held.pointerId);
      stopListening();
      setView(null);
      return;
    }
    const spots = raiseRail(rail);

    const home = measureLayoutRect(source);
    const seen = source.getBoundingClientRect();
    const ghost = ghostElement(
      source,
      ensureOverlayLayer(desk, "inbox-carry"),
      copyCardForMotion(source),
    );
    ghost.classList.add("inbox-carry-ghost");
    source.setAttribute("data-carried", "");
    document.documentElement.setAttribute("data-carrying", "");

    const body = trackBody(ghost);
    const reduced = isMotionReduced();
    body.to({ s: HELD_SCALE, l: 1 }, "hand", { reduced });
    const c: Carry = {
      pointerId: held.pointerId,
      cardId: held.cardId,
      source,
      ghost,
      body,
      home,
      grab: { x: event.clientX - seen.left, y: event.clientY - seen.top },
      hand: new HandTracker(event.clientX, event.clientY),
      spots,
      reduced,
      near: null,
      onto: null,
      uprightTimer: undefined,
    };
    carry = c;
    copies.add(c);
    page.addEventListener("lostpointercapture", onLostCapture);
    followHand(c, event.clientX, event.clientY);
  };

  // ---------- The pointer and the keys ----------

  /** Runs when the system took the pointer away from the page other than by letting it go. */
  function onLostCapture(event: PointerEvent): void {
    if (carry !== null && event.pointerId === carry.pointerId) cancelCarry(carry, true);
  }

  function onPointerMove(event: PointerEvent): void {
    if (carry !== null) {
      if (event.pointerId === carry.pointerId) followHand(carry, event.clientX, event.clientY);
      return;
    }
    if (press === null || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) <= LIFT_DISTANCE) {
      return;
    }
    liftCard(event);
  }

  function onPointerUp(event: PointerEvent): void {
    if (carry !== null) {
      if (event.pointerId === carry.pointerId) dropCarry(carry);
      return;
    }
    if (press !== null && event.pointerId === press.pointerId) {
      press = null;
      stopListening();
    }
  }

  function onPointerCancel(event: PointerEvent): void {
    if (carry !== null) {
      if (event.pointerId === carry.pointerId) cancelCarry(carry, true);
      return;
    }
    if (press !== null && event.pointerId === press.pointerId) {
      press = null;
      stopListening();
    }
  }

  /** Sends the card home on Esc while a card is in the hand, and keeps the key from reaching anything else. */
  function onKeyDown(event: KeyboardEvent): void {
    if (carry === null || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelCarry(carry, false);
  }

  /** Sends the card home when the window loses the focus or is hidden: the pointer's release may never arrive. */
  function onWindowAway(): void {
    if (carry !== null) cancelCarry(carry, true);
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

  /** Starts a press when the primary button goes down on a card that may be carried. Below `LIFT_DISTANCE` of travel it stays a click. */
  const onPointerDown = (event: PointerEvent): void => {
    const options = readOptions();
    if (options.disabled || event.button !== 0 || !event.isPrimary) return;
    if (carry !== null || press !== null) return;
    const { target } = event;
    if (!(target instanceof Element) || target.closest(NO_CARRY_SELECTOR) !== null) return;
    const element = readCardElement(target);
    const cardId = element?.dataset["cardId"];
    if (element === null || cardId === undefined || !options.canCarry(cardId)) return;
    press = {
      pointerId: event.pointerId,
      cardId,
      element,
      startX: event.clientX,
      startY: event.clientY,
    };
    startListening();
  };

  page.addEventListener("pointerdown", onPointerDown);

  return {
    destroy: () => {
      page.removeEventListener("pointerdown", onPointerDown);
      press = null;
      window.clearTimeout(railTimer);
      if (carry !== null) abandonCarry(carry);
      else stopListening();
      // The user chose this drop, so it is sent even though its landing will not play.
      if (landing !== null) {
        window.clearTimeout(landing.timer);
        const { carry: c, target } = landing;
        landing = null;
        readOptions().onDropOnTarget(c.cardId, target);
      }
      for (const c of copies) {
        revealSource(c);
        removeCopy(c);
      }
      const rail = readRail();
      if (rail !== null) resetRail(rail);
      setView(null);
    },
  };
};

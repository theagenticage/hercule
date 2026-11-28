/**
 * The flight of a mark between a screen and a place in the sidebar: a copy of
 * the mark leaves along an arc and shrinks, so the eye sees where something
 * went, and the place takes the small knock and the wash of a thing received.
 * Undo flies the copy home. The copy lives in a layer over the whole window,
 * because the sidebar is outside every screen.
 *
 * A place in the sidebar is named by the attribute `data-motion-target` on
 * its row, so a screen finds it without importing the shell. The row's icon
 * (its `svg`) is where the mark lands.
 */
import "./sidebar-flight.css";
import { copyElementWithoutIds } from "./copy-element";
import { knockElement } from "./knock";
import { ensureOverlayLayer, ghostElement } from "./layout";
import { isMotionReduced } from "./reduced";

/** The places in the sidebar that a mark can fly to. */
export type SidebarTargetName = "overview";

/** The attribute that gives a sidebar row its name. */
const TARGET_ATTRIBUTE = "data-motion-target";

/** The class of the layer over the window that holds the marks in flight. */
const LAYER_CLASS = "motion-flights";

/** A flight takes 0.75 ms a pixel, but never less than 420 ms or more than 760 ms. */
const SHORTEST_FLIGHT = 420;
const LONGEST_FLIGHT = 760;
const FLIGHT_MS_PER_PIXEL = 0.75;

/** A flight home is short, so the page answers at once. */
const HOME_FLIGHT = 240;

/** The arc rises 22% of the distance, up to 90 pixels, and the path is drawn in this many steps. */
const ARC_RISE_RATIO = 0.22;
const LONGEST_ARC_RISE = 90;
const ARC_STEPS = 24;

/** A mark at the sidebar is 55% of its size. */
const SMALLEST_SCALE = 0.55;

/** The mark left behind is this opaque while its copy is away. */
const BEHIND_OPACITY = 0.4;

/** How fast the icon is pushed down when something lands on it, in pixels a second. */
const RECEIPT_KNOCK_SPEED = 110;

/** How long the wash on the row takes to fade, with and without Reduce motion. */
const WASH_MS = 640;
const WASH_REDUCED_MS = 400;

/** The easing of the flight: slow to leave, quick to arrive, so the contact is clear. */
const FLIGHT_EASE = "cubic-bezier(.3,0,.8,.7)";

/** A flight that is under way, or that was not drawn. */
export interface SidebarFlight {
  /** Stops everything the flight started and removes what it drew. Safe to call at any time, any number of times. */
  readonly cancel: () => void;
  /** How many milliseconds from the call until the mark has landed. 0 when no flight is drawn. */
  readonly ms: number;
}

const NO_FLIGHT: SidebarFlight = { cancel: () => {}, ms: 0 };

/** The row of a sidebar place and its icon, as drawn now. */
interface Target {
  readonly row: HTMLElement;
  readonly icon: Element;
  readonly iconRect: DOMRect;
}

/**
 * Returns the sidebar place `name`, or `null` when it cannot be flown to: the
 * sidebar does not show it (it is hidden, or another face of the shell is
 * open), or the icon takes no room.
 */
const findTarget = (name: SidebarTargetName): Target | null => {
  const row = document.querySelector<HTMLElement>(`[${TARGET_ATTRIBUTE}="${name}"]`);
  const icon = row?.querySelector("svg");
  if (row == null || icon == null) return null;
  const iconRect = icon.getBoundingClientRect();
  return iconRect.width === 0 || iconRect.height === 0 ? null : { row, icon, iconRect };
};

/** Removes `element` from the flight layer, and the layer when it was the last in it. */
const removeFromLayer = (element: HTMLElement): void => {
  const layer = element.parentElement;
  element.remove();
  if (layer?.classList.contains(LAYER_CLASS) === true && layer.childElementCount === 0) {
    layer.remove();
  }
};

/** What a flight started, so cancelling it can stop and remove all of it. */
interface FlightParts {
  readonly animations: Animation[];
  readonly elements: HTMLElement[];
  readonly dispose: () => void;
}

const createFlightParts = (): FlightParts => {
  const animations: Animation[] = [];
  const elements: HTMLElement[] = [];
  return {
    animations,
    elements,
    dispose: () => {
      for (const animation of animations.splice(0)) {
        // A cancelled animation must not run its end handler: that would play the receipt of a flight that never landed.
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
      }
      for (const element of elements.splice(0)) removeFromLayer(element);
    },
  };
};

/**
 * Plays the receipt at the sidebar place `name`: its icon takes a small knock
 * and a wash of the accent fades over its row. Under Reduce motion there is
 * only the wash, and it is shorter. Does nothing when the place is gone.
 */
const playReceipt = (name: SidebarTargetName, parts: FlightParts, reduced: boolean): void => {
  const target = findTarget(name);
  if (target === null) return;
  if (!reduced) parts.animations.push(knockElement(target.icon, RECEIPT_KNOCK_SPEED));
  const row = target.row.getBoundingClientRect();
  const wash = document.createElement("div");
  wash.className = "motion-wash";
  Object.assign(wash.style, {
    left: `${row.left}px`,
    top: `${row.top}px`,
    width: `${row.width}px`,
    height: `${row.height}px`,
  });
  ensureOverlayLayer(document.body, LAYER_CLASS).append(wash);
  parts.elements.push(wash);
  const fade = wash.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: reduced ? WASH_REDUCED_MS : WASH_MS,
    easing: "ease-out",
  });
  fade.onfinish = () => {
    removeFromLayer(wash);
  };
  parts.animations.push(fade);
};

/**
 * Returns the keyframes of a copy that travels from `start` to `end`, both
 * offsets in pixels from the place the copy is laid at. The path is an arc
 * that rises in the middle. A copy that leaves shrinks to 55% along the way; a
 * copy that returns grows from 55% back to its size. It stays solid until the
 * last 3% of the way, where it fades as it touches down.
 */
const buildArc = (
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  returns: boolean,
): Keyframe[] => {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const rise = Math.min(LONGEST_ARC_RISE, distance * ARC_RISE_RATIO);
  const shrink = 1 - SMALLEST_SCALE;
  return Array.from({ length: ARC_STEPS + 1 }, (_, step) => {
    const t = step / ARC_STEPS;
    const x = start.x + (end.x - start.x) * t;
    const y = start.y + (end.y - start.y) * t - Math.sin(t * Math.PI) * rise;
    const scale = returns ? SMALLEST_SCALE + shrink * t * t : 1 - shrink * t * t;
    return {
      transform: `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${scale.toFixed(3)})`,
      opacity: t > 0.97 ? (1 - t) / 0.03 : 1,
    };
  });
};

/**
 * Dims `mark` while its copy is away: it fades to 40%, stays there, and comes
 * back to full as the copy lands. It starts after `delay` milliseconds.
 */
const dimBehind = (mark: HTMLElement, delay: number, ms: number, parts: FlightParts): void => {
  parts.animations.push(
    mark.animate(
      [
        { opacity: 1 },
        { opacity: BEHIND_OPACITY, offset: 0.15 },
        { opacity: BEHIND_OPACITY, offset: 0.85 },
        { opacity: 1 },
      ],
      { duration: ms, delay },
    ),
  );
};

/**
 * Lays a copy of `mark` over it in the flight layer and flies the copy
 * between the mark and the sidebar place, after `delay` milliseconds. A copy
 * that leaves goes `toTarget`; one that returns comes from the place back to
 * the mark. Calls `onLanded` when the copy has arrived. Returns the flight, or
 * `null` when the mark takes no room.
 */
const launchCopy = (
  mark: HTMLElement,
  target: Target,
  options: {
    readonly toTarget: boolean;
    readonly delay: number;
    readonly parts: FlightParts;
    readonly onLanded?: () => void;
  },
): SidebarFlight | null => {
  const { toTarget, delay, parts, onLanded } = options;
  const markRect = mark.getBoundingClientRect();
  if (markRect.width === 0 || markRect.height === 0) return null;
  const away = {
    x: target.iconRect.left + target.iconRect.width / 2 - (markRect.left + markRect.width / 2),
    y: target.iconRect.top + target.iconRect.height / 2 - (markRect.top + markRect.height / 2),
  };
  const home = { x: 0, y: 0 };
  const distance = Math.hypot(away.x, away.y);
  const ms = toTarget
    ? Math.max(SHORTEST_FLIGHT, Math.min(LONGEST_FLIGHT, distance * FLIGHT_MS_PER_PIXEL))
    : HOME_FLIGHT;
  const copy = ghostElement(
    mark,
    ensureOverlayLayer(document.body, LAYER_CLASS),
    copyElementWithoutIds(mark),
  );
  // The copy lies exactly over the mark until it leaves, so it stays unseen until then.
  copy.style.opacity = "0";
  parts.elements.push(copy);
  const flight = copy.animate(toTarget ? buildArc(home, away, false) : buildArc(away, home, true), {
    duration: ms,
    delay,
    easing: FLIGHT_EASE,
    fill: "forwards",
  });
  flight.onfinish = () => {
    removeFromLayer(copy);
    onLanded?.();
  };
  parts.animations.push(flight);
  dimBehind(mark, delay, ms, parts);
  return { cancel: parts.dispose, ms: delay + ms };
};

/**
 * Flies a copy of `mark` along an arc to the icon of the sidebar place `name`,
 * starting after `delay` milliseconds. It takes 420 to 760 ms by distance and
 * shrinks to 55%; `mark` stays behind, dimmer, while the copy is away. When
 * the copy lands, the place takes the small knock and a wash of the accent
 * fades over its row.
 *
 * Draws nothing when the sidebar does not show the place (it is hidden, or the
 * shell shows another face) or `mark` takes no room. Under Reduce motion no
 * mark flies and the row's wash fades at once, in 400 ms, ignoring `delay`, so
 * it still says where the thing went. Returns the flight, whose `cancel`
 * stops it and removes what it drew.
 */
export const flyToSidebarTarget = (
  mark: HTMLElement,
  name: SidebarTargetName,
  delay = 0,
): SidebarFlight => {
  const target = findTarget(name);
  if (target === null) return NO_FLIGHT;
  const parts = createFlightParts();
  if (isMotionReduced()) {
    playReceipt(name, parts, true);
    return { cancel: parts.dispose, ms: 0 };
  }
  const flight = launchCopy(mark, target, {
    toTarget: true,
    delay,
    parts,
    onLanded: () => {
      playReceipt(name, parts, false);
    },
  });
  return flight ?? NO_FLIGHT;
};

/**
 * Flies a copy of `mark` home from the icon of the sidebar place `name` in
 * 240 ms, growing back to its size, so the page answers at once. It is the
 * reverse of `flyToSidebarTarget`: the mark waits dimmer in its place and is
 * whole as the copy lands. The place takes no receipt.
 *
 * Draws nothing, and returns a flight of 0 ms, when the sidebar does not show
 * the place, `mark` takes no room, or Reduce motion is on. Returns the flight,
 * whose `ms` tells when the mark is home, so the caller can start what follows
 * then.
 */
export const flyHomeFromSidebarTarget = (
  mark: HTMLElement,
  name: SidebarTargetName,
): SidebarFlight => {
  const target = findTarget(name);
  if (target === null || isMotionReduced()) return NO_FLIGHT;
  return (
    launchCopy(mark, target, { toTarget: false, delay: 0, parts: createFlightParts() }) ?? NO_FLIGHT
  );
};

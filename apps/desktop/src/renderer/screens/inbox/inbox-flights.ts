/**
 * The copies of rows that fly (MOTION.md of the Inbox drawing: "Linking, by L
 * or by drag"): a row carried in the hand, and a thing that leaves its row
 * for its member place in a group, or back out of it.
 *
 * A copy is a clone of the row on a layer of its own, so the row in the page
 * can take its new place under it. It moves on the motion kernel's springs
 * and measures where it goes without its own scale and tilt, so its mark
 * lands exactly on the mark of the row.
 */
import {
  animateValue,
  copyElementWithoutIds,
  trackBody,
  type MotionBody,
  type Velocity,
} from "../../app/motion";

/** How long a copy's shadow takes to grow when it is lifted, in milliseconds. */
const SHADOW_GROW_MS = 160;

/** How long a landed copy takes to fade off the row under it, in milliseconds. */
const LANDING_FADE_MS = 120;

const SHADOW_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** Where a row stands, in the pixels of the layer its copy is drawn in. */
export interface LayerPlace {
  readonly left: number;
  readonly top: number;
}

/** A clone of a row on a layer, with the body that moves it. */
export interface RowCopy {
  /** The wrapper that is placed and moved. */
  readonly element: HTMLElement;
  /** The clone of the row inside the wrapper. */
  readonly row: HTMLElement;
  readonly shadow: HTMLElement;
  readonly body: MotionBody;
}

/** A copy that was let go on a row to link it, and waits for the list to draw the link. */
export interface DroppedCopy {
  /** The key of the thing the copy is of. */
  readonly key: string;
  readonly copy: RowCopy;
  /** The speed the hand gave the copy when it let go. */
  readonly speed: Velocity;
  /** Puts the row in the page back at full weight and stops waiting. Called once the flight has taken the copy. */
  readonly release: () => void;
}

/** Classes of a row that only a member of a group has. */
const MEMBER_CLASSES = ["ib-row--member"];

/** Classes of a row that its place in the list gives it and a copy must not keep. */
const PLACE_CLASSES = ["is-current", "is-picked", "is-moving", "is-rising", "is-under", "is-last"];

/**
 * Returns a copy of `source` that looks like the row of a thing on its own, or
 * as a member of a group when `isMember`. It has no ids and no data, so no
 * query for rows finds it, and it loses its tick, its place in the list and
 * the motion `source` has now.
 */
export const buildRowCopy = (source: HTMLElement, isMember: boolean): RowCopy => {
  const row = copyElementWithoutIds(source);
  row.removeAttribute("style");
  row.removeAttribute("tabindex");
  row.removeAttribute("role");
  row.classList.remove(...PLACE_CLASSES);
  if (isMember) row.classList.add(...MEMBER_CLASSES);
  else row.classList.remove(...MEMBER_CLASSES, "is-outside-query");
  row.querySelector(".ib-row-tick")?.classList.remove("is-on");
  const shadow = document.createElement("span");
  shadow.className = "ib-copy-shadow";
  const element = document.createElement("div");
  element.className = "ib-copy";
  element.append(shadow, row);
  return { element, row, shadow, body: trackBody(element) };
};

/** Puts `copy` in `layer` at `place`, `width` pixels wide and a row tall. */
export const placeCopy = (
  layer: HTMLElement,
  copy: RowCopy,
  place: LayerPlace,
  width: number,
  height: number,
): void => {
  Object.assign(copy.element.style, {
    left: `${String(place.left)}px`,
    top: `${String(place.top)}px`,
    width: `${String(width)}px`,
    height: `${String(height)}px`,
  });
  layer.append(copy.element);
};

/** Returns where `copy` stands in its layer, without the offset its body shows. */
export const readCopyPlace = (copy: RowCopy): LayerPlace => ({
  left: Number.parseFloat(copy.element.style.left),
  top: Number.parseFloat(copy.element.style.top),
});

/** Shows the shadow of `copy`, growing it in when `isAnimated`. */
export const raiseShadow = (copy: RowCopy, isAnimated: boolean): void => {
  copy.shadow.style.opacity = "1";
  if (isAnimated) {
    copy.shadow.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: SHADOW_GROW_MS,
      easing: SHADOW_EASING,
    });
  }
};

/**
 * Calls `then` once no row of `scroll` is moving, which is at once when none
 * is, and returns a function that stops waiting. A frame asks for the next
 * only while a row moves.
 */
export const whenRowsRest = (scroll: HTMLElement, then: () => void): (() => void) => {
  let frame = 0;
  const check = (): void => {
    frame = 0;
    if (scroll.querySelector(".ib-row.is-moving") === null) then();
    else frame = requestAnimationFrame(check);
  };
  check();
  return () => {
    cancelAnimationFrame(frame);
  };
};

/** What `flyCopyIntoPlace` is given. */
export interface FlightOptions {
  /** The scroll area of the list, whose rows the landed copy waits for. */
  readonly scroll: HTMLElement;
  /** The row in the page that the thing lands on. It is hidden until the copy lands. */
  readonly row: HTMLElement;
  readonly copy: RowCopy;
  /** Where the row rests, in the pixels of the layer the copy is in. */
  readonly goal: LayerPlace;
  /** True when the copy has a shadow while it flies. The row a drop landed on moves quietly, with none. */
  readonly isLoud: boolean;
  /** The speed the hand gave the copy, when it is let go from the hand. */
  readonly speed?: Velocity | undefined;
}

/**
 * Flies `copy` to `goal` on `travel`, box to box: its left padding rides the
 * same spring to the row's, so its mark lands on the row's mark and its
 * columns on the row's columns. The row in the page is hidden meanwhile. When
 * the copy lands, the row appears under it. The copy stays whole on top
 * while rows still cross under it, then its shadow sinks and it fades off the
 * row in 120 ms.
 */
export const flyCopyIntoPlace = ({
  scroll,
  row,
  copy,
  goal,
  isLoud,
  speed,
}: FlightOptions): void => {
  const { element, body } = copy;
  const origin = readCopyPlace(copy);
  const rowBody = trackBody(row);
  rowBody.clear();
  rowBody.set({ o: 0 });
  element.classList.remove("is-over");
  element.classList.toggle("is-solid", isLoud);
  if (isLoud) raiseShadow(copy, false);
  else copy.shadow.style.opacity = "0";
  const padding = animateValue(
    Number.parseFloat(getComputedStyle(copy.row).paddingLeft),
    (value) => {
      copy.row.style.paddingLeft = `${value.toFixed(2)}px`;
    },
  );
  padding.to(Number.parseFloat(getComputedStyle(row).paddingLeft), "travel");
  if (speed !== undefined) body.relocate(body.values.x, body.values.y, speed);
  const land = (): void => {
    rowBody.clear();
    whenRowsRest(scroll, () => {
      copy.shadow.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: LANDING_FADE_MS,
        easing: "ease-out",
        fill: "forwards",
      });
      const fade = element.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: LANDING_FADE_MS,
        easing: "ease-out",
        fill: "forwards",
      });
      const remove = (): void => {
        body.clear();
        element.remove();
      };
      void fade.finished.then(remove, remove);
    });
  };
  body.to({ x: goal.left - origin.left, y: goal.top - origin.top, s: 1, r: 0 }, "travel", {
    done: land,
  });
};

/**
 * Brings the row of a group that just appeared in from 98.5% on `hand`, under
 * the rows that are still moving past it, which uncover it.
 */
export const growRow = (row: HTMLElement): void => {
  row.classList.add("is-under");
  const body = trackBody(row);
  body.set({ s: 0.985 });
  body.to({ s: 1 }, "hand", {
    done: () => {
      body.clear();
      row.classList.remove("is-under");
    },
  });
  row.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 140,
    easing: "ease-out",
    fill: "backwards",
  });
};

/**
 * Lays the members of a group that just opened under the list, at full
 * opacity, like a drawer: the rows below, which carry the list's ground while
 * they move, slide down off them. The members come out from under the list
 * once no row moves.
 */
export const openDrawer = (scroll: HTMLElement, members: ReadonlyArray<HTMLElement>): void => {
  for (const member of members) member.classList.add("is-under");
  whenRowsRest(scroll, () => {
    for (const member of members) member.classList.remove("is-under");
  });
};

/** Takes the copy that was let go out of the page at once, and puts the row it was lifted from back. */
export const discardDroppedCopy = (dropped: DroppedCopy): void => {
  dropped.release();
  dropped.copy.body.clear();
  dropped.copy.element.remove();
};

/**
 * Fades the copy that was let go where it is, in 120 ms, and puts the row it
 * was lifted from back. For a link that left the thing with no row of its own,
 * such as one into a group that stays folded.
 */
export const fadeOutDroppedCopy = (dropped: DroppedCopy): void => {
  dropped.release();
  const { element, body } = dropped.copy;
  const remove = (): void => {
    body.clear();
    element.remove();
  };
  const fade = element.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: LANDING_FADE_MS,
    easing: "ease-out",
    fill: "forwards",
  });
  void fade.finished.then(remove, remove);
};

/**
 * Linking by drag (MOTION.md of the Inbox drawing: "Linking, by L or by
 * drag"). A press on a thing's row that moves 6px lifts a copy of the row into
 * a layer of its own. The copy follows the pointer one to one, leans with the
 * hand's speed, and straightens when the hand is still. The row under it lights
 * with a ring. Letting go on a row links the two things; Esc, or letting go
 * anywhere else, sends the copy home on `travel`.
 *
 * Everything the carry touches outside React (the copy, the marks on the rows
 * in the page) is made, moved and removed here. Marks are data attributes,
 * which React never rewrites. Nothing runs while no row is in the hand: the
 * pointer is not watched, and no timer is set. A row in the hand never asks
 * React to draw again.
 */
import {
  HandTracker,
  isMotionReduced,
  measureLayoutRect,
  swallowNextClick,
  trackCarryGesture,
  type Velocity,
} from "../../app/motion";
import {
  buildRowCopy,
  discardDroppedCopy,
  fadeOutDroppedCopy,
  placeCopy,
  raiseShadow,
  readCopyPlace,
  type DroppedCopy,
  type RowCopy,
} from "./inbox-flights";

/** How far the pointer moves, in pixels, before a press becomes a carry. Up to this far is a click. */
const LIFT_DISTANCE = 6;

/** How much bigger a row is in the hand. */
const CARRY_SCALE = 1.02;

/** The most a carried row leans, in degrees, to either side. */
const MOST_LEAN = 2.5;

/** Degrees of lean for each pixel per millisecond of the hand's sideways speed. */
const LEAN_PER_SPEED = 1.25;

/** How long the hand must be still, in milliseconds, before the row stands up straight. */
const STRAIGHTEN_AFTER_MS = 90;

/** How long a dropped copy waits for the written link to show in the list, in milliseconds, before it fades away. */
const LINK_WAIT_MS = 3000;

/** The attribute on the page's root that tells the stylesheet a row is in the hand. */
const CARRYING_ATTRIBUTE = "data-ib-carrying";

/** The selector of a row that may be carried or dropped on: a thing's row or a group's head, never a "Show N more" line. */
const LINKABLE_ROW = ".ib-row[data-ref]:not(.ib-group-more)";

/** What the carry gesture is given. */
export interface InboxDragOptions {
  /** The list's scroll area. It holds the pointer for the whole gesture, and every row is under it. */
  readonly scroll: HTMLElement;
  /** The layer the copy in the hand is drawn in: the whole window. */
  readonly carryLayer: HTMLElement;
  /**
   * Holds the copy that was let go on a row and waits for the list to draw the
   * link, which the list's motion then flies into its place. It holds `null`
   * while no copy waits.
   */
  readonly dropped: { current: DroppedCopy | null };
  /**
   * Links the thing `fromKey` with the thing or group `toKey`. Returns whether
   * a link was written: `false` sends the copy home.
   */
  readonly linkRows: (fromKey: string, toKey: string) => Promise<boolean>;
}

/** What a press picked up. */
interface Pressed {
  readonly row: HTMLElement;
  readonly key: string;
}

/** A row in the hand. */
interface Carry extends Pressed {
  readonly copy: RowCopy;
  readonly hand: HandTracker;
  /** Where the pointer held the row, from the row's top left. */
  readonly grab: { readonly x: number; readonly y: number };
  /** Where the row stands in the page, in window pixels. */
  readonly home: { readonly left: number; readonly top: number };
  /** The row under the copy that a drop would link to, or `null`. */
  target: HTMLElement | null;
  straightenTimer: number | undefined;
}

/** Puts the row `row` back at full weight in the page. */
const putRowDown = (row: HTMLElement): void => {
  delete row.dataset["lifted"];
};

/**
 * Sends `copy` back to where `row` stands now, on `travel`, with `speed`, then
 * removes it and puts the row back at full weight. Under Reduce motion it is
 * gone at once.
 */
export const sendCopyHome = (copy: RowCopy, row: HTMLElement, speed: Velocity): void => {
  const layer = copy.element.parentElement;
  if (layer === null) {
    putRowDown(row);
    return;
  }
  const finish = (): void => {
    copy.body.clear();
    copy.element.remove();
    putRowDown(row);
  };
  const home = measureLayoutRect(row);
  const place = readCopyPlace(copy);
  const at = layer.getBoundingClientRect();
  copy.element.classList.remove("is-over");
  copy.body.relocate(copy.body.values.x, copy.body.values.y, speed);
  copy.body.to(
    { x: home.left - at.left - place.left, y: home.top - at.top - place.top, s: 1, r: 0 },
    "travel",
    { done: finish },
  );
};

/**
 * Starts the carry gesture on `options.scroll` and returns `destroy`, which
 * stops listening and, if a row is in the hand or a copy waits to fly, puts
 * the page back as it was.
 */
export const createInboxDrag = (options: InboxDragOptions): { readonly destroy: () => void } => {
  const { scroll, carryLayer, dropped } = options;
  let waitTimer: number | undefined;

  /** Returns the row a drop at this point of the window would link to, or `null`. */
  const findTarget = (carry: Carry, x: number, y: number): HTMLElement | null => {
    const found = document.elementFromPoint(x, y)?.closest<HTMLElement>(LINKABLE_ROW) ?? null;
    if (found === null || !scroll.contains(found) || found.closest(".ib-leaving") !== null) {
      return null;
    }
    return found.dataset["ref"] === carry.key ? null : found;
  };

  const markTarget = (carry: Carry, target: HTMLElement | null): void => {
    if (target === carry.target) return;
    if (carry.target !== null) delete carry.target.dataset["drop"];
    carry.target = target;
    if (target !== null) target.dataset["drop"] = "";
    carry.copy.element.classList.toggle("is-over", target !== null);
  };

  /** Takes every mark of the carry off the page, except the lifted row. */
  const endCarry = (carry: Carry): void => {
    window.clearTimeout(carry.straightenTimer);
    markTarget(carry, null);
    document.documentElement.removeAttribute(CARRYING_ATTRIBUTE);
  };

  const gesture = trackCarryGesture<Pressed, Carry>({
    element: scroll,
    liftDistance: LIFT_DISTANCE,
    lean: { perSpeed: LEAN_PER_SPEED, most: MOST_LEAN },
    readPressed: (event) => {
      if (dropped.current !== null || !(event.target instanceof Element)) return null;
      const row = event.target.closest<HTMLElement>(LINKABLE_ROW);
      // A group's head is only ever dropped on. A press on a row's own buttons is that button's.
      if (
        row === null ||
        row.classList.contains("ib-row--group") ||
        event.target.closest("button, a") !== null ||
        row.closest(".ib-leaving") !== null
      ) {
        return null;
      }
      return { row, key: row.dataset["ref"]! };
    },
    lift: ({ row, key }, event) => {
      const rect = measureLayoutRect(row);
      const layer = carryLayer.getBoundingClientRect();
      const copy = buildRowCopy(row, row.classList.contains("ib-row--member"));
      placeCopy(
        carryLayer,
        copy,
        { left: rect.left - layer.left, top: rect.top - layer.top },
        rect.width,
        rect.height,
      );
      copy.element.classList.add("is-solid");
      row.dataset["lifted"] = "";
      document.documentElement.setAttribute(CARRYING_ATTRIBUTE, "");
      const isStill = isMotionReduced();
      raiseShadow(copy, !isStill);
      if (!isStill) copy.body.to({ s: CARRY_SCALE }, "hand");
      return {
        row,
        key,
        copy,
        hand: new HandTracker(event.clientX, event.clientY),
        grab: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        home: { left: rect.left, top: rect.top },
        target: null,
        straightenTimer: undefined,
      };
    },
    move: (carry, event) => {
      const { hand, copy } = carry;
      hand.moveTo(event.clientX, event.clientY);
      copy.body.follow(
        event.clientX - carry.grab.x - carry.home.left,
        event.clientY - carry.grab.y - carry.home.top,
      );
      if (!isMotionReduced()) {
        copy.body.to({ r: hand.readLean(LEAN_PER_SPEED, MOST_LEAN) }, "hand");
        window.clearTimeout(carry.straightenTimer);
        carry.straightenTimer = window.setTimeout(() => {
          copy.body.to({ r: 0 }, "hand");
        }, STRAIGHTEN_AFTER_MS);
      }
      markTarget(carry, findTarget(carry, event.clientX, event.clientY));
    },
    drop: (carry) => {
      swallowNextClick(true);
      const { target, copy, row, key } = carry;
      const toKey = target?.dataset["ref"];
      const speed = carry.hand.readThrow();
      endCarry(carry);
      if (toKey === undefined) {
        sendCopyHome(copy, row, speed);
        return;
      }
      // The copy waits where it was let go. The list flies it into the group once the link is drawn.
      const waiting: DroppedCopy = {
        key,
        copy,
        speed,
        isLinked: false,
        release: () => {
          window.clearTimeout(waitTimer);
          if (dropped.current === waiting) dropped.current = null;
          putRowDown(row);
        },
      };
      dropped.current = waiting;
      const goHome = (): void => {
        if (dropped.current !== waiting) return;
        waiting.release();
        sendCopyHome(copy, row, speed);
      };
      // A link that was written but never changed the list leaves nothing to fly to, and the copy must not go
      // home while the undo line says "Linked": it fades where it is.
      const fadeAway = (): void => {
        if (dropped.current !== waiting) return;
        dropped.current = null;
        fadeOutDroppedCopy(waiting);
      };
      void options.linkRows(key, toKey).then((isLinked) => {
        if (!isLinked) {
          goHome();
          return;
        }
        waiting.isLinked = true;
        waitTimer = window.setTimeout(fadeAway, LINK_WAIT_MS);
      }, goHome);
    },
    cancel: (carry, isPointerUp) => {
      swallowNextClick(isPointerUp);
      endCarry(carry);
      sendCopyHome(carry.copy, carry.row, carry.hand.readThrow());
    },
  });

  return {
    destroy: () => {
      const carry = gesture.destroy();
      if (carry !== null) {
        endCarry(carry);
        carry.copy.body.clear();
        carry.copy.element.remove();
        putRowDown(carry.row);
      }
      const waiting = dropped.current;
      if (waiting !== null) discardDroppedCopy(waiting);
    },
  };
};

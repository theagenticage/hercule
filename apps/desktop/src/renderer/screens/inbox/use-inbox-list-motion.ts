/**
 * The motion of the Inbox list's rows when the rows change (MOTION.md of the
 * Inbox drawing: "A row leaving", "Arrivals: the N new bar").
 *
 * Rows are all one height and sit one under the other, so where a row was and
 * where it is now follow from its index alone. The hook therefore reads
 * nothing from the page but the drawn rows' elements:
 *
 * - A row that leaves is drawn again as a copy in the layer under the list
 *   (`ghosts`), which fades out in 110 ms. A dismissed row also slides 28 px
 *   aside on `travel`.
 * - The rows after it close up on `hand`, starting 70 ms later so the copy is
 *   almost gone. When rows are still moving from an earlier change, they close
 *   up at once.
 * - A row that comes back (undo) lies under the list and returns from 28 px
 *   aside on `travel`, while the rows after it part off it.
 * - A row the user took in with "Show" comes down 20 px on `travel`, 40 ms
 *   after the one before it, with a marigold wash that fades over 1.8 s.
 *
 * Only rows on screen move. Under Reduce motion nothing moves and every
 * change applies at once, in the same order. Opacity is a short fade of its
 * own, never a spring, so no words read through other words.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { findBody, isMotionReduced, trackBody } from "../../app/motion";
import type { InboxListEntry } from "./inbox-list-entry";

/** How the rows that left in a change went: dismissed rows slide aside as they fade. */
export type InboxLeaveHow = "dismiss" | "taken";

/** The copy of a row that left, drawn under the list while it fades. */
export interface LeavingRow {
  /** Tells copies apart, because the same row may leave twice (dismiss, undo, dismiss). */
  readonly id: number;
  readonly entry: InboxListEntry;
  /** Where the row stood, in pixels from the top of the rows. */
  readonly top: number;
  readonly how: InboxLeaveHow;
}

/** How long a leaving row's copy takes to fade, in milliseconds. */
export const LEAVE_FADE_MS = 110;

/** How long the rows after a leaving row wait, so its copy is almost gone before they cover it. */
const CLOSE_UP_DELAY_MS = 70;

/** How far a dismissed row slides, and a returning row starts, in pixels. */
export const ASIDE_PX = 28;

/** How far above its place an arrival starts, in pixels. */
const ARRIVAL_DROP_PX = 20;

/** The delay between arrivals, in milliseconds. */
const ARRIVAL_STAGGER_MS = 40;

/** How long the list scrolls to the first arrival before the arrivals come down, in milliseconds. */
const ARRIVAL_AFTER_SCROLL_MS = 220;

/** How long an arrival's marigold wash lasts, in milliseconds. */
const WASH_MS = 1800;

/** The part of the wash's time its full colour holds before it fades. */
const WASH_HOLD = 0.3;

/** A row that moved by less than this many pixels is not drawn moving. */
const BUSY_PX = 0.5;

export const FADE_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** What the last render drew, which the next change is told apart from. */
interface DrawnRows {
  readonly listId: string;
  readonly rows: ReadonlyArray<InboxListEntry>;
}

/** Collects the drawn rows' elements under `scroll`, by the key of their entry. */
const collectDrawnRows = (scroll: HTMLElement): Map<string, HTMLElement> =>
  new Map(
    [...scroll.querySelectorAll<HTMLElement>("[data-ref]")].flatMap((element) => {
      const ref = element.dataset["ref"];
      return ref === undefined || element.closest(".ib-leaving") !== null
        ? []
        : [[ref, element] as const];
    }),
  );

/** Plays an arrival's or a return's own short fade, which holds the row's first frame through `delay`. */
const fadeIn = (element: HTMLElement, delay: number, duration: number): void => {
  element.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration,
    delay,
    easing: "ease-out",
    fill: "backwards",
  });
};

/** Washes an arrival in marigold, which fades to nothing. */
const washIn = (element: HTMLElement, delay: number): void => {
  element.animate(
    [
      { background: "color-mix(in oklab, var(--you) 16%, transparent)", offset: 0 },
      { background: "color-mix(in oklab, var(--you) 16%, transparent)", offset: WASH_HOLD },
      { background: "transparent", offset: 1 },
    ],
    { duration: WASH_MS, delay, easing: "ease-out", fill: "backwards" },
  );
};

/** Brings a row that came back from a dismissal in from the side, under the rows that part off it. */
const returnRow = (element: HTMLElement): void => {
  element.classList.add("is-under");
  const body = trackBody(element);
  body.set({ x: ASIDE_PX });
  body.to({ x: 0 }, "travel", {
    done: () => {
      body.clear();
      element.classList.remove("is-under");
    },
  });
  fadeIn(element, 0, 140);
};

/** Brings the arrival at `order` down into its place. */
const arriveRow = (element: HTMLElement, order: number): void => {
  const delay = ARRIVAL_AFTER_SCROLL_MS + order * ARRIVAL_STAGGER_MS;
  const body = trackBody(element);
  body.set({ y: -ARRIVAL_DROP_PX });
  body.to({ y: 0 }, "travel", { delay, done: () => body.clear() });
  fadeIn(element, delay, 160);
  washIn(element, delay);
};

/**
 * Plays the motion of the change from the rows drawn before to `rows`, and
 * returns the copies of rows that left, which the list draws under its rows,
 * with `removeLeavingRow` for each copy to call when its fade has ended.
 *
 * `listId` names what the list shows: when it changes, the new rows show at
 * once. `rowHeight` is every row's height in pixels. `scrollRef` is the
 * scroll element that holds the drawn rows, each with its thing's reference
 * in `data-ref`. `leaveHow` says how the rows that left in this change went,
 * `returning` names the rows an undo put back, and `arriving` the rows "Show"
 * took in, in the order they come down.
 */
export function useInboxListMotion({
  rows,
  listId,
  rowHeight,
  scrollRef,
  leaveHow,
  returning,
  arriving,
}: {
  readonly rows: ReadonlyArray<InboxListEntry>;
  readonly listId: string;
  readonly rowHeight: number;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly leaveHow: InboxLeaveHow;
  readonly returning: ReadonlyArray<string>;
  readonly arriving: ReadonlyArray<string>;
}): {
  readonly leavingRows: ReadonlyArray<LeavingRow>;
  readonly removeLeavingRow: (id: number) => void;
} {
  const [leavingRows, setLeavingRows] = useState<ReadonlyArray<LeavingRow>>([]);
  const drawn = useRef<DrawnRows | null>(null);
  const nextId = useRef(0);

  useLayoutEffect(() => {
    const was = drawn.current;
    drawn.current = { listId, rows };
    if (was === null || was.rows === rows) return;
    if (was.listId !== listId) {
      setLeavingRows((held) => (held.length === 0 ? held : []));
      return;
    }
    const scroll = scrollRef.current;
    if (scroll === null || isMotionReduced()) return;

    const wasIndex = new Map(was.rows.map((entry, index) => [entry.key, index] as const));
    const nowIndex = new Map(rows.map((entry, index) => [entry.key, index] as const));
    const elements = collectDrawnRows(scroll);

    // Rows still sliding from the last change are read before anything is written.
    const isBusy = [...elements.values()].some(
      (element) => Math.abs(findBody(element)?.values.y ?? 0) > BUSY_PX,
    );

    const viewTop = scroll.scrollTop;
    const viewBottom = viewTop + scroll.clientHeight;
    const left = was.rows.flatMap((entry, index): LeavingRow[] => {
      const top = index * rowHeight;
      if (nowIndex.has(entry.key) || top + rowHeight <= viewTop || top >= viewBottom) return [];
      nextId.current += 1;
      return [{ id: nextId.current, entry, top, how: leaveHow }];
    });
    const closeUpDelay = left.length > 0 && !isBusy ? CLOSE_UP_DELAY_MS : 0;

    const returningRefs = new Set(returning);
    for (const [ref, element] of elements) {
      const before = wasIndex.get(ref);
      const now = nowIndex.get(ref);
      if (now === undefined) continue;
      if (before === undefined) {
        if (returningRefs.has(ref)) returnRow(element);
        else if (arriving.includes(ref)) arriveRow(element, arriving.indexOf(ref));
        continue;
      }
      if (before === now) continue;
      // The layout moved the row; the offset keeps it where it looked, then it closes up.
      const body = trackBody(element);
      body.relocate(body.values.x, body.values.y + (before - now) * rowHeight);
      body.to({ x: 0, y: 0 }, "hand", { delay: closeUpDelay });
    }
    if (left.length > 0) {
      setLeavingRows((held) => [...held, ...left]);
    }
  }, [rows, listId, rowHeight, scrollRef, leaveHow, returning, arriving]);

  const removeLeavingRow = (id: number): void => {
    setLeavingRows((held) => held.filter((row) => row.id !== id));
  };
  return { leavingRows, removeLeavingRow };
}

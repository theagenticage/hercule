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
 * - A thing that leaves its row for its member place in a group, or back out
 *   of one, flies there as a copy of itself (`flyCopyIntoPlace`); a group's row
 *   that appears grows in; members that appear lie under the list like a
 *   drawer while the rows below slide off them (MOTION.md: "Linking" and
 *   "Groups folding"). A copy that was let go on a row (`droppedRef`) is the
 *   one that flies for its own thing.
 *
 * Only rows on screen move. Under Reduce motion nothing moves and every
 * change applies at once, in the same order. Opacity is a short fade of its
 * own, never a spring, so no words read through other words.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { findBody, isMotionReduced, trackBody } from "../../app/motion";
import {
  buildRowCopy,
  discardDroppedCopy,
  fadeOutDroppedCopy,
  flyCopyIntoPlace,
  growRow,
  openDrawer,
  placeCopy,
  raiseShadow,
  type DroppedCopy,
} from "./inbox-flights";
import { buildEntryTops } from "./inbox-entry-tops";
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

/** A thing that would fly further than this many pixels takes its place at once: nobody could follow the journey. */
const LONGEST_FLIGHT_PX = 1400;

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

/** Returns, for each member of a group among `entries`, the key of the group's head. */
const readMemberGroups = (entries: ReadonlyArray<InboxListEntry>): Map<string, string> => {
  const groups = new Map<string, string>();
  let head: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "head") head = entry.key;
    else if (entry.kind === "member" && head !== undefined) groups.set(entry.key, head);
  }
  return groups;
};

/**
 * Returns the keys of the things that move between rows in the change from
 * `was` to `rows`: a thing that joined a group (or went to another), and a
 * member that left its group. The row of a thing keeps its key whatever it is
 * drawn as.
 */
const findFlyingThings = (
  was: ReadonlyArray<InboxListEntry>,
  rows: ReadonlyArray<InboxListEntry>,
  wasIndex: ReadonlyMap<string, number>,
): Set<string> => {
  const wasGroups = readMemberGroups(was);
  const nowGroups = readMemberGroups(rows);
  const flying = new Set<string>();
  for (const entry of rows) {
    const before = wasIndex.get(entry.key);
    if (before === undefined || (entry.kind !== "thing" && entry.kind !== "member")) continue;
    const old = was[before]!;
    if (
      (old.kind !== "thing" && old.kind !== "member") ||
      wasGroups.get(entry.key) === nowGroups.get(entry.key)
    ) {
      continue;
    }
    flying.add(entry.key);
  }
  return flying;
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
 * took in, in the order they come down. `flightsRef` is the layer over the
 * rows that copies in flight are drawn in, and `droppedRef` holds the copy that
 * was let go on a row to link and waits for the link to be drawn.
 */
export function useInboxListMotion({
  rows,
  listId,
  rowHeight,
  scrollRef,
  leaveHow,
  returning,
  arriving,
  flightsRef,
  droppedRef,
}: {
  readonly rows: ReadonlyArray<InboxListEntry>;
  readonly listId: string;
  readonly rowHeight: number;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly leaveHow: InboxLeaveHow;
  readonly returning: ReadonlyArray<string>;
  readonly arriving: ReadonlyArray<string>;
  readonly flightsRef: RefObject<HTMLElement | null>;
  readonly droppedRef: RefObject<DroppedCopy | null>;
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
    const dropped = droppedRef.current;
    if (was.listId !== listId) {
      if (dropped !== null) discardDroppedCopy(dropped);
      setLeavingRows((held) => (held.length === 0 ? held : []));
      return;
    }
    const scroll = scrollRef.current;
    const flights = flightsRef.current;
    if (scroll === null || flights === null || isMotionReduced()) {
      if (dropped !== null) discardDroppedCopy(dropped);
      return;
    }

    const wasIndex = new Map(was.rows.map((entry, index) => [entry.key, index] as const));
    const nowIndex = new Map(rows.map((entry, index) => [entry.key, index] as const));
    const wasTops = buildEntryTops(was.rows, rowHeight);
    const nowTops = buildEntryTops(rows, rowHeight);
    const elements = collectDrawnRows(scroll);
    const flying = findFlyingThings(was.rows, rows, wasIndex);

    // Rows still sliding from the last change are read before anything is written.
    const isBusy = [...elements.values()].some(
      (element) => Math.abs(findBody(element)?.values.y ?? 0) > BUSY_PX,
    );

    const viewTop = scroll.scrollTop;
    const viewBottom = viewTop + scroll.clientHeight;
    const left = was.rows.flatMap((entry, index): LeavingRow[] => {
      const top = wasTops[index]!;
      if (nowIndex.has(entry.key) || top + rowHeight <= viewTop || top >= viewBottom) return [];
      nextId.current += 1;
      return [{ id: nextId.current, entry, top, how: leaveHow }];
    });
    const closeUpDelay = left.length > 0 && !isBusy ? CLOSE_UP_DELAY_MS : 0;

    const returningRefs = new Set(returning);
    const drawer: HTMLElement[] = [];
    for (const [ref, element] of elements) {
      const before = wasIndex.get(ref);
      const now = nowIndex.get(ref);
      if (now === undefined || flying.has(ref)) continue;
      if (before === undefined) {
        if (returningRefs.has(ref)) returnRow(element);
        else if (arriving.includes(ref)) arriveRow(element, arriving.indexOf(ref));
        else if (rows[now]!.kind === "head") growRow(element);
        else drawer.push(element);
        continue;
      }
      const delta = wasTops[before]! - nowTops[now]!;
      if (delta === 0) continue;
      // The layout moved the row; the offset keeps it where it looked, then it closes up.
      const body = trackBody(element);
      body.relocate(body.values.x, body.values.y + delta);
      body.to({ x: 0, y: 0 }, "hand", { delay: closeUpDelay });
    }
    if (drawer.length > 0) openDrawer(scroll, drawer);

    // Things that joined a group or left one fly from their old row to their new one.
    for (const key of flying) {
      const row = elements.get(key);
      if (row === undefined) continue;
      const wasEntryIndex = wasIndex.get(key)!;
      const fromTop = wasTops[wasEntryIndex]! + (findBody(row)?.values.y ?? 0);
      const toTop = nowTops[nowIndex.get(key)!]!;
      if (Math.abs(toTop - fromTop) > LONGEST_FLIGHT_PX) continue;
      const isDropped = dropped?.key === key;
      const copy = isDropped
        ? dropped.copy
        : buildRowCopy(row, was.rows[wasEntryIndex]!.kind === "member");
      let goal = { left: 0, top: toTop };
      if (isDropped) {
        // The carried copy keeps flying in the layer over the whole window, so the list's edge never cuts it.
        const rows = flights.getBoundingClientRect();
        const layer = copy.element.parentElement!.getBoundingClientRect();
        goal = { left: rows.left - layer.left, top: rows.top - layer.top + toTop };
        dropped.release();
        droppedRef.current = null;
      } else {
        placeCopy(flights, copy, { left: 0, top: fromTop }, row.offsetWidth, row.offsetHeight);
        // A drop lifts only the thing that was carried: the row it was dropped on moves quietly.
        if (dropped === null) raiseShadow(copy, true);
      }
      flyCopyIntoPlace({
        scroll,
        row,
        copy,
        goal,
        isLoud: dropped === null || isDropped,
        speed: isDropped ? dropped.speed : undefined,
      });
    }
    // A copy let go for a thing that now has no row of its own has nowhere to fly.
    if (droppedRef.current !== null && !nowIndex.has(droppedRef.current.key)) {
      fadeOutDroppedCopy(droppedRef.current);
      droppedRef.current = null;
    }
    if (left.length > 0) {
      setLeavingRows((held) => [...held, ...left]);
    }
  }, [rows, listId, rowHeight, scrollRef, leaveHow, returning, arriving, flightsRef, droppedRef]);

  const removeLeavingRow = (id: number): void => {
    setLeavingRows((held) => held.filter((row) => row.id !== id));
  };
  return { leavingRows, removeLeavingRow };
}

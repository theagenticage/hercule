/**
 * The motion of Intake's rows when the list changes (spec 17 §Motion). A
 * row that leaves fades over `--dur-1`, then the gap closes over `--dur-2`.
 * A row that arrives fades in and drops into place over `--dur-2`, while the
 * rows below make room. Every row of one change starts at once, so a burst
 * of 30 arrivals moves as one block. Only rows on screen move; a change out
 * of view applies at once. Tracking's rows use the same motion, with the gap
 * closing over `--dur-3` (spec 17 §Tracking).
 *
 * The rows move with `transform` and `opacity` only, through the Web
 * Animations API, so the compositor runs each animation and nothing runs
 * once it ends. When `--dur-2` reads as 0, under Reduce motion and in tests
 * with no stylesheet, nothing moves and every change applies at once. So
 * does a change while the window is hidden, which no one would see.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { copyElementWithoutIds, isMotionShown, isOnScreen, type RowPlace } from "./motion-helpers";
import { readMotionDuration, readMotionEasing, type MotionDuration } from "./motion-tokens";

/** The attribute on each drawn item's element that holds its key, so the motion can find it. */
const ITEM_KEY_ATTRIBUTE = "data-item-key";

/** How far above its place an arriving row starts, in pixels, before it drops in. */
const ARRIVAL_DROP = 8;

/** How one row that stays or arrives moves into its place. */
export type RowMove =
  | { readonly key: string; readonly kind: "arrive" }
  /** `offset` is how far the row starts from its new place, in pixels: below it when positive. */
  | { readonly key: string; readonly kind: "slide"; readonly offset: number };

/**
 * Lists the keys of the drawn rows that leave: on screen in `places`, and
 * not among `staying`. A row that leaves out of view goes at once.
 */
export const listLeavingRows = (
  places: ReadonlyMap<string, RowPlace>,
  staying: ReadonlySet<string>,
  viewport: RowPlace,
): ReadonlyArray<string> =>
  [...places]
    .filter(([key, place]) => !staying.has(key) && isOnScreen(place, viewport))
    .map(([key]) => key);

/**
 * Plans how the rows drawn now, at `after`, move into place. `beforeKeys`
 * holds every item before the change, drawn or not, and `before` where each
 * drawn row was.
 *
 * - A row that is new and on screen arrives.
 * - A row that stays slides from where it was, if it moved and shows on
 *   screen before or after.
 * - A row that was not drawn before has no place to start from, so it
 *   shows in its new place at once.
 */
export const planRowMoves = (
  beforeKeys: ReadonlySet<string>,
  before: ReadonlyMap<string, RowPlace>,
  after: ReadonlyMap<string, RowPlace>,
  viewport: RowPlace,
): ReadonlyArray<RowMove> =>
  [...after].flatMap(([key, place]): ReadonlyArray<RowMove> => {
    if (!beforeKeys.has(key)) return isOnScreen(place, viewport) ? [{ key, kind: "arrive" }] : [];
    const was = before.get(key);
    if (was === undefined || was.top === place.top) return [];
    if (!isOnScreen(was, viewport) && !isOnScreen(place, viewport)) return [];
    return [{ key, kind: "slide", offset: was.top - place.top }];
  });

/** A copy of a row that leaves, and where the row was on screen. */
interface LeavingRow {
  readonly key: string;
  readonly copy: HTMLElement;
  readonly place: DOMRect;
}

/**
 * Takes over the exit of a row that leaves on screen, as the caller animates
 * it in its own way, such as a flight to another list. It is called with the
 * row's key, a copy of the row, and where the row stood, in pixels from the
 * window's top left. It returns `true` when it took the row: the copy is
 * then the caller's to place and remove, and the list plays no fade for the
 * row and does not make the rows below wait for one. It returns `false` to
 * leave the row to the fade.
 */
export type RowExitHandler = (key: string, copy: HTMLElement, place: DOMRect) => boolean;

/** The options of `useRowMotion`, which change how a list moves from the Intake default. */
export interface RowMotionOptions {
  /** The duration token the rows that stay take to slide. `--dur-2` when left out. */
  readonly slide?: MotionDuration | undefined;
  /** Takes over the exit of a row that leaves on screen. The list fades such a row when left out. */
  readonly takeLeavingRow?: RowExitHandler | undefined;
}

/** The list just before a change: what the motion needs once the change is drawn. */
interface ListBefore {
  /** The key of every item, drawn or not. */
  readonly keys: ReadonlySet<string>;
  /** Where each drawn item was on screen. */
  readonly places: ReadonlyMap<string, DOMRect>;
  /** The rows on screen whose items leave. */
  readonly leaving: ReadonlyArray<LeavingRow>;
}

/** The animations of the last change, and the copies of its rows that leave and fade here. */
interface RunningMotion {
  readonly animations: ReadonlyArray<Animation>;
  readonly copies: ReadonlyArray<HTMLElement>;
}

/** The items the list draws, and the scope they were drawn in. */
interface DrawnItems<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly scope: string;
}

const NO_MOTION: RunningMotion = { animations: [], copies: [] };

/** Checks whether `a` and `b` hold the same keys in the same order. */
const haveSameKeys = <Item extends { readonly key: string }>(
  a: ReadonlyArray<Item>,
  b: ReadonlyArray<Item>,
): boolean => a.length === b.length && a.every((item, index) => item.key === b[index]!.key);

/** Returns where each drawn item's element inside `scroll` is on screen, by key, in list order. */
const readItemPlaces = (scroll: HTMLElement): Map<string, [HTMLElement, DOMRect]> =>
  new Map(
    [...scroll.querySelectorAll<HTMLElement>(`[${ITEM_KEY_ATTRIBUTE}]`)].map((element) => [
      element.getAttribute(ITEM_KEY_ATTRIBUTE)!,
      [element, element.getBoundingClientRect()],
    ]),
  );

/**
 * Reads the list in `scroll` before it changes from `before` to `after`:
 * where each drawn item is on screen, and a copy of each row on screen whose
 * item leaves.
 */
const readListBefore = <Item extends { readonly key: string }>(
  scroll: HTMLElement,
  before: ReadonlyArray<Item>,
  after: ReadonlyArray<Item>,
): ListBefore => {
  const drawn = readItemPlaces(scroll);
  const places = new Map([...drawn].map(([key, [, place]]) => [key, place]));
  const leaving = listLeavingRows(
    places,
    new Set(after.map((item) => item.key)),
    scroll.getBoundingClientRect(),
  ).map((key) => {
    const [element, place] = drawn.get(key)!;
    return { key, copy: copyElementWithoutIds(element), place };
  });
  return { keys: new Set(before.map((item) => item.key)), places, leaving };
};

/**
 * Plays the motion from the list `before` to the list now drawn in `scroll`,
 * and returns what runs. The copies of the rows that leave fade in `ghosts`,
 * a layer over the list, and remove themselves when their fade ends. A row
 * that `takeLeavingRow` takes gets no fade.
 *
 * The rows that stay start where they were and slide to their new places,
 * over `options.slide`. When rows fade on screen, the slides and the arrivals
 * wait for the fade, so the gap closes only once the row is gone.
 */
const playRowMotion = (
  before: ListBefore,
  scroll: HTMLElement,
  ghosts: HTMLElement,
  { slide: slideToken = "--dur-2", takeLeavingRow }: RowMotionOptions,
): RunningMotion => {
  // Every place is read before anything is written, so the page lays out once.
  const drawn = readItemPlaces(scroll);
  const viewport = scroll.getBoundingClientRect();
  const layer = ghosts.getBoundingClientRect();
  const planned = planRowMoves(
    before.keys,
    before.places,
    new Map([...drawn].map(([key, [, place]]) => [key, place])),
    viewport,
  );
  const fade = readMotionDuration("--dur-1");
  const slide = readMotionDuration(slideToken);
  const arrive = readMotionDuration("--dur-2");
  const easing = readMotionEasing();

  const animations: Animation[] = [];
  const fading = before.leaving.filter(
    ({ key, copy, place }) => takeLeavingRow?.(key, copy, place) !== true,
  );
  for (const { copy, place } of fading) {
    Object.assign(copy.style, {
      position: "absolute",
      top: `${String(place.top - layer.top)}px`,
      left: `${String(place.left - layer.left)}px`,
      width: `${String(place.width)}px`,
      height: `${String(place.height)}px`,
      margin: "0",
    });
    ghosts.append(copy);
    // The fade holds its end until the copy is removed, so the copy never
    // shows again for a frame between the two.
    const fadeOut = copy.animate({ opacity: [1, 0] }, { duration: fade, easing, fill: "forwards" });
    const removeCopy = (): void => {
      copy.remove();
    };
    fadeOut.finished.then(removeCopy, removeCopy);
    animations.push(fadeOut);
  }

  const delay = fading.length > 0 ? fade : 0;
  // `backwards` holds the first frame through the delay, so a row waiting
  // for the fade already stands where it was, and an arrival stays unseen.
  const timing: KeyframeAnimationOptions = { delay, easing, fill: "backwards" };
  for (const move of planned) {
    const [element] = drawn.get(move.key)!;
    animations.push(
      element.animate(
        move.kind === "arrive"
          ? { opacity: [0, 1], transform: [`translateY(${String(-ARRIVAL_DROP)}px)`, "none"] }
          : { transform: [`translateY(${String(move.offset)}px)`, "none"] },
        { ...timing, duration: move.kind === "arrive" ? arrive : slide },
      ),
    );
  }
  return { animations, copies: fading.map(({ copy }) => copy) };
};

/** Stops `motion` at once: the rows stand in their places, and the copies of leaving rows go. */
const stopRowMotion = (motion: RunningMotion): void => {
  for (const animation of motion.animations) animation.cancel();
  for (const copy of motion.copies) copy.remove();
};

/**
 * Returns the items for a list to draw, and moves the list's rows when
 * `items` changes, as this module describes. `scope` names what the list
 * shows, such as the view, the tab and the pages read: when it changes, the
 * new items show at once with no motion. A change that keeps every key in
 * its place, such as a row whose text changed, draws at once too.
 *
 * `scrollRef` is the list's scroll element. Each drawn item's element in it
 * carries the item's key in its `data-item-key` attribute. `ghostsRef`
 * is an empty layer over the scroll element, which clips its content to the
 * list's visible part and takes no pointer.
 *
 * `options` change how the list moves (see `RowMotionOptions`). They are
 * read when a change plays, so they may change between renders.
 *
 * For a change that moves, the hook keeps drawing the old items for one
 * render, which no one sees: it reads where every row is and copies the
 * rows that leave, then draws the new items and starts the motion before
 * the browser paints.
 */
export const useRowMotion = <Item extends { readonly key: string }>(
  items: ReadonlyArray<Item>,
  scope: string,
  scrollRef: RefObject<HTMLElement | null>,
  ghostsRef: RefObject<HTMLElement | null>,
  options: RowMotionOptions = {},
): ReadonlyArray<Item> => {
  const [drawn, setDrawn] = useState<DrawnItems<Item>>({ items, scope });
  const before = useRef<ListBefore | null>(null);
  const running = useRef<RunningMotion>(NO_MOTION);
  const keysChange = !haveSameKeys(drawn.items, items);
  const playsMotion = drawn.scope === scope && keysChange && isMotionShown();
  // A change that keeps the keys needs no new record: the next change is
  // told apart by its keys alone.
  if (!playsMotion && (drawn.scope !== scope || keysChange)) setDrawn({ items, scope });

  useLayoutEffect(() => {
    if (!playsMotion) return;
    // Rows still sliding from the last change are read where they show, so
    // the next slide starts from there.
    before.current = readListBefore(scrollRef.current!, drawn.items, items);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- The places of the rows before a change can only be read from the page while the old rows are still drawn, which is after React commits them, so the new items are drawn from here. The second render runs before the browser paints, and only when a change adds, removes or reorders rows.
    setDrawn({ items, scope });
  }, [playsMotion, drawn, items, scope, scrollRef]);

  useLayoutEffect(() => {
    const was = before.current;
    if (was === null) return;
    before.current = null;
    // A slide still running would shift the places read next, so it stops
    // first; the new slides start from where the rows showed.
    stopRowMotion(running.current);
    running.current = playRowMotion(was, scrollRef.current!, ghostsRef.current!, options);
    // The motion plays once for a change; new options alone start none.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn, scrollRef, ghostsRef]);

  // A copy of a leaving row stands where the row was on screen, so it would
  // drift from the list on scroll; it goes at once instead. The motion also
  // stops when the scope changes, so nothing of the old list shows over the
  // new one, and when the list unmounts.
  useLayoutEffect(() => {
    const scroll = scrollRef.current!;
    const removeCopies = (): void => {
      for (const copy of running.current.copies) copy.remove();
    };
    scroll.addEventListener("scroll", removeCopies, { passive: true });
    return () => {
      scroll.removeEventListener("scroll", removeCopies);
      stopRowMotion(running.current);
      running.current = NO_MOTION;
    };
  }, [scope, scrollRef]);

  return playsMotion ? drawn.items : items;
};

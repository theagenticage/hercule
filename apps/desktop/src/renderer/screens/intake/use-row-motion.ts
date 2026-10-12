/**
 * The motion of Intake's rows when the list changes (spec 17 §Motion). A
 * row that leaves fades over `--dur-1`, then the gap closes over `--dur-2`.
 * A row that arrives fades in and drops into place over `--dur-2`, while the
 * rows below make room. Every row of one change moves at once, so a burst
 * of 30 arrivals moves as one block. Only rows on screen move; a change out
 * of view applies at once.
 *
 * The rows move with `transform` and `opacity` only, through the Web
 * Animations API, so the compositor runs each animation and nothing runs
 * once it ends. When `--dur-2` reads as 0, under Reduce motion and in tests
 * with no stylesheet, nothing moves and every change applies at once.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { readMotionDuration, readMotionEasing } from "./motion-tokens";

/** The attribute on each drawn item's element that holds its key, so the motion can find it. */
const ITEM_KEY_ATTRIBUTE = "data-item-key";

/** How far above its place an arriving row starts, in pixels, before it drops in. */
const ARRIVAL_DROP = 8;

/** A copy of a row that leaves, and where the row was on screen. */
interface LeavingRow {
  readonly copy: HTMLElement;
  readonly place: DOMRect;
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

/** The items the list draws, and the scope they were drawn in. */
interface DrawnItems<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly scope: string;
}

/** Checks whether `a` and `b` hold the same keys in the same order. */
const haveSameKeys = <Item extends { readonly key: string }>(
  a: ReadonlyArray<Item>,
  b: ReadonlyArray<Item>,
): boolean => a.length === b.length && a.every((item, index) => item.key === b[index]!.key);

/** Checks whether any part of `place` shows inside `viewport`. */
const isOnScreen = (place: DOMRect, viewport: DOMRect): boolean =>
  place.bottom > viewport.top && place.top < viewport.bottom;

/** Returns the drawn items' elements inside `scroll`, each with its key. */
const listItemElements = (scroll: HTMLElement): ReadonlyArray<[string, HTMLElement]> =>
  [...scroll.querySelectorAll<HTMLElement>(`[${ITEM_KEY_ATTRIBUTE}]`)].map((element) => [
    element.getAttribute(ITEM_KEY_ATTRIBUTE)!,
    element,
  ]);

/**
 * Returns a copy of `element` to fade out in its place. The copy keeps the
 * row's look, but loses every `id` and `data-*` attribute, so neither the
 * page's ids nor a query for a row's data ever finds it.
 */
const copyLeavingRow = (element: HTMLElement): HTMLElement => {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const each of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    for (const name of each.getAttributeNames()) {
      if (name === "id" || name.startsWith("data-")) each.removeAttribute(name);
    }
  }
  return copy;
};

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
  const viewport = scroll.getBoundingClientRect();
  const staying = new Set(after.map((item) => item.key));
  const places = new Map<string, DOMRect>();
  const leaving: LeavingRow[] = [];
  for (const [key, element] of listItemElements(scroll)) {
    const place = element.getBoundingClientRect();
    places.set(key, place);
    if (!staying.has(key) && isOnScreen(place, viewport)) {
      leaving.push({ copy: copyLeavingRow(element), place });
    }
  }
  return { keys: new Set(before.map((item) => item.key)), places, leaving };
};

/**
 * Plays the motion from the list `before` to the list now drawn in `scroll`,
 * and returns the animations of the rows that stay or arrive. The copies of
 * the rows that leave fade in `ghosts`, a layer over the list, and remove
 * themselves when their fade ends.
 *
 * The rows that stay start where they were and slide to their new places.
 * When rows leave on screen, the slides and the arrivals wait for the fade,
 * so the gap closes only once the row is gone.
 */
const playRowMotion = (
  before: ListBefore,
  scroll: HTMLElement,
  ghosts: HTMLElement,
): ReadonlyArray<Animation> => {
  const fade = readMotionDuration("--dur-1");
  const slide = readMotionDuration("--dur-2");
  const easing = readMotionEasing();
  const viewport = scroll.getBoundingClientRect();
  const layer = ghosts.getBoundingClientRect();

  for (const { copy, place } of before.leaving) {
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
    const fading = copy.animate({ opacity: [1, 0] }, { duration: fade, easing, fill: "forwards" });
    const removeCopy = (): void => {
      copy.remove();
    };
    fading.finished.then(removeCopy, removeCopy);
  }

  const delay = before.leaving.length > 0 ? fade : 0;
  // `backwards` holds the first frame through the delay, so a row waiting
  // for the fade already stands where it was, and an arrival stays unseen.
  const timing: KeyframeAnimationOptions = { duration: slide, delay, easing, fill: "backwards" };
  const animations: Animation[] = [];
  for (const [key, element] of listItemElements(scroll)) {
    const place = element.getBoundingClientRect();
    if (!before.keys.has(key)) {
      if (!isOnScreen(place, viewport)) continue;
      animations.push(
        element.animate(
          {
            opacity: [0, 1],
            transform: [`translateY(${String(-ARRIVAL_DROP)}px)`, "none"],
          },
          timing,
        ),
      );
      continue;
    }
    const was = before.places.get(key);
    // A row that was not drawn before the change has no place to start from,
    // so it shows in its new place at once.
    if (was === undefined || was.top === place.top) continue;
    if (!isOnScreen(was, viewport) && !isOnScreen(place, viewport)) continue;
    animations.push(
      element.animate(
        { transform: [`translateY(${String(was.top - place.top)}px)`, "none"] },
        timing,
      ),
    );
  }
  return animations;
};

/**
 * Returns the items for a list to draw, and moves the list's rows when
 * `items` changes, as this module describes. `scope` names what the list
 * shows, such as the view and the tab: when it changes, or when the list
 * was empty, the new items show at once with no motion. A change that
 * keeps every key in its place, such as a row whose text changed, draws at
 * once too.
 *
 * `scrollRef` is the list's scroll element. Each drawn item's element in it
 * carries the item's key in its `data-item-key` attribute. `ghostsRef` is an empty layer over
 * the scroll element, which clips its content to the list's visible part
 * and takes no pointer.
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
): ReadonlyArray<Item> => {
  const [drawn, setDrawn] = useState<DrawnItems<Item>>({ items, scope });
  const before = useRef<ListBefore | null>(null);
  const running = useRef<ReadonlyArray<Animation>>([]);
  const moves =
    drawn.scope === scope && drawn.items.length > 0 && !haveSameKeys(drawn.items, items);
  if (!moves && (drawn.items !== items || drawn.scope !== scope)) setDrawn({ items, scope });

  useLayoutEffect(() => {
    if (!moves) return;
    // Rows still sliding from the last change are read where they show, so
    // the next slide starts from there.
    if (readMotionDuration("--dur-2") > 0) {
      before.current = readListBefore(scrollRef.current!, drawn.items, items);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- The places of the rows before a change can only be read from the page while the old rows are still drawn, which is after React commits them, so the new items are drawn from here. The second render runs before the browser paints, and only when a change adds, removes or reorders rows.
    setDrawn({ items, scope });
  }, [moves, drawn, items, scope, scrollRef]);

  useLayoutEffect(() => {
    const was = before.current;
    if (was === null) return;
    before.current = null;
    // A slide still running would shift the places read next, so it stops
    // first; the new slides start from where the rows showed.
    for (const animation of running.current) animation.cancel();
    running.current = playRowMotion(was, scrollRef.current!, ghostsRef.current!);
  }, [drawn, scrollRef, ghostsRef]);

  return moves ? drawn.items : items;
};

/**
 * Waiting for a still hand: a change the user did not cause must not move
 * what they are reading or about to reach for. `waitForStillHand` holds a
 * change back until the pointer has left the place it would change.
 *
 * Nothing runs while nothing waits. The first waiter adds one pointer
 * listener and one polling timer, and the last one to finish removes both.
 */

/** How close the pointer may rest to the target before someone counts as reading it, in pixels. */
const READING_DISTANCE = 120;

/** How close a pointer on the move may come to the target before someone counts as about to reach it, in pixels. */
const REACHING_DISTANCE = 280;

/** How long after its last movement a pointer still counts as on the move, in milliseconds. */
const MOVING_FOR = 900;

/** The longest a change waits, in milliseconds. */
const LONGEST_WAIT = 8_000;

/** How often a waiting change looks again, in milliseconds. */
const CHECK_EVERY = 240;

/** What a change waits for. */
export interface StillHandOptions {
  /**
   * Returns the element the change would happen at, or `null` when it has no
   * place on the page. A change with no place waits only for a drag to end.
   */
  readonly target: () => Element | null;
  /** Returns whether the user is dragging something right now. */
  readonly isDragging: () => boolean;
  /** Stops the wait: the returned promise then resolves with `false`. */
  readonly signal?: AbortSignal;
}

interface Waiter {
  readonly options: StillHandOptions;
  readonly startedAt: number;
  readonly finish: (isStill: boolean) => void;
}

const waiters = new Set<Waiter>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** The last place the pointer was seen while someone waited, and when it last moved. `null` until it moves. */
let pointer: { readonly x: number; readonly y: number; readonly movedAt: number } | null = null;

const rememberPointer = (event: PointerEvent): void => {
  pointer = { x: event.clientX, y: event.clientY, movedAt: performance.now() };
};

/** Returns how far the point `x`, `y` is from the rectangle, in pixels. It is 0 inside it. */
const distanceFrom = (rect: DOMRect, x: number, y: number): number =>
  Math.hypot(
    Math.max(rect.left - x, 0, x - rect.right),
    Math.max(rect.top - y, 0, y - rect.bottom),
  );

/**
 * Returns whether the user's hand is busy near `target`. The pointer's place
 * is known only from its first move after the wait began, so a pointer that
 * has rested over the target since before counts through `:hover`.
 */
const isHandNear = (options: StillHandOptions, now: number): boolean => {
  if (options.isDragging()) return true;
  const target = options.target();
  if (target === null) return false;
  if (target.matches(":hover")) return true;
  if (pointer === null) return false;
  const distance = distanceFrom(target.getBoundingClientRect(), pointer.x, pointer.y);
  if (distance < READING_DISTANCE) return true;
  return now - pointer.movedAt < MOVING_FOR && distance < REACHING_DISTANCE;
};

const stopWatching = (): void => {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pointer = null;
  window.removeEventListener("pointermove", rememberPointer);
};

const check = (): void => {
  timer = null;
  const now = performance.now();
  for (const waiter of [...waiters]) {
    if (now - waiter.startedAt >= LONGEST_WAIT || !isHandNear(waiter.options, now)) {
      waiter.finish(true);
    }
  }
  if (waiters.size > 0) timer = setTimeout(check, CHECK_EVERY);
};

/**
 * Waits until the user's hand is still, and resolves with `true`. The hand is
 * not still while:
 *
 * - the user is dragging;
 * - the pointer rests within 120px of the target, however long it has rested,
 *   because a parked pointer means someone is reading;
 * - the pointer moved in the last 900ms within 280px of the target.
 *
 * It resolves at once when the hand is already still, and never later than 8
 * seconds after the call. When `signal` aborts first, it resolves with
 * `false` and the change should not happen.
 */
export const waitForStillHand = (options: StillHandOptions): Promise<boolean> =>
  new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve(false);
      return;
    }
    const now = performance.now();
    if (!isHandNear(options, now)) {
      resolve(true);
      return;
    }
    const waiter: Waiter = {
      options,
      startedAt: now,
      finish: (isStill) => {
        waiters.delete(waiter);
        options.signal?.removeEventListener("abort", cancel);
        if (waiters.size === 0) stopWatching();
        resolve(isStill);
      },
    };
    const cancel = (): void => {
      waiter.finish(false);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (waiters.size === 0) {
      window.addEventListener("pointermove", rememberPointer, { passive: true });
      timer = setTimeout(check, CHECK_EVERY);
    }
    waiters.add(waiter);
  });

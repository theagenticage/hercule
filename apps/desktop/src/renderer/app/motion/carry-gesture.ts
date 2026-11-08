import type { MotionBody } from "./body";
import { HAND_STILL_AFTER_MS, type HandTracker } from "./hand";

/** What `trackCarryGesture` is given. `Pressed` is what a press found under the pointer, `Carry` is what the caller keeps for a card in the hand. */
export interface CarryGestureOptions<Pressed, Carry> {
  /** The element that holds the pointer for the whole gesture. It stays mounted for the life of the screen. */
  readonly element: HTMLElement;
  /** How far the pointer must move, in pixels, past the press before the press becomes a carry. Up to this far is a click. */
  readonly liftDistance: number;
  /** How much a carried card leans: degrees for each pixel per millisecond of sideways speed, and the most it leans to either side. */
  readonly lean: { readonly perSpeed: number; readonly most: number };
  /** Returns what a primary press on `event.target` picks up, or `null` when it picks up nothing and no carry may start. */
  readonly readPressed: (event: PointerEvent) => Pressed | null;
  /**
   * Lifts what was pressed into the hand, with the pointer already captured.
   * Returns the carry, or `null` when nothing can be lifted (the pointer is
   * released then). `move` is called with the same event right after.
   */
  readonly lift: (pressed: Pressed, event: PointerEvent) => Carry | null;
  /** Called on every pointer move while the carry is in the hand. */
  readonly move: (carry: Carry, event: PointerEvent) => void;
  /** Called when the pointer is let go. The gesture has already released the pointer and the keys. */
  readonly drop: (carry: Carry) => void;
  /**
   * Called when the carry ends with no drop: Esc, a cancelled or lost pointer,
   * a window that lost the focus or was hidden, or `cancel`. `isPointerUp` is
   * whether the pointer's button is already up.
   */
  readonly cancel: (carry: Carry, isPointerUp: boolean) => void;
  /** Called for every key press and release while the carry is in the hand, except Esc, which the gesture takes. */
  readonly onKey?: (carry: Carry, event: KeyboardEvent) => void;
}

/** What `trackCarryGesture` returns. */
export interface CarryGesture<Carry> {
  /** Returns the carry that is in the hand, or `null`. */
  readonly readCarry: () => Carry | null;
  /** Ends the carry in the hand as if it was cancelled, with `isPointerUp` as in the `cancel` option. Does nothing when none is in the hand. */
  readonly cancel: (isPointerUp: boolean) => void;
  /**
   * Tilts `body` with the speed of `hand`, and straightens it again once the
   * hand has been still for `HAND_STILL_AFTER_MS`, unless `canStraighten`
   * returns `false` by then. The caller skips it under Reduce motion.
   */
  readonly leanWithHand: (
    body: MotionBody,
    hand: HandTracker,
    canStraighten?: () => boolean,
  ) => void;
  /**
   * Stops listening. Returns the carry that was in the hand, already released
   * and not told to `cancel`, so the caller can put the page back; `null`
   * when none was.
   */
  readonly destroy: () => Carry | null;
}

/** A primary press that has not moved far enough to be a carry. */
interface Press<Pressed> {
  readonly pointerId: number;
  readonly pressed: Pressed;
  readonly startX: number;
  readonly startY: number;
}

/**
 * Follows the pointer from a press on `element` to the card it carries being
 * let go or cancelled: lifts once the pointer moves past `liftDistance`,
 * captures the pointer, passes moves on, and ends the carry on a release, a
 * cancelled or lost pointer, Esc, a window that loses the focus, or a hidden
 * document. It knows nothing of cards. What is lifted, moved and dropped is
 * the caller's, through the options.
 *
 * The gesture releases the pointer and stops listening before it calls `drop`
 * or `cancel`, so the caller only puts its own marks away.
 */
export const trackCarryGesture = <Pressed, Carry>(
  options: CarryGestureOptions<Pressed, Carry>,
): CarryGesture<Carry> => {
  const { element, liftDistance, lean } = options;
  let press: Press<Pressed> | null = null;
  let held: { readonly pointerId: number; readonly carry: Carry } | null = null;
  let uprightTimer: number | undefined;

  const forgetPress = (): void => {
    press = null;
    stopListening();
  };

  /** Stops watching the pointer and the keys, and lets the pointer go. Returns the carry that was held, or `null`. */
  const release = (): Carry | null => {
    window.clearTimeout(uprightTimer);
    if (held === null) return null;
    const { pointerId, carry } = held;
    held = null;
    element.removeEventListener("lostpointercapture", onLostCapture);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    stopListening();
    return carry;
  };

  const cancel = (isPointerUp: boolean): void => {
    const carry = release();
    if (carry !== null) options.cancel(carry, isPointerUp);
  };

  const liftPress = (event: PointerEvent): void => {
    const lifted = press;
    press = null;
    if (lifted === null) return;
    try {
      element.setPointerCapture(lifted.pointerId);
    } catch {
      // The pointer was let go before the lift, so there is nothing to carry.
      stopListening();
      return;
    }
    const carry = options.lift(lifted.pressed, event);
    if (carry === null) {
      if (element.hasPointerCapture(lifted.pointerId)) {
        element.releasePointerCapture(lifted.pointerId);
      }
      stopListening();
      return;
    }
    held = { pointerId: lifted.pointerId, carry };
    element.addEventListener("lostpointercapture", onLostCapture);
    options.move(carry, event);
  };

  /** Runs when the system took the pointer away from the element other than by letting it go. */
  function onLostCapture(event: PointerEvent): void {
    if (held !== null && event.pointerId === held.pointerId) cancel(true);
  }

  function onPointerMove(event: PointerEvent): void {
    if (held !== null) {
      if (event.pointerId === held.pointerId) options.move(held.carry, event);
      return;
    }
    if (press === null || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) <= liftDistance) {
      return;
    }
    liftPress(event);
  }

  function onPointerUp(event: PointerEvent): void {
    if (held !== null) {
      if (event.pointerId !== held.pointerId) return;
      const { carry } = held;
      release();
      options.drop(carry);
      return;
    }
    if (press !== null && event.pointerId === press.pointerId) forgetPress();
  }

  function onPointerCancel(event: PointerEvent): void {
    if (held !== null) {
      if (event.pointerId === held.pointerId) cancel(true);
      return;
    }
    if (press !== null && event.pointerId === press.pointerId) forgetPress();
  }

  /** Sends the carry home on Esc, and keeps the key from reaching anything else. */
  function onKeyDown(event: KeyboardEvent): void {
    if (held === null) return;
    if (event.key !== "Escape") {
      options.onKey?.(held.carry, event);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel(false);
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (held !== null) options.onKey?.(held.carry, event);
  }

  /** Cancels the carry when the window loses the focus or is hidden: the pointer's release may never arrive. */
  function onWindowAway(): void {
    cancel(true);
  }

  function onVisibilityChange(): void {
    if (document.hidden) onWindowAway();
  }

  function startListening(): void {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowAway);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  function stopListening(): void {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onWindowAway);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary || held !== null || press !== null) return;
    const pressed = options.readPressed(event);
    if (pressed === null) return;
    press = {
      pointerId: event.pointerId,
      pressed,
      startX: event.clientX,
      startY: event.clientY,
    };
    startListening();
  };

  element.addEventListener("pointerdown", onPointerDown);

  return {
    readCarry: () => held?.carry ?? null,
    cancel,
    leanWithHand: (body, hand, canStraighten = () => true) => {
      body.to({ r: hand.readLean(lean.perSpeed, lean.most) }, "hand", { reduced: false });
      window.clearTimeout(uprightTimer);
      uprightTimer = window.setTimeout(() => {
        if (canStraighten()) body.to({ r: 0 }, "hand", { reduced: false });
      }, HAND_STILL_AFTER_MS);
    },
    destroy: () => {
      element.removeEventListener("pointerdown", onPointerDown);
      press = null;
      const carry = release();
      stopListening();
      return carry;
    },
  };
};

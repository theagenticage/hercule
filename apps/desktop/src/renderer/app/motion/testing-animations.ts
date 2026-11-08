/**
 * A stand-in for the Web Animations API for tests. jsdom has no
 * `Element.animate`, so a test installs this, lets the code under test start
 * animations, and reads what it asked for. A test ends an animation by
 * calling `finish`, as a browser would at the end of its time.
 */
import { vi } from "vitest";

/** One animation the code under test started. */
export class FakeAnimation {
  onfinish: (() => void) | null = null;
  oncancel: (() => void) | null = null;
  isCancelled = false;
  readonly element: Element;
  readonly keyframes: unknown;
  readonly options: KeyframeAnimationOptions;

  constructor(element: Element, keyframes: unknown, options: KeyframeAnimationOptions) {
    this.element = element;
    this.keyframes = keyframes;
    this.options = options;
  }

  /** Stops the animation, as the browser does: the cancel handler runs, the finish handler never does. */
  cancel(): void {
    this.isCancelled = true;
    this.oncancel?.();
  }

  /** Ends the animation at its time, unless it was cancelled. */
  finish(): void {
    if (!this.isCancelled) this.onfinish?.();
  }
}

/**
 * Makes `Element.animate` record a `FakeAnimation` for each call, and returns
 * the list. Call `removeFakeAnimations` after the test.
 */
export const installFakeAnimations = (): FakeAnimation[] => {
  const played: FakeAnimation[] = [];
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(function (
      this: Element,
      keyframes: unknown,
      options: KeyframeAnimationOptions = {},
    ) {
      const animation = new FakeAnimation(this, keyframes, options);
      played.push(animation);
      return animation;
    }),
  });
  return played;
};

/** Takes `Element.animate` away again. */
export const removeFakeAnimations = (): void => {
  Reflect.deleteProperty(Element.prototype, "animate");
};

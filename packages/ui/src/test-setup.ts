/**
 * jsdom implements neither the pointer-capture API nor scrollIntoView, and has
 * no ResizeObserver, so the primitives built on Radix cannot open without these.
 * It has no `scrollTo` either, on the window or on an element. The router
 * calls both on every navigation: the window's would print a "not implemented"
 * line per test, and a missing element one fails with an error.
 */
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

window.scrollTo = () => {};
Element.prototype.scrollTo = () => {};

/**
 * jsdom does no layout, so `Range` has no `getClientRects`. The workflow
 * editor's text editor calls it to position the cursor and popups. This stub
 * returns an empty list, as a browser does for text that is not rendered.
 */
Range.prototype.getClientRects = function () {
  return Object.assign([], { item: () => null });
};

/**
 * jsdom has no object URLs. This stub hands out a fresh `blob:` URL per call,
 * as a browser does, so a test can tell two URLs apart and spy on the revoke.
 */
let objectUrlCount = 0;
URL.createObjectURL = () => `blob:jsdom/${String((objectUrlCount += 1))}`;
URL.revokeObjectURL = () => {};

/**
 * jsdom has no IntersectionObserver, and it does no layout, so nothing could
 * tell what is on screen. This stub reports every watched element on screen
 * as soon as it is watched, as a browser does for an element in view.
 */
globalThis.IntersectionObserver = class {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
};

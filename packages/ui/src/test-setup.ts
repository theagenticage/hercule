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

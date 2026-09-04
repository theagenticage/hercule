/**
 * jsdom implements neither the pointer-capture API nor scrollIntoView, and has
 * no ResizeObserver, so the primitives built on Radix cannot open without these.
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

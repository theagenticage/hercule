/**
 * jsdom has no `window.scrollTo`. The router calls it after every navigation,
 * including the first one at start-up, so without this stub each test that
 * renders the app prints a "not implemented" line.
 */
window.scrollTo = () => {};

/**
 * jsdom has no `document.fonts`. A screen waits for `document.fonts.ready`
 * before it reports itself to main (see `app/presented-frame.ts`), so without
 * this stub each test that shows the "connecting" screen logs an error. The
 * stub has no fonts to load, so its `ready` has resolved. It is a getter, so
 * a test can replace it with `vi.spyOn(document, "fonts", "get")`.
 */
Object.defineProperty(document, "fonts", {
  configurable: true,
  get: () => ({ ready: Promise.resolve() }),
});

import { beforeEach, vi } from "vitest";

/**
 * Creates an empty `localStorage` held in memory.
 *
 * Under the Node versions this repository runs on, Node's own
 * `localStorage`, which is missing unless Node is given a file to keep it in,
 * hides jsdom's. So each test gets this one, and nothing one test stores,
 * such as the last open thread, reaches the next.
 */
const createMemoryStorage = (): Storage => {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, String(value));
    },
    removeItem: (key) => {
      held.delete(key);
    },
    clear: () => {
      held.clear();
    },
    key: (index) => [...held.keys()][index] ?? null,
    get length() {
      return held.size;
    },
  };
};

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
});

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

/**
 * jsdom has no `ResizeObserver`. The thread screen watches the composer's
 * height with one, so each test that opens a thread would fail without it.
 * The stub reports no sizes. A test that needs a resize replaces it with
 * `vi.stubGlobal("ResizeObserver", ...)`.
 */
window.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

/**
 * jsdom has a `<dialog>` element with an `open` attribute, but no
 * `showModal` or `close`. The project picker opens with `showModal`, and
 * closes with `close`, which fires `close` on the dialog as a browser does,
 * and does nothing on a dialog that is already closed, as a browser does.
 *
 * The stub closes a modal dialog on Esc as a browser does: an Escape keydown
 * that no handler prevented fires `cancel` on the dialog, then closes it
 * unless `cancel` was prevented too. It has no other modal behaviour: the
 * page behind the dialog stays reachable.
 */
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.open = true;
  const closeOnEscape = (event: KeyboardEvent): void => {
    if (!this.open || !this.isConnected) {
      document.removeEventListener("keydown", closeOnEscape);
      return;
    }
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (this.dispatchEvent(new Event("cancel", { cancelable: true }))) this.close();
  };
  document.addEventListener("keydown", closeOnEscape);
};
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
  if (!this.open) return;
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

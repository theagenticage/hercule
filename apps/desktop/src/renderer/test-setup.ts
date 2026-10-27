import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, vi } from "vitest";
import rowHeights from "./styles/row-heights.css?raw";

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
 * jsdom has no IndexedDB, which the saved thread copies use. Each test gets an
 * empty database, so no copy one test saves reaches the next.
 *
 * These are plain assignments, not `vi.stubGlobal`, on purpose. A thread page
 * that unmounts when a test ends queues an idle write, and the write reads
 * `indexedDB` and `IDBKeyRange` a moment later. A test file that calls
 * `vi.unstubAllGlobals()` in its `afterEach` would remove stubbed globals
 * first, and the write would fail with "IDBKeyRange is not defined".
 */
globalThis.IDBKeyRange = IDBKeyRange;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

/**
 * jsdom has no `window.scrollTo`. The router calls it after every navigation,
 * including the first one at start-up, so without this stub each test that
 * renders the app prints a "not implemented" line.
 */
window.scrollTo = () => {};

/**
 * jsdom has no `Element.scrollIntoView`. The composer's skill list scrolls its
 * highlighted row into view, so each test that opens a list would fail
 * without it. The stub scrolls nothing.
 */
Element.prototype.scrollIntoView = () => {};

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
 * jsdom has no `window.matchMedia`. The Office room asks it whether the user
 * reduced motion each time its shot or its contents change, so each test that
 * moves the first run from one step to the next would fail without it. The
 * stub matches no query. A test that needs a match replaces it.
 */
window.matchMedia = (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) satisfies MediaQueryList;

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

/**
 * jsdom has no `AnimationEvent`. Without it, React listens for the old
 * `webkitAnimationEnd` in place of `animationend`, and an event fired with
 * `fireEvent.animationEnd` never reaches an `onAnimationEnd` handler. jsdom
 * runs no animations, so a test that waits for one to end fires the event
 * itself: the Office settles its new pieces when their animation ends.
 */
window.AnimationEvent = class extends Event {
  readonly animationName: string;
  readonly elapsedTime: number;
  readonly pseudoElement: string;
  constructor(type: string, init: AnimationEventInit = {}) {
    super(type, init);
    this.animationName = init.animationName ?? "";
    this.elapsedTime = init.elapsedTime ?? 0;
    this.pseudoElement = init.pseudoElement ?? "";
  }
};

/**
 * jsdom has no popover API. The sidebar's card of thread details shows and
 * hides itself with `togglePopover`, and a menu item closes its menu with
 * `hidePopover`, so a test that renders either would fail without them. The
 * stubs only keep the open state, as a browser does: jsdom draws nothing, so
 * a test reads what the popover holds rather than whether it shows.
 */
const openPopovers = new WeakSet<HTMLElement>();
HTMLElement.prototype.togglePopover = function (this: HTMLElement, force?: boolean) {
  const open = force ?? !openPopovers.has(this);
  if (open) openPopovers.add(this);
  else openPopovers.delete(this);
  return open;
};
HTMLElement.prototype.showPopover = function (this: HTMLElement) {
  openPopovers.add(this);
};
HTMLElement.prototype.hidePopover = function (this: HTMLElement) {
  openPopovers.delete(this);
};

/**
 * jsdom reports `navigator.platform` as "". ProseMirror's key handling reads
 * it once, when its module loads, to decide whether "Mod" is ⌘ or Ctrl, and
 * the app is a Mac app, so the editor's shortcuts here are the Mac's. This
 * file runs before a test file imports anything.
 */
Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });

/**
 * jsdom has no `document.elementFromPoint`. ProseMirror asks it where a mouse
 * event landed, so a drop or a click on the message field would throw
 * without it. The stub finds no element.
 */
document.elementFromPoint = () => null;

/**
 * jsdom has no layout, so a `Range` has no `getClientRects` or
 * `getBoundingClientRect`. ProseMirror measures the selection with them when
 * it scrolls the caret into view. The stubs return one empty rectangle.
 */
const EMPTY_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};
Range.prototype.getBoundingClientRect = () => EMPTY_RECT;
Range.prototype.getClientRects = () =>
  Object.assign([EMPTY_RECT], { item: () => EMPTY_RECT }) satisfies DOMRectList;

/**
 * jsdom has no `requestIdleCallback`. The thread copy store saves a copy with
 * it, once the browser is idle. The stand-in runs the callback on the next
 * timer tick, as if the browser were always idle.
 */
window.requestIdleCallback = (callback) =>
  window.setTimeout(() => {
    callback({ didTimeout: false, timeRemaining: () => 0 });
  }, 0);
window.cancelIdleCallback = (handle) => {
  window.clearTimeout(handle);
};

/**
 * jsdom does not compute `calc()` or `var()`, and ignores `@property`, so the
 * row heights of styles/row-heights.css (`--side-height-thread-row` and the
 * others) would read as the unresolved text of their `calc()`. Before each
 * test, this adds a style sheet that sets each one on the root element as a
 * length, to the `initial-value` its `@property` rule registers, which is its
 * height at the default Text size. It is a style sheet, not the root
 * element's `style` attribute, which tests read and clear. It is added before
 * each test because a test may empty the page's head. A test of a larger
 * text size sets the properties itself, as a browser would compute them, and
 * then sets `data-text-size` (`changeTextSize` in app/testing.tsx).
 */
beforeEach(() => {
  const declarations = [
    ...rowHeights.matchAll(/@property\s+(--[\w-]+)\s*\{[^}]*?initial-value:\s*([^;]+);/g),
  ].map(([, name, height]) => `${name!}: ${height!.trim()};`);
  document.head.querySelector("style[data-row-heights]")?.remove();
  const sheet = document.createElement("style");
  sheet.dataset.rowHeights = "";
  sheet.textContent = `:root { ${declarations.join(" ")} }`;
  document.head.append(sheet);
});

/**
 * What the page measures again when the Text size changes (spec 17
 * §Settings, Appearance).
 *
 * `public/theme-init.js` sets `data-text-size` on the root element, and
 * base.css turns the step into the size of the text tokens. A row whose
 * height follows its text gets its height from CSS, and anything in
 * TypeScript that places rows by those heights, such as a virtual list, must
 * read them again after a change. This file is the one signal for that:
 *
 * - `subscribeToTextSize` calls a listener after the step changes. It watches
 *   the attribute with one `MutationObserver` for the whole page, which runs
 *   only while a listener is subscribed and does nothing until the attribute
 *   changes. Watching the attribute, rather than the `appearancechange` event
 *   that `theme-init.js` listens for, means the listener never runs before
 *   the attribute is set, whichever order the two event handlers run in, and
 *   it also sees a page that sets the attribute itself, such as a specimen.
 * - `readLengths` reads CSS lengths that the stylesheet registered with
 *   `@property`, once per call.
 * - `useMeasuredAtTextSize` reads them on mount and again after each change.
 */
import { useMemo, useSyncExternalStore } from "react";
import { DEFAULT_APPEARANCE } from "../../ipc/appearance";

/** Returns the step of the Text size now in use, as the attribute holds it. A page with no attribute is at the default step. */
const readTextSizeStep = (): string =>
  document.documentElement.dataset.textSize ?? String(DEFAULT_APPEARANCE.textSize);

const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;
let notifiedStep = "";

/**
 * Calls `listener` after the Text size changes to another step, until the
 * returned function is called. The listener runs once per change, in the
 * microtask after the attribute is set, so the styles it reads are already
 * the new ones. It does not run for a change that sets the step it already
 * has.
 */
export const subscribeToTextSize = (listener: () => void): (() => void) => {
  if (observer === undefined) {
    notifiedStep = readTextSizeStep();
    observer = new MutationObserver(() => {
      const step = readTextSizeStep();
      if (step === notifiedStep) return;
      notifiedStep = step;
      for (const each of [...listeners]) each();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-text-size"],
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
    }
  };
};

/** Matches a computed length in pixels, such as `52px` or `-1.5px`. */
const PIXELS = /^(-?\d+(?:\.\d+)?)px$/;

/**
 * Returns the lengths, in CSS pixels, that the custom properties in
 * `properties` hold on the root element now, under the same keys. Reads the
 * computed style once for all of them, which forces a style calculation but
 * no layout.
 *
 * A custom property only computes to a plain length when the stylesheet
 * registers it with `@property` and `syntax: "<length>"` (see
 * styles/row-heights.css); otherwise its value is the unresolved text of its
 * `calc()`. Fails when a property does not hold a length in pixels, naming
 * the property and what it holds.
 */
export const readLengths = <Key extends string>(
  properties: Readonly<Record<Key, string>>,
): Record<Key, number> => {
  const style = getComputedStyle(document.documentElement);
  const lengths = {} as Record<Key, number>;
  for (const key of Object.keys(properties) as Key[]) {
    const property = properties[key];
    const value = style.getPropertyValue(property).trim();
    const match = PIXELS.exec(value);
    if (match === null) {
      throw new Error(
        `The custom property ${property} holds "${value}", but a length in px is needed. ` +
          "Register it with @property in styles/row-heights.css.",
      );
    }
    lengths[key] = Number(match[1]);
  }
  return lengths;
};

/**
 * Returns a store of what `measure` returns, for `useSyncExternalStore`.
 * Its `read` measures once, and again only after the Text size changed since
 * the last read. It returns the same result in between.
 */
const createMeasuredStore = <Measured>(measure: () => Measured): { read: () => Measured } => {
  let step = readTextSizeStep();
  let result = measure();
  return {
    read: () => {
      const now = readTextSizeStep();
      if (now !== step) {
        step = now;
        result = measure();
      }
      return result;
    },
  };
};

/**
 * Returns what `measure` returns, and measures again after each change of
 * the Text size, drawing the calling component again with the new result.
 * `measure` reads the page's CSS (`readLengths`) and keeps its identity
 * across renders, so it is a function at module level. The same object
 * comes back until the next change.
 */
export const useMeasuredAtTextSize = <Measured>(measure: () => Measured): Measured => {
  const store = useMemo(() => createMeasuredStore(measure), [measure]);
  return useSyncExternalStore(subscribeToTextSize, store.read);
};

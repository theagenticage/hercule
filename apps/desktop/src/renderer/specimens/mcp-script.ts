/**
 * What the MCP specimens do after the page has mounted, to put a screen in
 * the state a scene shows: wait for a part to draw, and press a control, as
 * the user would.
 */

/**
 * Waits until the page holds an element that matches `selector` and returns
 * it, checking once a frame. Fails after five seconds, naming `selector`: the
 * part is loaded lazily or the specimen's records do not draw it.
 */
export async function waitForPart(selector: string): Promise<HTMLElement> {
  return (await waitForParts(selector, 1))[0]!;
}

/**
 * Waits until the page holds at least `count` elements that match `selector`
 * and returns them, checking once a frame. Fails after five seconds, naming
 * `selector`.
 */
export async function waitForParts(selector: string, count: number): Promise<HTMLElement[]> {
  const deadline = performance.now() + 5000;
  for (;;) {
    const elements = [...document.querySelectorAll<HTMLElement>(selector)];
    if (elements.length >= count) return elements;
    if (performance.now() > deadline) {
      throw new Error(
        `The MCP specimen never drew ${String(count)} of ${selector}. Check the page's console.`,
      );
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/** Waits for the part `selector` names and presses it. Fails like `waitForPart`. */
export async function pressPart(selector: string): Promise<void> {
  (await waitForPart(selector)).click();
}

/**
 * Waits for the text field `selector` names and types `text` into it, as the
 * user would: React reads the field through its `input` event, so the value is
 * set the way the browser sets it before that event is sent.
 */
export async function typeInto(selector: string, text: string): Promise<void> {
  const field = (await waitForPart(selector)) as HTMLInputElement;
  // The setter is called with `.call` on the field, so it never needs its own `this`.
  // oxlint-disable-next-line typescript/unbound-method
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setValue === undefined) throw new Error("The page's text fields have no value setter.");
  setValue.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * What the reference pages share when they edit a Bureau book page to show a
 * fixture's data: finding the book's elements, failing loudly when the book
 * no longer has them, and replacing a control's text.
 *
 * Each finder fails rather than returning nothing, because an edit that
 * silently misses its element would only show up as differing pixels.
 */

/** Returns the first element inside `scope` that matches `selector`. Fails when there is none. */
export function findElement(scope: ParentNode, selector: string): Element {
  const element = scope.querySelector(selector);
  if (element === null) throw new Error(`The book's page has no ${selector}.`);
  return element;
}

/**
 * Returns every element inside `scope` that matches `selector`. Fails when
 * the count is not `count`, because each edit pairs the book's elements with
 * the fixture's records one to one.
 */
export function findElements(scope: ParentNode, selector: string, count: number): Element[] {
  const elements = [...scope.querySelectorAll(selector)];
  if (elements.length !== count) {
    throw new Error(
      `The book's page has ${String(elements.length)} ${selector}, and the fixture ${String(count)}.`,
    );
  }
  return elements;
}

/** Returns the element inside `scope` that matches `selector` and whose text is `text`. Fails when there is none. */
export function findElementByText(scope: ParentNode, selector: string, text: string): Element {
  const element = [...scope.querySelectorAll(selector)].find(
    (each) => each.textContent.trim() === text,
  );
  if (element === undefined) throw new Error(`The book's page has no ${selector} "${text}".`);
  return element;
}

/**
 * Replaces the text of a control that starts with an icon, such as a
 * `.pick`, with `text`, and keeps the icon. Fails when the control has no
 * icon.
 */
export function replaceTextAfterIcon(control: Element, text: string): void {
  control.replaceChildren(findElement(control, "svg"), text);
}

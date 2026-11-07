/**
 * Returns a copy of `element` to animate where it was, such as a row that
 * leaves. The copy keeps the element's look, but loses every `id` and `data-*`
 * attribute, so neither the page's ids nor a query for its data ever finds it.
 * `keepData` names the `data-*` attributes to keep because the stylesheet draws
 * the element by them, such as `data-state`.
 */
export const copyElementWithoutIds = (
  element: HTMLElement,
  keepData: readonly string[] = [],
): HTMLElement => {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const each of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    for (const name of each.getAttributeNames()) {
      if (name === "id" || (name.startsWith("data-") && !keepData.includes(name))) {
        each.removeAttribute(name);
      }
    }
  }
  return copy;
};

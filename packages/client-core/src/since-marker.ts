/**
 * The "since you last checked" marker of a view, such as the notification
 * center or Intake (spec 10 §8).
 *
 * The user settings store holds one marker per view: the instant the user last
 * opened it. Opening the view advances the stored marker to now, but the view
 * keeps counting from the previous instant for the whole visit. To do that, it
 * pins the previous instant in its URL as `since`, so a refresh shows the same
 * items as new. The pin is either that instant or `NEVER_CHECKED`, for a user
 * who had never opened the view: then everything counts as new.
 *
 * These functions decide what the pin and the marker mean. The web app does the
 * navigation and the settings write.
 */

/** The pin of a view the user had never opened before this visit. */
export const NEVER_CHECKED = "never";

/**
 * Parses the `since` value of a view's URL. Returns the pin, or `undefined`
 * when the value is neither `NEVER_CHECKED` nor a valid instant, so a
 * hand-edited URL is treated as if it had no pin.
 */
export const parseSincePin = (value: unknown): string | undefined => {
  if (value === NEVER_CHECKED) return value;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return value;
};

/**
 * Returns the pin to put in the URL when the view opens: the stored marker, or
 * `NEVER_CHECKED` when the user has never opened the view.
 */
export const choosePinOnOpen = (marker: string | undefined): string => marker ?? NEVER_CHECKED;

/**
 * Returns the instant the view counts new items from, or `undefined` when every
 * item is new.
 *
 * The pin wins over the stored marker. Without a pin, the view has only just
 * opened and has not pinned yet, so the stored marker still holds the previous
 * visit; using it keeps the view from flashing everything as new.
 */
export const chooseNewSince = (
  pin: string | undefined,
  marker: string | undefined,
): string | undefined => {
  if (pin === undefined) return marker;
  return pin === NEVER_CHECKED ? undefined : pin;
};

/**
 * Splits a newest-first list at `since`: `fresh` holds the items created at or
 * after that instant, `seen` the older ones. Without an instant, every item is
 * fresh. The order inside each part is kept.
 */
export const splitBySince = <Item extends { readonly createdAt: string }>(
  items: ReadonlyArray<Item>,
  since: string | undefined,
): { readonly fresh: ReadonlyArray<Item>; readonly seen: ReadonlyArray<Item> } => {
  if (since === undefined) return { fresh: items, seen: [] };
  const from = Date.parse(since);
  return {
    fresh: items.filter((item) => Date.parse(item.createdAt) >= from),
    seen: items.filter((item) => Date.parse(item.createdAt) < from),
  };
};

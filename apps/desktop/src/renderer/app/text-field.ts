/**
 * Checks whether `target`, the element a key press lands on, is a text
 * field: an input, a text area, a select, or an element the user can edit.
 * Returns false for any other element and for no target at all.
 *
 * A screen's own keys leave a text field alone, so a key typed there edits
 * the text instead of acting on the screen.
 */
export const isTextField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

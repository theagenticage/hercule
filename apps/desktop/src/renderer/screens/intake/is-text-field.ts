/** Checks whether a key press lands in a text field, where Intake's keys never act. */
export const isTextField = (target: EventTarget): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

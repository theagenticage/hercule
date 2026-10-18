/**
 * Redoes the last undone edit in the focused field. Called when the user
 * chooses Edit > Redo in the menu.
 *
 * Chromium's own redo only works for a field that Chromium undid. A rich
 * editor such as the message field undoes by itself, so there is nothing for
 * Chromium to redo. So this first sends the focused element the `beforeinput`
 * event that Chromium sends for a redo, `historyRedo`:
 *
 * - An editor that keeps its own history redoes by itself and cancels the
 *   event.
 * - If no one cancels it, the focused element is a plain text field or input.
 *   Then this asks Chromium to redo, which is what Edit > Redo does in a
 *   browser.
 */
export const redoInFocusedField = (): void => {
  const redoEvent = new InputEvent("beforeinput", {
    inputType: "historyRedo",
    bubbles: true,
    cancelable: true,
  });
  const isCancelled = !(document.activeElement ?? document.body).dispatchEvent(redoEvent);
  if (!isCancelled) document.execCommand("redo");
};

import type { HistoryStep } from "../../ipc/contract";

/**
 * Undoes or redoes the last edit in the focused field, as `step` says.
 * Called when the user chooses Edit > Undo or Edit > Redo in the menu.
 *
 * Chromium's own undo and redo only know the edits Chromium made. A rich
 * editor such as the message field handles some edits itself and keeps its
 * own history, so Chromium has nothing to undo or redo for them. So this
 * first sends the focused element the `beforeinput` event that Chromium sends
 * for the step, `historyUndo` or `historyRedo`:
 *
 * - An editor that keeps its own history steps by itself and cancels the
 *   event.
 * - If no one cancels it, this asks Chromium to step, which is what the menu
 *   item does in a browser. Chromium steps through the edits it made in a
 *   plain text field or input, and does nothing when the focus is on the
 *   page body, a button or a read-only editor.
 */
export const stepHistoryInFocusedField = (step: HistoryStep): void => {
  const stepEvent = new InputEvent("beforeinput", {
    inputType: step === "undo" ? "historyUndo" : "historyRedo",
    bubbles: true,
    cancelable: true,
  });
  const isCancelled = !(document.activeElement ?? document.body).dispatchEvent(stepEvent);
  if (!isCancelled) document.execCommand(step);
};

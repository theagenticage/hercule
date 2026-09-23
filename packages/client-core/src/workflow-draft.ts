/**
 * The text that an author writes on a workflow's page, before it is saved,
 * and the rules for a stored text that changes while the page is open.
 */

/** The text on a workflow's page, and the stored text that it was written from. */
export interface WorkflowDraft {
  /** The text on the page, as the author typed it. */
  readonly text: string;
  /**
   * The stored text that `text` was written from. While it differs from the
   * stored text, the stored text changed elsewhere, and a save replaces that
   * change.
   */
  readonly baseSource: string;
  /**
   * Whether the author edited the text since the page last took a stored
   * text. An undo back to the base does not clear it, because the author
   * still works on the text. Only a save, or a stored text that is the
   * author's text, clears it.
   */
  readonly hasDiverged: boolean;
}

/** The draft after the author changed its text to `text`. */
export const editDraft = (draft: WorkflowDraft, text: string): WorkflowDraft => ({
  ...draft,
  text,
  hasDiverged: true,
});

/**
 * The draft after a save stored `savedSource`. The saved text is the new
 * base. The draft stays diverged only when the author typed while the save
 * was in flight.
 */
export const markDraftSaved = (draft: WorkflowDraft, savedSource: string): WorkflowDraft => ({
  ...draft,
  baseSource: savedSource,
  hasDiverged: draft.text !== savedSource,
});

/**
 * The draft after the stored text became `storedSource`, as when another
 * client saves the workflow. A draft that the author did not edit follows the
 * stored text. An edited draft keeps its text and its base: a base that
 * differs from the stored text then tells the page that the stored text
 * changed elsewhere. When the stored text is the author's text, it is the new
 * base. The same draft comes back when nothing changes, so a caller can tell.
 */
export const followStoredSource = (draft: WorkflowDraft, storedSource: string): WorkflowDraft => {
  if (draft.baseSource === storedSource) return draft;
  if (draft.text === storedSource || !draft.hasDiverged) {
    return { text: storedSource, baseSource: storedSource, hasDiverged: false };
  }
  return draft;
};

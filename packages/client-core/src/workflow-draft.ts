/**
 * The source that an author writes on a workflow's page, before it is saved,
 * and the rules for a stored source that changes while the page is open.
 */

/** The source on a workflow's page, and the stored source that it was written from. */
export interface WorkflowDraft {
  /** The source on the page, as the author typed it. */
  readonly source: string;
  /**
   * The stored source that `source` was written from. While it differs from
   * the stored source, the stored source changed elsewhere, and a save
   * replaces that change.
   */
  readonly baseSource: string;
  /**
   * Whether the author edited the source since the page last took a stored
   * source. An undo back to the base does not clear it, because the author
   * still works on the source. Only a save, or a stored source that is the
   * author's source, clears it.
   */
  readonly hasDiverged: boolean;
}

/** The draft after the author changed its source to `source`. */
export const editDraft = (draft: WorkflowDraft, source: string): WorkflowDraft => ({
  ...draft,
  source,
  hasDiverged: true,
});

/**
 * The draft after a save stored `savedSource`. The saved source is the new
 * base. The draft stays diverged only when the author typed while the save
 * was in flight.
 */
export const markDraftSaved = (draft: WorkflowDraft, savedSource: string): WorkflowDraft => ({
  ...draft,
  baseSource: savedSource,
  hasDiverged: draft.source !== savedSource,
});

/**
 * The draft after the stored source became `storedSource`, as when another
 * client saves the workflow. A draft that the author did not edit follows the
 * stored source. An edited draft keeps its source and its base: a base that
 * differs from the stored source then tells the page that the stored source
 * changed elsewhere. When the stored source is the author's source, it is the
 * new base. The same draft comes back when nothing changes, so a caller can
 * tell.
 */
export const followStoredSource = (draft: WorkflowDraft, storedSource: string): WorkflowDraft => {
  if (draft.baseSource === storedSource) return draft;
  if (draft.source === storedSource || !draft.hasDiverged) {
    return { source: storedSource, baseSource: storedSource, hasDiverged: false };
  }
  return draft;
};

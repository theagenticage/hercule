/**
 * The unsaved source on a workflow's page, and how it reacts when the stored
 * workflow changes while the page is open.
 */

/** The source being edited on a workflow's page, and the stored source it started from. */
export interface WorkflowDraft {
  /** The source on the page, as the author typed it. */
  readonly source: string;
  /**
   * The stored source that `source` started from. When this differs from the
   * current stored source, someone changed the workflow elsewhere, and a save
   * overwrites that change.
   */
  readonly baseSource: string;
  /**
   * True once the author edits the source, until the next save or until the
   * stored source matches the author's source. Undoing back to the base
   * source does not reset it, because the author is still editing.
   */
  readonly hasDiverged: boolean;
}

/** Returns the draft with its source replaced by the author's edit. */
export const editDraft = (draft: WorkflowDraft, source: string): WorkflowDraft => ({
  ...draft,
  source,
  hasDiverged: true,
});

/**
 * Returns the draft after a successful save of `savedSource`, which becomes
 * the new base. The draft stays diverged only if the author typed more while
 * the save was in flight.
 */
export const markDraftSaved = (draft: WorkflowDraft, savedSource: string): WorkflowDraft => ({
  ...draft,
  baseSource: savedSource,
  hasDiverged: draft.source !== savedSource,
});

/**
 * Returns the draft after the stored source changed to `storedSource`, for
 * example because another client saved the workflow.
 *
 * - A draft the author has not edited takes the new stored source.
 * - A draft whose source equals the new stored source takes it as its base,
 *   and is no longer diverged.
 * - Any other edited draft is returned unchanged. Its base now differs from
 *   the stored source. The page uses that difference to show that the
 *   workflow changed elsewhere.
 *
 * Returns the same object when nothing changed, so the caller can skip an
 * update.
 */
export const applyStoredSourceChange = (
  draft: WorkflowDraft,
  storedSource: string,
): WorkflowDraft => {
  if (draft.baseSource === storedSource) return draft;
  if (draft.source === storedSource || !draft.hasDiverged) {
    return { source: storedSource, baseSource: storedSource, hasDiverged: false };
  }
  return draft;
};

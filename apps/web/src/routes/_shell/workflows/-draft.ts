import { useState } from "react";
import {
  editDraft,
  applyStoredSourceChange,
  markDraftSaved,
  type WorkflowDraft,
} from "@hercule/client-core";

/**
 * Tracks the source that the user edits on a workflow's page, and the stored
 * source that the edit started from. Returns the draft and two functions
 * that update it. While the user has not edited the draft, it follows
 * changes that another client makes to the stored source.
 */
export const useWorkflowDraft = (storedSource: string) => {
  const [heldDraft, setHeldDraft] = useState<WorkflowDraft>({
    source: storedSource,
    baseSource: storedSource,
    hasDiverged: false,
  });
  const draft = applyStoredSourceChange(heldDraft, storedSource);
  if (draft !== heldDraft) setHeldDraft(draft);
  return {
    draft,
    /** Replaces the draft's source with what the user typed. */
    editSource: (source: string): void => {
      setHeldDraft((held) => editDraft(held, source));
    },
    /** Makes `savedSource` the new base, after an update of this page's workflow succeeds. */
    markSaved: (savedSource: string): void => {
      setHeldDraft((held) => markDraftSaved(held, savedSource));
    },
  };
};

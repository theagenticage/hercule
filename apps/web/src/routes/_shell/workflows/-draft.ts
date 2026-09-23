/**
 * The source on a workflow's page, as the author types it, and the stored
 * source that it was written from.
 */
import { useState } from "react";
import {
  editDraft,
  followStoredSource,
  markDraftSaved,
  type WorkflowDraft,
} from "@hercule/client-core";

/**
 * The draft of the page, which follows a stored source that changes
 * elsewhere while the author has not edited the draft, and the two changes
 * the page makes to it.
 */
export const useWorkflowDraft = (storedSource: string) => {
  const [heldDraft, setHeldDraft] = useState<WorkflowDraft>({
    source: storedSource,
    baseSource: storedSource,
    hasDiverged: false,
  });
  const draft = followStoredSource(heldDraft, storedSource);
  if (draft !== heldDraft) setHeldDraft(draft);
  return {
    draft,
    /** Takes the source that the author typed. */
    editSource: (source: string): void => {
      setHeldDraft((held) => editDraft(held, source));
    },
    /** Takes the source that an update of the page's workflow stored as the new base. */
    markSaved: (savedSource: string): void => {
      setHeldDraft((held) => markDraftSaved(held, savedSource));
    },
  };
};

import { isNotFound, readValidationIssues } from "./errors";
import type { WorkflowDraft } from "./workflow-draft";

/** The status line beside Save in a workflow page's header. */
export interface WorkflowHeaderStatus {
  readonly text: string;
  /** `fail` for a failed save or delete, `attn` for something the author must know before saving. */
  readonly tone: "muted" | "attn" | "fail";
}

/** The page state that decides the header's status line. */
export interface WorkflowHeaderFacts {
  readonly draft: WorkflowDraft;
  /** The current stored source, or the starter source for a new workflow. */
  readonly storedSource: string;
  /** Whether the stored workflow is turned off. False for a new, unsaved workflow. */
  readonly isStoredOff: boolean;
  /** Whether the workflow was deleted by someone other than this page. */
  readonly isDeletedElsewhere: boolean;
  /** Whether this page was opened right after creating the workflow. */
  readonly isJustCreated: boolean;
  /** The page's last save. */
  readonly save: {
    readonly status: "idle" | "pending" | "success" | "error";
    /** The source the last save sent. `undefined` before the first save. */
    readonly source: string | undefined;
    readonly error: Error | null;
  };
  /** The error from the page's last delete, or `null` if it did not fail. */
  readonly deleteError: Error | null;
}

/**
 * Returns the status line to show beside Save in a workflow page's header, or
 * `undefined` for none. The checks run in priority order, and the first match
 * wins.
 */
export const decideWorkflowHeaderStatus = ({
  draft,
  storedSource,
  isStoredOff,
  isDeletedElsewhere,
  isJustCreated,
  save,
  deleteError,
}: WorkflowHeaderFacts): WorkflowHeaderStatus | undefined => {
  if (deleteError !== null) return { text: `Not deleted: ${deleteError.message}`, tone: "fail" };
  // The save result applies only to the source it sent, so it shows only while
  // the page still has that source. A save that failed because the workflow
  // is gone is covered by the "Deleted elsewhere" line below.
  const isSaveAboutSource = save.source === draft.source;
  if (save.error !== null && isSaveAboutSource && !isNotFound(save.error)) {
    return readValidationIssues(save.error) === undefined
      ? { text: `Not saved: ${save.error.message}`, tone: "fail" }
      : { text: "Not saved: the text has problems.", tone: "fail" };
  }
  // Saving now creates a new workflow with a new id, and new workflows start
  // turned off.
  if (isDeletedElsewhere) {
    return { text: "Deleted elsewhere. Saving creates a new workflow, turned off.", tone: "attn" };
  }
  // While a save is in flight, the page cannot tell its own change apart from
  // a change made elsewhere.
  if (draft.baseSource !== storedSource && save.status !== "pending") {
    return { text: "Changed elsewhere. Saving replaces that change.", tone: "attn" };
  }
  if (save.status === "success" && isSaveAboutSource) return { text: "Saved.", tone: "muted" };
  // A new workflow's page shows that it was created turned off, until the
  // author edits the source or turns the workflow on.
  if (isJustCreated && save.status === "idle" && draft.source === storedSource && isStoredOff) {
    return { text: "Created, turned off.", tone: "muted" };
  }
  return undefined;
};

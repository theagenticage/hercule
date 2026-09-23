/**
 * What the header of a workflow's page says beside Save: the one sentence
 * about the page's last write, or about a change to the stored workflow that
 * was made elsewhere.
 */
import { isNotFound, readValidationIssues } from "./errors";
import type { WorkflowDraft } from "./workflow-draft";

/** A sentence of the header, and the hue it is set in. */
export interface WorkflowHeaderStatus {
  readonly text: string;
  /** `fail` for a write that failed, `attn` for what the author must know before a save. */
  readonly tone: "muted" | "attn" | "fail";
}

/** What the page knows when it decides what its header says. */
export interface WorkflowHeaderFacts {
  /** The source on the page, and the stored source that it was written from. */
  readonly draft: WorkflowDraft;
  /** The stored source now, or the starter source for a new workflow. */
  readonly storedSource: string;
  /** Whether the stored workflow is turned off. A new workflow is not stored, so it is not. */
  readonly isStoredOff: boolean;
  /** Whether the controller no longer has the workflow, and the page did not delete it. */
  readonly isDeletedElsewhere: boolean;
  /** Whether a create of the page opened this page. */
  readonly isJustCreated: boolean;
  /** The last save of the page. */
  readonly save: {
    readonly status: "idle" | "pending" | "success" | "error";
    /** The source that the last save sent. Absent before the first save. */
    readonly source: string | undefined;
    readonly error: Error | null;
  };
  /** Why the last delete of the page failed, or `null` when it did not fail. */
  readonly deleteError: Error | null;
}

/**
 * What the header says beside Save: the first of these sentences that is true
 * now, or `undefined` when none is.
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
  // What the last save said is about the source that it sent, so it shows
  // only while that source is the source on the page. A save that found the
  // workflow gone is said by the notice below.
  const isSaveAboutSource = save.source === draft.source;
  if (save.error !== null && isSaveAboutSource && !isNotFound(save.error)) {
    return readValidationIssues(save.error) === undefined
      ? { text: `Not saved: ${save.error.message}`, tone: "fail" }
      : { text: "Not saved: the text has problems.", tone: "fail" };
  }
  // A save creates a workflow with a new id, and a new workflow is off.
  if (isDeletedElsewhere) {
    return { text: "Deleted elsewhere. Saving creates a new workflow, turned off.", tone: "attn" };
  }
  // While a save is in flight, the page cannot tell its own change from a
  // change made elsewhere.
  if (draft.baseSource !== storedSource && save.status !== "pending") {
    return { text: "Changed elsewhere. Saving replaces that change.", tone: "attn" };
  }
  if (save.status === "success" && isSaveAboutSource) return { text: "Saved.", tone: "muted" };
  // The page of a new workflow says what the create did until the author
  // changes the source or the workflow is turned on.
  if (isJustCreated && save.status === "idle" && draft.source === storedSource && isStoredOff) {
    return { text: "Created, turned off.", tone: "muted" };
  }
  return undefined;
};

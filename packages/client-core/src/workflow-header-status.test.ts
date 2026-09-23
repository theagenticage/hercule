/**
 * Several status lines can apply at once, and the header shows only the
 * first. So where the priority matters, a test sets up two of them and checks
 * which one wins.
 */
import { describe, expect, it } from "vitest";
import {
  ApiError,
  decideWorkflowHeaderStatus,
  type WorkflowHeaderFacts,
} from "@hercule/client-core";

const STORED = "name: Stored\n";
const TYPED = "name: Typed by the author\n";

/** A stored workflow that is turned on, opened and not yet edited, saved or deleted. */
const OPENED: WorkflowHeaderFacts = {
  draft: { source: STORED, baseSource: STORED, hasDiverged: false },
  storedSource: STORED,
  isStoredOff: false,
  isDeletedElsewhere: false,
  isJustCreated: false,
  save: { status: "idle", source: undefined, error: null },
  deleteError: null,
};

/** The page after the author typed `TYPED`. */
const TYPED_FACTS: WorkflowHeaderFacts = {
  ...OPENED,
  draft: { source: TYPED, baseSource: STORED, hasDiverged: true },
};

const REFUSAL = new ApiError("validation", "The workflow is not valid.", {
  issues: [{ path: ["steps", "0", "action"], message: "task.creat is not an action." }],
});
const NOT_FOUND = new ApiError("not_found", "No workflow has that id.");
const DISK_FULL = new ApiError("internal", "The disk is full.");

/** The page after a save of `TYPED` that failed with `error`. */
const buildFailedSave = (error: Error): WorkflowHeaderFacts => ({
  ...TYPED_FACTS,
  save: { status: "error", source: TYPED, error },
});

describe("decideWorkflowHeaderStatus", () => {
  it("shows nothing when there was no save, no delete and no change elsewhere", () => {
    expect(decideWorkflowHeaderStatus(OPENED)).toBeUndefined();
    expect(decideWorkflowHeaderStatus(TYPED_FACTS)).toBeUndefined();
  });

  it("shows a failed delete before a failed save", () => {
    expect(
      decideWorkflowHeaderStatus({
        ...buildFailedSave(DISK_FULL),
        deleteError: new ApiError("internal", "The database is locked."),
      }),
    ).toEqual({ text: "Not deleted: The database is locked.", tone: "fail" });
  });

  it("shows a failed save, or a save rejected by validation, before a change elsewhere", () => {
    const changedElsewhere = { storedSource: "name: Changed elsewhere\n" };

    expect(
      decideWorkflowHeaderStatus({ ...buildFailedSave(DISK_FULL), ...changedElsewhere }),
    ).toEqual({ text: "Not saved: The disk is full.", tone: "fail" });
    expect(
      decideWorkflowHeaderStatus({ ...buildFailedSave(REFUSAL), ...changedElsewhere }),
    ).toEqual({ text: "Not saved: the text has problems.", tone: "fail" });
  });

  it("ignores a save result for a source other than the one on the page", () => {
    const retyped = {
      draft: { source: `${TYPED}# more\n`, baseSource: STORED, hasDiverged: true },
    };

    expect(
      decideWorkflowHeaderStatus({ ...buildFailedSave(DISK_FULL), ...retyped }),
    ).toBeUndefined();
    expect(
      decideWorkflowHeaderStatus({
        ...TYPED_FACTS,
        ...retyped,
        save: { status: "success", source: TYPED, error: null },
      }),
    ).toBeUndefined();
  });

  it("shows that the workflow was deleted elsewhere, instead of the save's not_found error", () => {
    expect(
      decideWorkflowHeaderStatus({ ...buildFailedSave(NOT_FOUND), isDeletedElsewhere: true }),
    ).toEqual({
      text: "Deleted elsewhere. Saving creates a new workflow, turned off.",
      tone: "attn",
    });
  });

  it("shows that the stored source changed elsewhere, but not while a save is in flight", () => {
    const changedElsewhere: WorkflowHeaderFacts = {
      ...TYPED_FACTS,
      storedSource: "name: Changed elsewhere\n",
    };

    expect(decideWorkflowHeaderStatus(changedElsewhere)).toEqual({
      text: "Changed elsewhere. Saving replaces that change.",
      tone: "attn",
    });
    expect(
      decideWorkflowHeaderStatus({
        ...changedElsewhere,
        save: { status: "pending", source: TYPED, error: null },
      }),
    ).toBeUndefined();
  });

  it("shows Saved. once the page's source is saved", () => {
    expect(
      decideWorkflowHeaderStatus({
        ...OPENED,
        draft: { source: TYPED, baseSource: TYPED, hasDiverged: false },
        storedSource: TYPED,
        save: { status: "success", source: TYPED, error: null },
      }),
    ).toEqual({ text: "Saved.", tone: "muted" });
  });

  it("shows that a new workflow was created, until its source is edited or it is turned on", () => {
    const created: WorkflowHeaderFacts = { ...OPENED, isJustCreated: true, isStoredOff: true };

    expect(decideWorkflowHeaderStatus(created)).toEqual({
      text: "Created, turned off.",
      tone: "muted",
    });
    expect(decideWorkflowHeaderStatus({ ...created, draft: TYPED_FACTS.draft })).toBeUndefined();
    expect(decideWorkflowHeaderStatus({ ...created, isStoredOff: false })).toBeUndefined();
  });
});

/**
 * The rules for a stored source that changes while a workflow's page is open:
 * a source that the author did not edit follows it, and once the author
 * edits, the author's source is never replaced until a save.
 */
import { describe, expect, it } from "vitest";
import {
  editDraft,
  followStoredSource,
  markDraftSaved,
  type WorkflowDraft,
} from "@hercule/client-core";

const STORED = "name: Stored\n";
const CHANGED_ELSEWHERE = "name: Changed elsewhere\n";
const TYPED = "name: Typed by the author\n";

const OPENED: WorkflowDraft = { source: STORED, baseSource: STORED, hasDiverged: false };

describe("followStoredSource", () => {
  it("replaces a source that the author did not edit with the new stored source", () => {
    expect(followStoredSource(OPENED, CHANGED_ELSEWHERE)).toEqual({
      source: CHANGED_ELSEWHERE,
      baseSource: CHANGED_ELSEWHERE,
      hasDiverged: false,
    });
  });

  it("keeps the author's source and its base, so the page can say the stored source changed", () => {
    const edited = editDraft(OPENED, TYPED);

    expect(followStoredSource(edited, CHANGED_ELSEWHERE)).toBe(edited);
  });

  // An undo back to the source that the page opened on is still the author's
  // work. If the page followed the stored source then, the author's next redo
  // would be lost, and the notice would go with no save.
  it("keeps the source when the author edited and then undid back to the base", () => {
    const undone = editDraft(editDraft(OPENED, TYPED), STORED);

    const followed = followStoredSource(undone, CHANGED_ELSEWHERE);

    expect(followed).toBe(undone);
    expect(followed.baseSource).not.toBe(CHANGED_ELSEWHERE);
  });

  it("takes the stored source as the base when it is the source the author typed", () => {
    const edited = editDraft(OPENED, TYPED);

    expect(followStoredSource(edited, TYPED)).toEqual({
      source: TYPED,
      baseSource: TYPED,
      hasDiverged: false,
    });
  });

  it("answers the same draft when the stored source is its base", () => {
    const edited = editDraft(OPENED, TYPED);

    expect(followStoredSource(OPENED, STORED)).toBe(OPENED);
    expect(followStoredSource(edited, STORED)).toBe(edited);
  });
});

describe("markDraftSaved", () => {
  it("follows the stored source again after a save of the source on the page", () => {
    const saved = markDraftSaved(editDraft(OPENED, TYPED), TYPED);

    expect(saved).toEqual({ source: TYPED, baseSource: TYPED, hasDiverged: false });
    expect(followStoredSource(saved, CHANGED_ELSEWHERE).source).toBe(CHANGED_ELSEWHERE);
  });

  it("keeps what the author typed while the save was in flight", () => {
    const typedOn = editDraft(editDraft(OPENED, TYPED), `${TYPED}# more\n`);

    const saved = markDraftSaved(typedOn, TYPED);

    expect(saved).toEqual({ source: `${TYPED}# more\n`, baseSource: TYPED, hasDiverged: true });
    expect(followStoredSource(saved, CHANGED_ELSEWHERE)).toBe(saved);
  });
});

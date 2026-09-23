/**
 * When the stored source changes while a workflow's page is open, an unedited
 * draft takes the new source. Once the author edits, the draft is never
 * replaced until a save.
 */
import { describe, expect, it } from "vitest";
import {
  editDraft,
  applyStoredSourceChange,
  markDraftSaved,
  type WorkflowDraft,
} from "@hercule/client-core";

const STORED = "name: Stored\n";
const CHANGED_ELSEWHERE = "name: Changed elsewhere\n";
const TYPED = "name: Typed by the author\n";

const OPENED: WorkflowDraft = { source: STORED, baseSource: STORED, hasDiverged: false };

describe("applyStoredSourceChange", () => {
  it("replaces a source that the author did not edit with the new stored source", () => {
    expect(applyStoredSourceChange(OPENED, CHANGED_ELSEWHERE)).toEqual({
      source: CHANGED_ELSEWHERE,
      baseSource: CHANGED_ELSEWHERE,
      hasDiverged: false,
    });
  });

  it("keeps an edited draft's source and base, so the page can show that the stored source changed", () => {
    const edited = editDraft(OPENED, TYPED);

    expect(applyStoredSourceChange(edited, CHANGED_ELSEWHERE)).toBe(edited);
  });

  // Undoing back to the original source still counts as editing. If the draft
  // took the new stored source here, the author's next redo would be lost, and
  // the "Changed elsewhere" notice would disappear without a save.
  it("keeps the source when the author edited and then undid back to the base", () => {
    const undone = editDraft(editDraft(OPENED, TYPED), STORED);

    const followed = applyStoredSourceChange(undone, CHANGED_ELSEWHERE);

    expect(followed).toBe(undone);
    expect(followed.baseSource).not.toBe(CHANGED_ELSEWHERE);
  });

  it("takes the stored source as the base when it equals the author's source", () => {
    const edited = editDraft(OPENED, TYPED);

    expect(applyStoredSourceChange(edited, TYPED)).toEqual({
      source: TYPED,
      baseSource: TYPED,
      hasDiverged: false,
    });
  });

  it("returns the same draft object when the stored source equals its base", () => {
    const edited = editDraft(OPENED, TYPED);

    expect(applyStoredSourceChange(OPENED, STORED)).toBe(OPENED);
    expect(applyStoredSourceChange(edited, STORED)).toBe(edited);
  });
});

describe("markDraftSaved", () => {
  it("takes later stored source changes again after the page's source is saved", () => {
    const saved = markDraftSaved(editDraft(OPENED, TYPED), TYPED);

    expect(saved).toEqual({ source: TYPED, baseSource: TYPED, hasDiverged: false });
    expect(applyStoredSourceChange(saved, CHANGED_ELSEWHERE).source).toBe(CHANGED_ELSEWHERE);
  });

  it("keeps what the author typed while the save was in flight", () => {
    const typedOn = editDraft(editDraft(OPENED, TYPED), `${TYPED}# more\n`);

    const saved = markDraftSaved(typedOn, TYPED);

    expect(saved).toEqual({ source: `${TYPED}# more\n`, baseSource: TYPED, hasDiverged: true });
    expect(applyStoredSourceChange(saved, CHANGED_ELSEWHERE)).toBe(saved);
  });
});

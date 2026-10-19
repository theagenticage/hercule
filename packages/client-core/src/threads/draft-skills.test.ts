/**
 * Tests the skills a Draft Thread offers: which repos and runner the preview
 * read is asked about, and which library skills a draft has.
 */
import { describe, expect, it } from "vitest";
import type { Skill } from "@hercule/contract";
import { findDraftSkillsPreview, listLibrarySessionSkills } from "./draft-skills";
import { buildCheckout, buildWorkspace } from "./workspaces.testing";

describe("findDraftSkillsPreview", () => {
  it("asks about the repo of a main workspace on the settled runner", () => {
    expect(
      findDraftSkillsPreview({ kind: "primary", resourceId: "repo-1" }, "runner-1", []),
    ).toEqual({ runnerId: "runner-1", resourceId: ["repo-1"] });
  });

  it("asks about every repo of a new workspace", () => {
    const pick = {
      kind: "ephemeral",
      checkouts: [{ resourceId: "repo-1" }, { resourceId: "repo-2" }],
    } as const;
    expect(findDraftSkillsPreview(pick, "runner-1", [])).toEqual({
      runnerId: "runner-1",
      resourceId: ["repo-1", "repo-2"],
    });
  });

  it("asks about the repos of a workspace the draft joins", () => {
    const joined = buildWorkspace({
      id: "ws-1",
      runnerId: "runner-2",
      checkouts: [buildCheckout("repo-3", "main")],
    });
    expect(
      findDraftSkillsPreview({ kind: "existing", workspaceId: "ws-1" }, "runner-2", [joined]),
    ).toEqual({ runnerId: "runner-2", resourceId: ["repo-3"] });
  });

  it("asks about a repo once when two checkouts share it", () => {
    const pick = {
      kind: "ephemeral",
      checkouts: [{ resourceId: "repo-1" }, { resourceId: "repo-1" }],
    } as const;
    expect(findDraftSkillsPreview(pick, "runner-1", [])?.resourceId).toEqual(["repo-1"]);
  });

  it("returns null when the draft opens no repo", () => {
    expect(findDraftSkillsPreview({ kind: "none" }, "runner-1", [])).toBeNull();
    expect(findDraftSkillsPreview({ kind: "ephemeral", checkouts: [] }, "runner-1", [])).toBeNull();
    expect(
      findDraftSkillsPreview({ kind: "existing", workspaceId: "gone" }, "runner-1", []),
    ).toBeNull();
  });

  it("returns null when no runner is settled", () => {
    expect(findDraftSkillsPreview({ kind: "primary", resourceId: "repo-1" }, null, [])).toBeNull();
  });
});

describe("listLibrarySessionSkills", () => {
  const skill = (name: string, currentRevisionHash: string | null): Skill =>
    ({ name, currentRevisionHash }) as Skill;

  it("lists the skills that have a current revision, without descriptions", () => {
    expect(listLibrarySessionSkills([skill("review", "h1"), skill("draft-only", null)])).toEqual([
      { source: "library", name: "review", description: "" },
    ]);
  });
});

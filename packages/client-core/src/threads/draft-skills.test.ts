/**
 * Tests the skills a Draft Thread offers: which repos and runner the preview
 * read is asked about.
 */
import { describe, expect, it } from "vitest";
import { buildDraftSkillsPreview } from "./draft-skills";
import { buildCheckout, buildWorkspace } from "./workspaces.testing";

describe("buildDraftSkillsPreview", () => {
  it("asks about the repo of a main workspace on the settled runner", () => {
    expect(
      buildDraftSkillsPreview({ kind: "primary", resourceId: "repo-1" }, "runner-1", []),
    ).toEqual({ runnerId: "runner-1", resourceId: ["repo-1"] });
  });

  it("asks about every repo of a new workspace", () => {
    const pick = {
      kind: "ephemeral",
      checkouts: [{ resourceId: "repo-1" }, { resourceId: "repo-2" }],
    } as const;
    expect(buildDraftSkillsPreview(pick, "runner-1", [])).toEqual({
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
      buildDraftSkillsPreview({ kind: "existing", workspaceId: "ws-1" }, "runner-2", [joined]),
    ).toEqual({ runnerId: "runner-2", resourceId: ["repo-3"] });
  });

  it("asks about a repo once when two checkouts share it", () => {
    const pick = {
      kind: "ephemeral",
      checkouts: [{ resourceId: "repo-1" }, { resourceId: "repo-1" }],
    } as const;
    expect(buildDraftSkillsPreview(pick, "runner-1", []).resourceId).toEqual(["repo-1"]);
  });

  it("returns the empty filter, the library alone, when the draft opens no repo", () => {
    expect(buildDraftSkillsPreview({ kind: "none" }, "runner-1", [])).toEqual({});
    expect(buildDraftSkillsPreview({ kind: "ephemeral", checkouts: [] }, "runner-1", [])).toEqual(
      {},
    );
    expect(
      buildDraftSkillsPreview({ kind: "existing", workspaceId: "gone" }, "runner-1", []),
    ).toEqual({});
  });

  it("returns the empty filter when no runner is settled, so no repos are named without one", () => {
    expect(buildDraftSkillsPreview({ kind: "primary", resourceId: "repo-1" }, null, [])).toEqual(
      {},
    );
  });
});

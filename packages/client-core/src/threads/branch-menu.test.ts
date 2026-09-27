/**
 * Tests the branch field, which is two different fields in the same place.
 * The tests check that:
 *
 * - a main workspace lists the branches it can switch to: its own branches,
 *   plus the branches that live worktrees next to it have checked out, which
 *   are dimmed with the worktree's name;
 * - a new worktree lists the branches its new branch can start from;
 * - there is no field for a workspace the thread joins.
 */
import { describe, expect, it } from "vitest";
import { buildBranchField } from "./branch-menu";
import { joinPhraseText } from "./workspaces";
import {
  COVE,
  MOSS,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP,
  INFRA,
  buildWorkspace,
  buildCheckout,
} from "./workspaces.testing";

const around = { workspaces: [PRIMARY, THREAD_3F1], runnerId: MOSS.id };

describe("buildBranchField: a main workspace", () => {
  const field = buildBranchField({ kind: "primary", resourceId: WEBSHOP.id }, around);

  it("asks which branch the checkout switches to, starting from its current branch", () => {
    expect(field?.header).toBe("Branch");
    expect(field?.note).toBe("the checkout switches to it");
    expect(field?.label).toBe("main");
    expect(field?.glyph).toBe(true);
  });

  it("badges the current branch and dims one that a live worktree has checked out", () => {
    expect(field?.rows).toEqual([
      { branch: "main", badge: "current", dimmed: null },
      { branch: "release/2.4", badge: null, dimmed: null },
      { branch: "hercule/thread-3f1", badge: null, dimmed: "in workspace hercule/thread-3f1" },
    ]);
  });

  it("dims nothing for a worktree on another runner", () => {
    const elsewhere = buildBranchField(
      { kind: "primary", resourceId: WEBSHOP.id },
      {
        workspaces: [PRIMARY, { ...THREAD_3F1, runnerId: COVE.id }],
        runnerId: MOSS.id,
      },
    );

    expect(elsewhere?.rows.every((row) => row.dimmed === null)).toBe(true);
  });

  it("shows the branch the draft picked, not the checkout's current branch", () => {
    expect(
      buildBranchField({ kind: "primary", resourceId: WEBSHOP.id, branch: "release/2.4" }, around)
        ?.label,
    ).toBe("release/2.4");
  });

  it("is locked for a repo this runner has never cloned", () => {
    const fresh = buildBranchField({ kind: "primary", resourceId: INFRA.id }, around);

    expect(fresh?.label).toBe("default");
    expect(fresh?.locked).not.toBeNull();
    expect(fresh?.rows).toEqual([]);
  });

  // The runner reports `branch: null` when it could not read the branch, and
  // switching away from an unknown branch is not offered.
  it("is locked for a checkout whose branch the runner could not read", () => {
    const unread = buildBranchField(
      { kind: "primary", resourceId: WEBSHOP.id },
      {
        workspaces: [{ ...PRIMARY, checkouts: [buildCheckout(WEBSHOP.id, null)] }],
        runnerId: MOSS.id,
      },
    );

    expect(unread?.label).toBe("default");
    expect(unread?.locked).toBe("This machine could not read the checkout's branch");
    expect(unread?.rows).toEqual([]);
  });
});

describe("buildBranchField: a new worktree", () => {
  it("asks what the new branch starts from, badges the default, and explains the new branch", () => {
    const field = buildBranchField(
      { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }] },
      around,
    );

    expect(field?.header).toBe("Base branch");
    expect(field?.label).toBe("from main");
    expect(field?.rows.find((row) => row.branch === "main")?.badge).toBe("default");
    expect(joinPhraseText(field?.foot ?? [])).toBe(
      "The new branch is hercule/thread-…, named after the thread, and starts from origin/main when the remote has it.",
    );
    // The two git names in it are mono, as git names are everywhere.
    expect(field?.foot).toContainEqual({ text: "hercule/thread-…", mono: true });
    expect(field?.foot).toContainEqual({ text: "origin/main", mono: true });
  });

  it("badges the checked-out branch as current when it is not the default", () => {
    const onRelease = buildWorkspace({
      id: "ws-release",
      checkouts: [buildCheckout(WEBSHOP.id, "release/2.4", ["main", "release/2.4"], "main")],
    });
    const field = buildBranchField(
      { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }] },
      {
        workspaces: [onRelease],
        runnerId: MOSS.id,
      },
    );

    expect(field?.rows).toEqual([
      { branch: "main", badge: "default", dimmed: null },
      { branch: "release/2.4", badge: "current", dimmed: null },
    ]);
  });

  it("lists the bases of several repos together, and is locked", () => {
    const infra = buildWorkspace({
      id: "ws-infra",
      checkouts: [buildCheckout(INFRA.id, "master", ["master"], "master")],
    });
    const field = buildBranchField(
      { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }] },
      { workspaces: [PRIMARY, infra], runnerId: MOSS.id },
    );

    expect(field?.label).toBe("from main · master");
    expect(field?.locked).not.toBeNull();
  });

  it("names no branch when one of the repos has never been cloned", () => {
    const field = buildBranchField(
      { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }] },
      around,
    );

    expect(field?.label).toBe("from default branches");
  });
});

describe("buildBranchField: no branch to choose", () => {
  it("returns null for a workspace the thread joins, which is named after its branch", () => {
    expect(buildBranchField({ kind: "existing", workspaceId: THREAD_3F1.id }, around)).toBeNull();
  });

  it("returns null for a thread with no checkout", () => {
    expect(buildBranchField({ kind: "none" }, around)).toBeNull();
  });
});

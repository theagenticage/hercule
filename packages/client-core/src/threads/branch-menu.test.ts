/**
 * The branch field, which is two fields wearing one slot. What matters: the
 * main workspace lists what git would let it switch to - the primary's own
 * branches plus whatever a live worktree beside it is sitting on, the latter
 * dimmed with what holds it (D-14) - while a fresh worktree lists what its new
 * branch could start from, and neither exists at all on a workspace the thread
 * merely joins.
 */
import { describe, expect, it } from "vitest";
import { buildBranchField } from "./branch-menu";
import { joinPhraseText } from "./workspaces";
import {
  COVE,
  MOSS,
  PRIMARY,
  RUN_3F1,
  WEBSHOP,
  INFRA,
  buildWorkspace,
  buildCheckout,
} from "./workspaces.testing";

const around = { workspaces: [PRIMARY, RUN_3F1], runnerId: MOSS.id };

describe("buildBranchField: a main workspace", () => {
  const field = buildBranchField({ kind: "primary", resourceId: WEBSHOP.id }, around);

  it("asks which branch the checkout switches to, reading the one it is on", () => {
    expect(field?.header).toBe("Branch");
    expect(field?.note).toBe("the checkout switches to it");
    expect(field?.label).toBe("main");
    expect(field?.glyph).toBe(true);
  });

  it("badges the branch it is on and dims one a live worktree beside it holds", () => {
    expect(field?.rows).toEqual([
      { branch: "main", badge: "current", dimmed: null },
      { branch: "release/2.4", badge: null, dimmed: null },
      { branch: "hercule/run-3f1", badge: null, dimmed: "in workspace hercule/run-3f1" },
    ]);
  });

  it("dims nothing for a worktree on another machine, which holds no branch here", () => {
    const elsewhere = buildBranchField(
      { kind: "primary", resourceId: WEBSHOP.id },
      {
        workspaces: [PRIMARY, { ...RUN_3F1, runnerId: COVE.id }],
        runnerId: MOSS.id,
      },
    );

    expect(elsewhere?.rows.every((row) => row.dimmed === null)).toBe(true);
  });

  it("reads the branch the draft picked, not the one the checkout is on", () => {
    expect(
      buildBranchField({ kind: "primary", resourceId: WEBSHOP.id, branch: "release/2.4" }, around)
        ?.label,
    ).toBe("release/2.4");
  });

  it("takes no pick on a repo this machine has never cloned", () => {
    const fresh = buildBranchField({ kind: "primary", resourceId: INFRA.id }, around);

    expect(fresh?.label).toBe("default");
    expect(fresh?.locked).not.toBeNull();
    expect(fresh?.rows).toEqual([]);
  });

  // D-21: the machine reports `branch: null` where it could not read one, and
  // a branch nobody can name is not one to switch from.
  it("takes no pick on a checkout whose branch the machine could not read", () => {
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

describe("buildBranchField: a fresh worktree", () => {
  it("asks what the new branch starts from, badging the default and saying what is made", () => {
    const field = buildBranchField(
      { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }] },
      around,
    );

    expect(field?.header).toBe("Base branch");
    expect(field?.label).toBe("from main");
    expect(field?.rows.find((row) => row.branch === "main")?.badge).toBe("default");
    expect(joinPhraseText(field?.foot ?? [])).toBe(
      "The new branch is hercule/run-…, named after the thread, and starts from origin/main when the remote has it.",
    );
    // The two git words in it are mono, as a git word is everywhere.
    expect(field?.foot).toContainEqual({ text: "hercule/run-…", mono: true });
    expect(field?.foot).toContainEqual({ text: "origin/main", mono: true });
  });

  it("badges the checked-out branch current where it is not the default", () => {
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

  it("reads the bases side by side, and takes no pick, over several repos", () => {
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

  it("names no branch at all where one of the repos has never been cloned", () => {
    const field = buildBranchField(
      { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }] },
      around,
    );

    expect(field?.label).toBe("from default branches");
  });
});

describe("buildBranchField: where there is no branch to speak of", () => {
  it("is absent on a workspace the thread joins, which is named after its branch", () => {
    expect(buildBranchField({ kind: "existing", workspaceId: RUN_3F1.id }, around)).toBeNull();
  });

  it("is absent on a thread with no checkout", () => {
    expect(buildBranchField({ kind: "none" }, around)).toBeNull();
  });
});

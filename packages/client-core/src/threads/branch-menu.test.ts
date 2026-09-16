/**
 * The branch field, which is two fields wearing one slot. What matters: the
 * shared checkout lists what git would let it switch to - the primary's own
 * branches plus whatever a live worktree beside it is sitting on, the latter
 * dimmed with what holds it (D-14) - while a fresh worktree lists what its new
 * branch could start from, and neither exists at all on a workspace the thread
 * merely joins.
 */
import { describe, expect, it } from "vitest";
import { branchField } from "./branch-menu";
import {
  COVE,
  MOSS,
  PRIMARY,
  RUN_3F1,
  WEBSHOP,
  INFRA,
  workspace,
  checkout,
} from "./workspaces.testing";

const around = { workspaces: [PRIMARY, RUN_3F1], runnerId: MOSS.id };

describe("branchField: a shared checkout", () => {
  const field = branchField({ kind: "primary", resourceId: WEBSHOP.id }, around);

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
      { branch: "hydra/run-3f1", badge: null, dimmed: "in workspace hydra/run-3f1" },
    ]);
  });

  it("dims nothing for a worktree on another machine, which holds no branch here", () => {
    const elsewhere = branchField(
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
      branchField({ kind: "primary", resourceId: WEBSHOP.id, branch: "release/2.4" }, around)
        ?.label,
    ).toBe("release/2.4");
  });

  it("takes no pick on a repo this machine has never cloned", () => {
    const fresh = branchField({ kind: "primary", resourceId: INFRA.id }, around);

    expect(fresh?.label).toBe("default");
    expect(fresh?.locked).not.toBeNull();
    expect(fresh?.rows).toEqual([]);
  });
});

describe("branchField: a fresh worktree", () => {
  it("asks what the new branch starts from, badging the default and saying what is made", () => {
    const field = branchField(
      { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }] },
      around,
    );

    expect(field?.header).toBe("Base branch");
    expect(field?.label).toBe("from main");
    expect(field?.rows.find((row) => row.branch === "main")?.badge).toBe("default");
    expect(field?.foot).toBe(
      "The new branch is hydra/run-…, named after the thread, and starts from origin/main when the remote has it.",
    );
  });

  it("badges the checked-out branch current where it is not the default", () => {
    const onRelease = workspace({
      id: "ws-release",
      checkouts: [checkout(WEBSHOP.id, "release/2.4", ["main", "release/2.4"], "main")],
    });
    const field = branchField(
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
    const infra = workspace({
      id: "ws-infra",
      checkouts: [checkout(INFRA.id, "master", ["master"], "master")],
    });
    const field = branchField(
      { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }] },
      { workspaces: [PRIMARY, infra], runnerId: MOSS.id },
    );

    expect(field?.label).toBe("from main · master");
    expect(field?.locked).not.toBeNull();
  });

  it("names no branch at all where one of the repos has never been cloned", () => {
    const field = branchField(
      { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }] },
      around,
    );

    expect(field?.label).toBe("from default branches");
  });
});

describe("branchField: where there is no branch to speak of", () => {
  it("is absent on a workspace the thread joins, which is named after its branch", () => {
    expect(branchField({ kind: "existing", workspaceId: RUN_3F1.id }, around)).toBeNull();
  });

  it("is absent on a thread with no checkout", () => {
    expect(branchField({ kind: "none" }, around)).toBeNull();
  });
});

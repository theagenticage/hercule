/**
 * Naming the places a thread works in, and picking the one it opens in.
 *
 * What matters here is what `composer-fields.test.ts` does not reach: the two
 * names a workspace wears (its branch, or the repo and machine of a shared
 * checkout), and the two sentences for places nothing has been cloned into yet
 * - a repo no machine holds has no branch to name, so the clause goes rather
 * than being filled with a word standing in for "we do not know".
 */
import { describe, expect, it } from "vitest";
import {
  baseBranchOf,
  defaultWorkspacePick,
  draftSubject,
  pickKey,
  readyPrimary,
  repoName,
  runnerForPick,
  withBranch,
  workspaceLabel,
  workspaceLead,
  workspaceName,
} from "./workspaces";
import {
  COVE,
  INFRA,
  MOSS,
  PRIMARY,
  RUN_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  checkout,
  repo,
  workspace,
} from "./workspaces.testing";

describe("repoName", () => {
  it("is the last segment of the canonical remote", () => {
    expect(repoName(WEBSHOP)).toBe("webshop");
  });

  it("falls back to the label a resource that is not a repo carries", () => {
    expect(
      repoName({ ...repo("res-mail", null, null), kind: "mailbox", label: "work inbox" }),
    ).toBe("work inbox");
  });

  it("still reads as something for a resource the catalog no longer holds", () => {
    expect(repoName(undefined)).toBe("the repo");
  });
});

describe("workspaceName and workspaceLabel", () => {
  it("names a worktree after the branch it sits on", () => {
    expect(workspaceName(RUN_3F1)).toBe("hydra/run-3f1");
  });

  it("names a shared checkout after its repo and its machine", () => {
    expect(workspaceLabel(PRIMARY, [WEBSHOP], [MOSS])).toBe("webshop checkout · moss");
  });

  it("names a machine that is no longer in the fleet rather than going blank", () => {
    expect(workspaceLabel(PRIMARY, [WEBSHOP], [])).toBe("webshop checkout · unknown machine");
  });
});

describe("readyPrimary", () => {
  it("finds the repo's shared checkout on the machine asked about", () => {
    expect(readyPrimary([PRIMARY, RUN_3F1], WEBSHOP.id, MOSS.id)?.id).toBe(PRIMARY.id);
  });

  it("is nothing on another machine, and nothing while it is still being made", () => {
    expect(readyPrimary([PRIMARY], WEBSHOP.id, "r-cove")).toBeUndefined();
    expect(
      readyPrimary([{ ...PRIMARY, status: "provisioning" }], WEBSHOP.id, MOSS.id),
    ).toBeUndefined();
  });
});

describe("baseBranchOf", () => {
  it("takes the shared checkout on the picked machine, which is the clone a worktree is cut from", () => {
    const elsewhere = workspace({
      id: "ws-cove",
      runnerId: COVE.id,
      checkouts: [checkout(WEBSHOP.id, "main", ["main"], "trunk")],
    });

    expect(baseBranchOf([elsewhere, PRIMARY], WEBSHOP.id, MOSS.id)).toBe("main");
  });

  it("falls back to any machine that has cloned it: a default branch is the remote's fact", () => {
    expect(baseBranchOf([RUN_3F1], WEBSHOP.id, COVE.id)).toBe("main");
  });

  it("reads nothing off a workspace that is gone or was never made", () => {
    expect(baseBranchOf([{ ...PRIMARY, status: "failed" }], WEBSHOP.id, MOSS.id)).toBeNull();
    expect(baseBranchOf([{ ...PRIMARY, status: "deleted" }], WEBSHOP.id, MOSS.id)).toBeNull();
  });

  it("is nothing while no machine has cloned the repo at all", () => {
    expect(baseBranchOf([PRIMARY], INFRA.id, MOSS.id)).toBeNull();
  });
});

describe("pickKey", () => {
  it("does not tell two picks of one checkout apart by the branch, which is a choice inside it", () => {
    expect(pickKey({ kind: "primary", resourceId: WEBSHOP.id, branch: "release/2.4" })).toBe(
      pickKey({ kind: "primary", resourceId: WEBSHOP.id }),
    );
  });

  it("tells the four kinds apart", () => {
    expect(
      new Set([
        pickKey({ kind: "none" }),
        pickKey({ kind: "ephemeral", checkouts: [] }),
        pickKey({ kind: "primary", resourceId: WEBSHOP.id }),
        pickKey({ kind: "existing", workspaceId: RUN_3F1.id }),
      ]).size,
    ).toBe(4);
  });
});

describe("withBranch", () => {
  it("switches the shared checkout to it", () => {
    expect(withBranch({ kind: "primary", resourceId: WEBSHOP.id }, "release/2.4")).toEqual({
      kind: "primary",
      resourceId: WEBSHOP.id,
      branch: "release/2.4",
    });
  });

  it("starts a lone worktree from it, keeping the repo it is of", () => {
    expect(
      withBranch({ kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }] }, "release/2.4"),
    ).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id, baseBranch: "release/2.4" }],
    });
  });

  it("refuses a worktree of several repos rather than claiming they share a branch", () => {
    const many = {
      kind: "ephemeral" as const,
      checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }],
    };

    expect(withBranch(many, "main")).toEqual(many);
  });

  it("has nothing to switch on a joined workspace or on no checkout", () => {
    expect(withBranch({ kind: "existing", workspaceId: RUN_3F1.id }, "main")).toEqual({
      kind: "existing",
      workspaceId: RUN_3F1.id,
    });
    expect(withBranch({ kind: "none" }, "main")).toEqual({ kind: "none" });
  });
});

describe("runnerForPick", () => {
  it("takes the machine of the workspace a thread joins, which never moves", () => {
    expect(runnerForPick({ kind: "existing", workspaceId: RUN_3F1.id }, [RUN_3F1])).toBe(MOSS.id);
  });

  it("settles no machine for a pick that is not a workspace already standing", () => {
    expect(runnerForPick({ kind: "primary", resourceId: WEBSHOP.id }, [PRIMARY])).toBeNull();
    expect(runnerForPick({ kind: "existing", workspaceId: "ws-gone" }, [PRIMARY])).toBeNull();
  });
});

describe("draftSubject", () => {
  it("names the workspace a draft joins, which stands for itself", () => {
    expect(
      draftSubject({ kind: "existing", workspaceId: RUN_3F1.id }, [RUN_3F1], WEBSHOP_PROJECT),
    ).toEqual({ label: "hydra/run-3f1", projectId: null });
  });

  it("names the project a draft stands in, in the project's own hue", () => {
    expect(
      draftSubject({ kind: "primary", resourceId: WEBSHOP.id }, [PRIMARY], WEBSHOP_PROJECT),
    ).toEqual({ label: "webshop", projectId: WEBSHOP_PROJECT.id });
  });

  it("names nothing on a draft that stands in neither", () => {
    expect(draftSubject({ kind: "none" }, [], undefined)).toBeNull();
  });
});

describe("defaultWorkspacePick", () => {
  it("has nowhere to open a project with no repo, whatever the setting says", () => {
    expect(defaultWorkspacePick([], "primary")).toEqual({ kind: "none" });
  });

  it("takes the shared checkout of the first repo when the setting says primary", () => {
    expect(defaultWorkspacePick([INFRA, WEBSHOP], "primary")).toEqual({
      kind: "primary",
      resourceId: INFRA.id,
    });
  });
});

describe("workspaceLead", () => {
  const reading = { resources: [WEBSHOP, INFRA], workspaces: [PRIMARY], machine: "moss" };

  it("leaves the branch clause out of a checkout no machine holds yet", () => {
    expect(
      workspaceLead({ kind: "primary", resourceId: INFRA.id }, { ...reading, runnerId: MOSS.id }),
    ).toBe("It works in the checkout of ops-infra on moss. You and the agent share the files.");
  });

  it("says a base nothing has reported is the repo's own default branch", () => {
    expect(
      workspaceLead(
        { kind: "ephemeral", checkouts: [{ resourceId: INFRA.id }] },
        { ...reading, runnerId: MOSS.id },
      ),
    ).toBe("It gets its own worktree of ops-infra, on a new branch from its default branch.");
  });

  it("speaks of the repos together when a worktree is made of several", () => {
    expect(
      workspaceLead(
        { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }] },
        { ...reading, runnerId: MOSS.id },
      ),
    ).toBe("It gets a worktree of each repo, side by side, each on a new branch.");
  });

  it("says something about a workspace the catalog no longer holds", () => {
    expect(
      workspaceLead({ kind: "existing", workspaceId: "ws-gone" }, { ...reading, runnerId: null }),
    ).toContain("that workspace");
  });
});

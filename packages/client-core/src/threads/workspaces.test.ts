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
  composerPlaceholder,
  defaultWorkspacePick,
  preferredWorkspaceOf,
  draftSubject,
  pickKey,
  readyPrimary,
  repoName,
  runnerForPick,
  withBranch,
  labelText,
  workspaceLabel,
  workspaceLabelParts,
  phraseText,
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

  it("names a main workspace after its repo and its machine", () => {
    expect(workspaceLabel(PRIMARY, [WEBSHOP], [MOSS])).toBe("webshop · moss");
  });

  it("names a machine that is no longer in the fleet rather than going blank", () => {
    expect(workspaceLabel(PRIMARY, [WEBSHOP], [])).toBe("webshop · unknown machine");
  });

  // The sidebar is narrower than some of these labels, and the machine is what
  // tells one repo's two checkouts apart: the repo is what gives way.
  it("splits a main workspace's label into the repo, which may be cut, and the rest", () => {
    expect(workspaceLabelParts(PRIMARY, [WEBSHOP], [MOSS])).toEqual({
      clip: "webshop",
      keep: " · moss",
    });
  });

  it("gives a worktree's whole name as the part that may be cut: it is one word", () => {
    expect(workspaceLabelParts(RUN_3F1, [WEBSHOP], [MOSS])).toEqual({
      clip: "hydra/run-3f1",
      keep: "",
    });
  });

  it("reads both parts back as the one label a tooltip shows", () => {
    expect(labelText(workspaceLabelParts(PRIMARY, [WEBSHOP], [MOSS]))).toBe("webshop · moss");
  });
});

describe("readyPrimary", () => {
  it("finds the repo's main workspace on the machine asked about", () => {
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
  it("takes the main workspace on the picked machine, which is the clone a worktree is cut from", () => {
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
  it("switches the main workspace's checkout to it", () => {
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

  it("takes the main workspace of the first repo when the setting says primary", () => {
    expect(defaultWorkspacePick([INFRA, WEBSHOP], "primary")).toEqual({
      kind: "primary",
      resourceId: INFRA.id,
    });
  });

  // D-20d dropped `none` from the setting; one stored before that reads as
  // unset, so the rule decides rather than a value nobody can set any more.
  it("reads a stored none as nothing stored", () => {
    expect(preferredWorkspaceOf("none")).toBeNull();
    expect(preferredWorkspaceOf(undefined)).toBeNull();
    expect(preferredWorkspaceOf("primary")).toBe("primary");
    expect(preferredWorkspaceOf("ephemeral")).toBe("ephemeral");
    expect(defaultWorkspacePick([WEBSHOP], preferredWorkspaceOf("none"))).toEqual({
      kind: "primary",
      resourceId: WEBSHOP.id,
    });
  });
});

describe("composerPlaceholder", () => {
  const ask = (over: Partial<Parameters<typeof composerPlaceholder>[0]> = {}) =>
    composerPlaceholder({
      readOnly: null,
      busy: false,
      active: false,
      pick: { kind: "none" },
      workspaces: [RUN_3F1],
      ...over,
    });

  it("asks a fresh draft what it should do", () => {
    expect(ask()).toBe("Say what you want done…");
  });

  it("names the workspace a draft joins, whose files already stand", () => {
    expect(ask({ pick: { kind: "existing", workspaceId: RUN_3F1.id } })).toBe(
      "Say what this thread should do in hydra/run-3f1…",
    );
  });

  it("asks for a reply on a thread that has started", () => {
    expect(ask({ active: true })).toBe("Reply…");
  });

  it("says input is queued while the turn runs, and why it takes none at all", () => {
    expect(ask({ active: true, busy: true })).toBe("Queued until the turn finishes…");
    expect(ask({ active: true, readOnly: "its runner is gone" })).toBe(
      "This thread can't be resumed: its runner is gone.",
    );
  });
});

describe("workspaceLead", () => {
  const reading = { resources: [WEBSHOP, INFRA], workspaces: [PRIMARY], machine: "moss" };

  /** The sentence as it reads; which parts of it are mono is a claim of its own. */
  const lead = (...args: Parameters<typeof workspaceLead>): string =>
    phraseText(workspaceLead(...args));

  it("leaves the branch clause out of a checkout no machine holds yet", () => {
    expect(lead({ kind: "primary", resourceId: INFRA.id }, { ...reading, runnerId: MOSS.id })).toBe(
      "It works in the main workspace of ops-infra on moss. You and the agent share the files.",
    );
  });

  it("sets the branch it names in mono, as a git word is set everywhere", () => {
    expect(
      workspaceLead({ kind: "primary", resourceId: WEBSHOP.id }, { ...reading, runnerId: MOSS.id }),
    ).toContainEqual({ text: "main", mono: true });
  });

  it("says a base nothing has reported is the repo's own default branch", () => {
    expect(
      lead(
        { kind: "ephemeral", checkouts: [{ resourceId: INFRA.id }] },
        { ...reading, runnerId: MOSS.id },
      ),
    ).toBe("It gets its own worktree of ops-infra, on a new branch from its default branch.");
  });

  it("speaks of the repos together when a worktree is made of several", () => {
    expect(
      lead(
        { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }] },
        { ...reading, runnerId: MOSS.id },
      ),
    ).toBe("It gets a worktree of each repo, side by side, each on a new branch.");
  });

  it("says something about a workspace the catalog no longer holds", () => {
    expect(
      lead({ kind: "existing", workspaceId: "ws-gone" }, { ...reading, runnerId: null }),
    ).toContain("that workspace");
  });
});

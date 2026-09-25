/**
 * Tests naming the workspaces a thread works in, and picking the one it opens
 * in.
 *
 * These tests cover what `composer-fields.test.ts` does not: the two kinds of
 * workspace name (a branch, or the repo and runner of a main workspace), and
 * the lead sentences for repos that no runner has cloned yet. Such a repo has
 * no known branch, so the branch clause is left out rather than filled with a
 * word for "unknown".
 */
import { describe, expect, it } from "vitest";
import {
  findBaseBranch,
  buildComposerPlaceholder,
  decideDefaultWorkspacePick,
  parsePreferredWorkspace,
  findDraftSubject,
  buildPickKey,
  findReadyPrimary,
  formatRepoName,
  findRunnerForPick,
  withBranch,
  joinLabelText,
  formatWorkspaceLabel,
  buildWorkspaceLabelParts,
  joinPhraseText,
  buildWorkspaceLead,
  formatWorkspaceName,
} from "./workspaces";
import { pickProjectTone } from "./tone";
import {
  COVE,
  INFRA,
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildCheckout,
  buildRepo,
  buildWorkspace,
} from "./workspaces.testing";

describe("formatRepoName", () => {
  it("returns the last segment of the canonical remote", () => {
    expect(formatRepoName(WEBSHOP)).toBe("webshop");
  });

  it("falls back to the label of a resource that is not a repo", () => {
    expect(
      formatRepoName({
        ...buildRepo("res-mail", null, null),
        kind: "mailbox",
        label: "work inbox",
      }),
    ).toBe("work inbox");
  });

  it("returns a placeholder for a resource that no longer exists", () => {
    expect(formatRepoName(undefined)).toBe("the repo");
  });
});

describe("formatWorkspaceName and formatWorkspaceLabel", () => {
  it("names a worktree after its branch", () => {
    expect(formatWorkspaceName(THREAD_3F1)).toBe("hercule/thread-3f1");
  });

  it("names a main workspace after its repo and its runner", () => {
    expect(formatWorkspaceLabel(PRIMARY, [WEBSHOP], [MOSS])).toBe("webshop · moss");
  });

  it("shows a placeholder for a runner that is no longer in the fleet rather than a blank", () => {
    expect(formatWorkspaceLabel(PRIMARY, [WEBSHOP], [])).toBe("webshop · unknown machine");
  });

  // The sidebar is narrower than some of these labels, and the runner name is
  // what tells one repo's main workspaces apart, so the repo name is
  // truncated instead.
  it("splits a main workspace's label into the repo, which may be truncated, and the rest", () => {
    expect(buildWorkspaceLabelParts(PRIMARY, [WEBSHOP], [MOSS])).toEqual({
      clip: "webshop",
      keep: " · moss",
    });
  });

  it("lets a worktree's whole name be truncated, because it is one word", () => {
    expect(buildWorkspaceLabelParts(THREAD_3F1, [WEBSHOP], [MOSS])).toEqual({
      clip: "hercule/thread-3f1",
      keep: "",
    });
  });

  it("joins both parts into the label a tooltip shows", () => {
    expect(joinLabelText(buildWorkspaceLabelParts(PRIMARY, [WEBSHOP], [MOSS]))).toBe(
      "webshop · moss",
    );
  });
});

describe("findReadyPrimary", () => {
  it("finds the repo's main workspace on the given runner", () => {
    expect(findReadyPrimary([PRIMARY, THREAD_3F1], WEBSHOP.id, MOSS.id)?.id).toBe(PRIMARY.id);
  });

  it("returns undefined on another runner, and while the workspace is still being created", () => {
    expect(findReadyPrimary([PRIMARY], WEBSHOP.id, "r-cove")).toBeUndefined();
    expect(
      findReadyPrimary([{ ...PRIMARY, status: "provisioning" }], WEBSHOP.id, MOSS.id),
    ).toBeUndefined();
  });
});

describe("findBaseBranch", () => {
  it("uses the main workspace on the picked runner, which is the clone a worktree is created from", () => {
    const elsewhere = buildWorkspace({
      id: "ws-cove",
      runnerId: COVE.id,
      checkouts: [buildCheckout(WEBSHOP.id, "main", ["main"], "trunk")],
    });

    expect(findBaseBranch([elsewhere, PRIMARY], WEBSHOP.id, MOSS.id)).toBe("main");
  });

  it("falls back to any runner that has cloned the repo, because the default branch belongs to the remote", () => {
    expect(findBaseBranch([THREAD_3F1], WEBSHOP.id, COVE.id)).toBe("main");
  });

  it("ignores a failed or deleted workspace", () => {
    expect(findBaseBranch([{ ...PRIMARY, status: "failed" }], WEBSHOP.id, MOSS.id)).toBeNull();
    expect(findBaseBranch([{ ...PRIMARY, status: "deleted" }], WEBSHOP.id, MOSS.id)).toBeNull();
  });

  it("returns null while no runner has cloned the repo", () => {
    expect(findBaseBranch([PRIMARY], INFRA.id, MOSS.id)).toBeNull();
  });
});

describe("buildPickKey", () => {
  it("gives two picks of the same checkout the same key, whatever their branch", () => {
    expect(buildPickKey({ kind: "primary", resourceId: WEBSHOP.id, branch: "release/2.4" })).toBe(
      buildPickKey({ kind: "primary", resourceId: WEBSHOP.id }),
    );
  });

  it("tells the four kinds apart", () => {
    expect(
      new Set([
        buildPickKey({ kind: "none" }),
        buildPickKey({ kind: "ephemeral", checkouts: [] }),
        buildPickKey({ kind: "primary", resourceId: WEBSHOP.id }),
        buildPickKey({ kind: "existing", workspaceId: THREAD_3F1.id }),
      ]).size,
    ).toBe(4);
  });
});

describe("withBranch", () => {
  it("sets the branch the main workspace switches to", () => {
    expect(withBranch({ kind: "primary", resourceId: WEBSHOP.id }, "release/2.4")).toEqual({
      kind: "primary",
      resourceId: WEBSHOP.id,
      branch: "release/2.4",
    });
  });

  it("sets the base branch of a single-repo worktree, keeping its repo", () => {
    expect(
      withBranch({ kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }] }, "release/2.4"),
    ).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id, baseBranch: "release/2.4" }],
    });
  });

  it("leaves a worktree of several repos unchanged rather than giving them all one branch", () => {
    const many = {
      kind: "ephemeral" as const,
      checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }],
    };

    expect(withBranch(many, "main")).toEqual(many);
  });

  it("leaves a joined workspace and a pick with no checkout unchanged", () => {
    expect(withBranch({ kind: "existing", workspaceId: THREAD_3F1.id }, "main")).toEqual({
      kind: "existing",
      workspaceId: THREAD_3F1.id,
    });
    expect(withBranch({ kind: "none" }, "main")).toEqual({ kind: "none" });
  });
});

describe("findRunnerForPick", () => {
  it("returns the runner of the workspace a thread joins, which never moves", () => {
    expect(findRunnerForPick({ kind: "existing", workspaceId: THREAD_3F1.id }, [THREAD_3F1])).toBe(
      MOSS.id,
    );
  });

  it("returns null for a pick that is not an existing workspace", () => {
    expect(findRunnerForPick({ kind: "primary", resourceId: WEBSHOP.id }, [PRIMARY])).toBeNull();
    expect(findRunnerForPick({ kind: "existing", workspaceId: "ws-gone" }, [PRIMARY])).toBeNull();
  });
});

describe("findDraftSubject", () => {
  // The hue depends on the project list, so the subject includes the hue
  // rather than making every screen look it up again from the id.
  const PROJECTS = [OPS_PROJECT, WEBSHOP_PROJECT];

  it("names the workspace a draft joins, with no project hue", () => {
    expect(
      findDraftSubject(
        { kind: "existing", workspaceId: THREAD_3F1.id },
        [THREAD_3F1],
        WEBSHOP_PROJECT.id,
        PROJECTS,
      ),
    ).toEqual({ label: "hercule/thread-3f1", projectId: null, tone: null });
  });

  it("names the draft's project, with the hue from the project list", () => {
    expect(
      findDraftSubject(
        { kind: "primary", resourceId: WEBSHOP.id },
        [PRIMARY],
        WEBSHOP_PROJECT.id,
        PROJECTS,
      ),
    ).toEqual({
      label: "webshop",
      projectId: WEBSHOP_PROJECT.id,
      tone: pickProjectTone(WEBSHOP_PROJECT.id, PROJECTS),
    });
  });

  it("returns null for a draft with neither", () => {
    expect(findDraftSubject({ kind: "none" }, [], null, PROJECTS)).toBeNull();
  });
});

describe("decideDefaultWorkspacePick", () => {
  it("returns none for a project with no repo, whatever the setting", () => {
    expect(decideDefaultWorkspacePick([], "primary")).toEqual({ kind: "none" });
  });

  it("uses the first repo's main workspace when the setting is primary", () => {
    expect(decideDefaultWorkspacePick([INFRA, WEBSHOP], "primary")).toEqual({
      kind: "primary",
      resourceId: INFRA.id,
    });
  });

  // `none` is no longer a valid setting. A `none` stored by an older version
  // counts as unset, so the default rule decides rather than a value nobody
  // can set any more.
  it("treats a stored none as unset", () => {
    expect(parsePreferredWorkspace("none")).toBeNull();
    expect(parsePreferredWorkspace(undefined)).toBeNull();
    expect(parsePreferredWorkspace("primary")).toBe("primary");
    expect(parsePreferredWorkspace("ephemeral")).toBe("ephemeral");
    expect(decideDefaultWorkspacePick([WEBSHOP], parsePreferredWorkspace("none"))).toEqual({
      kind: "primary",
      resourceId: WEBSHOP.id,
    });
  });
});

describe("buildComposerPlaceholder", () => {
  const buildPlaceholder = (over: Partial<Parameters<typeof buildComposerPlaceholder>[0]> = {}) =>
    buildComposerPlaceholder({
      readOnly: null,
      busy: false,
      active: false,
      pick: { kind: "none" },
      workspaces: [THREAD_3F1],
      ...over,
    });

  it("asks a fresh draft what it should do", () => {
    expect(buildPlaceholder()).toBe("Say what you want done…");
  });

  it("names the workspace a draft joins, whose files already exist", () => {
    expect(buildPlaceholder({ pick: { kind: "existing", workspaceId: THREAD_3F1.id } })).toBe(
      "Say what this thread should do in hercule/thread-3f1…",
    );
  });

  it("asks for a reply on a thread that has started", () => {
    expect(buildPlaceholder({ active: true })).toBe("Reply…");
  });

  it("says input is queued while a turn runs, and why a thread takes no input", () => {
    expect(buildPlaceholder({ active: true, busy: true })).toBe("Queued until the turn finishes…");
    expect(buildPlaceholder({ active: true, readOnly: "its runner is gone" })).toBe(
      "This thread can't be resumed: its runner is gone.",
    );
  });
});

describe("buildWorkspaceLead", () => {
  const reading = { resources: [WEBSHOP, INFRA], workspaces: [PRIMARY], machine: "moss" };

  /** Returns the lead as plain text. Which parts are mono is tested separately. */
  const readLeadText = (...args: Parameters<typeof buildWorkspaceLead>): string =>
    joinPhraseText(buildWorkspaceLead(...args));

  it("leaves out the branch clause for a repo no runner has cloned yet", () => {
    expect(
      readLeadText({ kind: "primary", resourceId: INFRA.id }, { ...reading, runnerId: MOSS.id }),
    ).toBe(
      "It works in the main workspace of ops-infra on moss. You and the agent share the files.",
    );
  });

  it("sets the branch name in mono, as git names are everywhere", () => {
    expect(
      buildWorkspaceLead(
        { kind: "primary", resourceId: WEBSHOP.id },
        { ...reading, runnerId: MOSS.id },
      ),
    ).toContainEqual({ text: "main", mono: true });
  });

  it("says the new branch starts from the default branch when no base is known", () => {
    expect(
      readLeadText(
        { kind: "ephemeral", checkouts: [{ resourceId: INFRA.id }] },
        { ...reading, runnerId: MOSS.id },
      ),
    ).toBe("It gets its own worktree of ops-infra, on a new branch from its default branch.");
  });

  it("describes all repos together for a worktree of several repos", () => {
    expect(
      readLeadText(
        { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }] },
        { ...reading, runnerId: MOSS.id },
      ),
    ).toBe("It gets a worktree of each repo, side by side, each on a new branch.");
  });

  it("still produces a sentence for a workspace that no longer exists", () => {
    expect(
      readLeadText({ kind: "existing", workspaceId: "ws-gone" }, { ...reading, runnerId: null }),
    ).toContain("that workspace");
  });
});

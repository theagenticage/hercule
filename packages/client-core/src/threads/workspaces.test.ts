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
  RUN_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildCheckout,
  buildRepo,
  buildWorkspace,
} from "./workspaces.testing";

describe("formatRepoName", () => {
  it("is the last segment of the canonical remote", () => {
    expect(formatRepoName(WEBSHOP)).toBe("webshop");
  });

  it("falls back to the label a resource that is not a repo carries", () => {
    expect(
      formatRepoName({
        ...buildRepo("res-mail", null, null),
        kind: "mailbox",
        label: "work inbox",
      }),
    ).toBe("work inbox");
  });

  it("still reads as something for a resource the catalog no longer holds", () => {
    expect(formatRepoName(undefined)).toBe("the repo");
  });
});

describe("formatWorkspaceName and formatWorkspaceLabel", () => {
  it("names a worktree after the branch it sits on", () => {
    expect(formatWorkspaceName(RUN_3F1)).toBe("hercule/run-3f1");
  });

  it("names a main workspace after its repo and its machine", () => {
    expect(formatWorkspaceLabel(PRIMARY, [WEBSHOP], [MOSS])).toBe("webshop · moss");
  });

  it("names a machine that is no longer in the fleet rather than going blank", () => {
    expect(formatWorkspaceLabel(PRIMARY, [WEBSHOP], [])).toBe("webshop · unknown machine");
  });

  // The sidebar is narrower than some of these labels, and the machine is what
  // tells one repo's two checkouts apart: the repo is what gives way.
  it("splits a main workspace's label into the repo, which may be cut, and the rest", () => {
    expect(buildWorkspaceLabelParts(PRIMARY, [WEBSHOP], [MOSS])).toEqual({
      clip: "webshop",
      keep: " · moss",
    });
  });

  it("gives a worktree's whole name as the part that may be cut: it is one word", () => {
    expect(buildWorkspaceLabelParts(RUN_3F1, [WEBSHOP], [MOSS])).toEqual({
      clip: "hercule/run-3f1",
      keep: "",
    });
  });

  it("reads both parts back as the one label a tooltip shows", () => {
    expect(joinLabelText(buildWorkspaceLabelParts(PRIMARY, [WEBSHOP], [MOSS]))).toBe(
      "webshop · moss",
    );
  });
});

describe("findReadyPrimary", () => {
  it("finds the repo's main workspace on the machine asked about", () => {
    expect(findReadyPrimary([PRIMARY, RUN_3F1], WEBSHOP.id, MOSS.id)?.id).toBe(PRIMARY.id);
  });

  it("is nothing on another machine, and nothing while it is still being made", () => {
    expect(findReadyPrimary([PRIMARY], WEBSHOP.id, "r-cove")).toBeUndefined();
    expect(
      findReadyPrimary([{ ...PRIMARY, status: "provisioning" }], WEBSHOP.id, MOSS.id),
    ).toBeUndefined();
  });
});

describe("findBaseBranch", () => {
  it("takes the main workspace on the picked machine, which is the clone a worktree is cut from", () => {
    const elsewhere = buildWorkspace({
      id: "ws-cove",
      runnerId: COVE.id,
      checkouts: [buildCheckout(WEBSHOP.id, "main", ["main"], "trunk")],
    });

    expect(findBaseBranch([elsewhere, PRIMARY], WEBSHOP.id, MOSS.id)).toBe("main");
  });

  it("falls back to any machine that has cloned it: a default branch is the remote's fact", () => {
    expect(findBaseBranch([RUN_3F1], WEBSHOP.id, COVE.id)).toBe("main");
  });

  it("reads nothing off a workspace that is gone or was never made", () => {
    expect(findBaseBranch([{ ...PRIMARY, status: "failed" }], WEBSHOP.id, MOSS.id)).toBeNull();
    expect(findBaseBranch([{ ...PRIMARY, status: "deleted" }], WEBSHOP.id, MOSS.id)).toBeNull();
  });

  it("is nothing while no machine has cloned the repo at all", () => {
    expect(findBaseBranch([PRIMARY], INFRA.id, MOSS.id)).toBeNull();
  });
});

describe("buildPickKey", () => {
  it("does not tell two picks of one checkout apart by the branch, which is a choice inside it", () => {
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
        buildPickKey({ kind: "existing", workspaceId: RUN_3F1.id }),
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

describe("findRunnerForPick", () => {
  it("takes the machine of the workspace a thread joins, which never moves", () => {
    expect(findRunnerForPick({ kind: "existing", workspaceId: RUN_3F1.id }, [RUN_3F1])).toBe(
      MOSS.id,
    );
  });

  it("settles no machine for a pick that is not a workspace already standing", () => {
    expect(findRunnerForPick({ kind: "primary", resourceId: WEBSHOP.id }, [PRIMARY])).toBeNull();
    expect(findRunnerForPick({ kind: "existing", workspaceId: "ws-gone" }, [PRIMARY])).toBeNull();
  });
});

describe("findDraftSubject", () => {
  // R6: the hue is the listing's to say, so the subject carries the answer
  // rather than the id every surface would have to read it from again.
  const PROJECTS = [OPS_PROJECT, WEBSHOP_PROJECT];

  it("names the workspace a draft joins, which stands for itself and wears no hue", () => {
    expect(
      findDraftSubject(
        { kind: "existing", workspaceId: RUN_3F1.id },
        [RUN_3F1],
        WEBSHOP_PROJECT.id,
        PROJECTS,
      ),
    ).toEqual({ label: "hercule/run-3f1", projectId: null, tone: null });
  });

  it("names the project a draft stands in, in the hue the listing gives it", () => {
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

  it("names nothing on a draft that stands in neither", () => {
    expect(findDraftSubject({ kind: "none" }, [], null, PROJECTS)).toBeNull();
  });
});

describe("decideDefaultWorkspacePick", () => {
  it("has nowhere to open a project with no repo, whatever the setting says", () => {
    expect(decideDefaultWorkspacePick([], "primary")).toEqual({ kind: "none" });
  });

  it("takes the main workspace of the first repo when the setting says primary", () => {
    expect(decideDefaultWorkspacePick([INFRA, WEBSHOP], "primary")).toEqual({
      kind: "primary",
      resourceId: INFRA.id,
    });
  });

  // D-20d dropped `none` from the setting; one stored before that reads as
  // unset, so the rule decides rather than a value nobody can set any more.
  it("reads a stored none as nothing stored", () => {
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
      workspaces: [RUN_3F1],
      ...over,
    });

  it("asks a fresh draft what it should do", () => {
    expect(buildPlaceholder()).toBe("Say what you want done…");
  });

  it("names the workspace a draft joins, whose files already stand", () => {
    expect(buildPlaceholder({ pick: { kind: "existing", workspaceId: RUN_3F1.id } })).toBe(
      "Say what this thread should do in hercule/run-3f1…",
    );
  });

  it("asks for a reply on a thread that has started", () => {
    expect(buildPlaceholder({ active: true })).toBe("Reply…");
  });

  it("says input is queued while the turn runs, and why it takes none at all", () => {
    expect(buildPlaceholder({ active: true, busy: true })).toBe("Queued until the turn finishes…");
    expect(buildPlaceholder({ active: true, readOnly: "its runner is gone" })).toBe(
      "This thread can't be resumed: its runner is gone.",
    );
  });
});

describe("buildWorkspaceLead", () => {
  const reading = { resources: [WEBSHOP, INFRA], workspaces: [PRIMARY], machine: "moss" };

  /** The sentence as it reads; which parts of it are mono is a claim of its own. */
  const readLeadText = (...args: Parameters<typeof buildWorkspaceLead>): string =>
    joinPhraseText(buildWorkspaceLead(...args));

  it("leaves the branch clause out of a checkout no machine holds yet", () => {
    expect(
      readLeadText({ kind: "primary", resourceId: INFRA.id }, { ...reading, runnerId: MOSS.id }),
    ).toBe(
      "It works in the main workspace of ops-infra on moss. You and the agent share the files.",
    );
  });

  it("sets the branch it names in mono, as a git word is set everywhere", () => {
    expect(
      buildWorkspaceLead(
        { kind: "primary", resourceId: WEBSHOP.id },
        { ...reading, runnerId: MOSS.id },
      ),
    ).toContainEqual({ text: "main", mono: true });
  });

  it("says a base nothing has reported is the repo's own default branch", () => {
    expect(
      readLeadText(
        { kind: "ephemeral", checkouts: [{ resourceId: INFRA.id }] },
        { ...reading, runnerId: MOSS.id },
      ),
    ).toBe("It gets its own worktree of ops-infra, on a new branch from its default branch.");
  });

  it("speaks of the repos together when a worktree is made of several", () => {
    expect(
      readLeadText(
        { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }, { resourceId: INFRA.id }] },
        { ...reading, runnerId: MOSS.id },
      ),
    ).toBe("It gets a worktree of each repo, side by side, each on a new branch.");
  });

  it("says something about a workspace the catalog no longer holds", () => {
    expect(
      readLeadText({ kind: "existing", workspaceId: "ws-gone" }, { ...reading, runnerId: null }),
    ).toContain("that workspace");
  });
});

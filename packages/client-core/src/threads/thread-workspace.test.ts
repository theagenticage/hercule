/**
 * Tests `buildThreadWorkspaceLabel(session, workspaces)`, which returns the
 * pieces of the label that names the workspace a started thread works in.
 */
import { describe, expect, it } from "vitest";
import type { Workspace } from "@hercule/contract";
import { buildThreadWorkspaceLabel } from "@hercule/client-core";
import { buildCheckout, buildSession, buildWorkspace } from "@hercule/client-core/threads/testing";

const PRIMARY = buildWorkspace({
  id: "w-primary",
  kind: "primary",
  checkouts: [buildCheckout("r-webshop", "main")],
});

/** Returns an ephemeral workspace of webshop on `hercule/thread-3f1`, with `over` applied to its checkout. */
const buildEphemeral = (over: Partial<Workspace["checkouts"][number]> = {}): Workspace =>
  buildWorkspace({
    id: "w-ephemeral",
    kind: "ephemeral",
    checkouts: [{ ...buildCheckout("r-webshop", "hercule/thread-3f1"), form: "worktree", ...over }],
  });

/** Returns the label of a thread in webshop's project that works in `workspaceId`. */
const buildLabel = (workspaceId: string | null, workspaces: readonly Workspace[]) =>
  buildThreadWorkspaceLabel(buildSession({ id: "s1", projectId: "p1", workspaceId }), workspaces);

describe("buildThreadWorkspaceLabel", () => {
  it("names a main workspace, then its branch, with no base", () => {
    expect(buildLabel(PRIMARY.id, [PRIMARY, buildEphemeral()])).toEqual([
      { kind: "workspace", text: "Main workspace" },
      { kind: "branch", text: "main", startedFrom: null },
    ]);
  });

  it("leaves out a main workspace's branch while the runner has not reported one", () => {
    const cloning = { ...PRIMARY, checkouts: [buildCheckout("r-webshop", null)] };

    expect(buildLabel(PRIMARY.id, [cloning])).toEqual([
      { kind: "workspace", text: "Main workspace" },
    ]);
  });

  it("names an ephemeral workspace by its branch alone, started from the base the caller named", () => {
    const ephemeral = buildEphemeral({ baseBranch: "release/2.4", defaultBranch: "main" });

    expect(buildLabel(ephemeral.id, [PRIMARY, ephemeral])).toEqual([
      { kind: "branch", text: "hercule/thread-3f1", startedFrom: "from release/2.4" },
    ]);
  });

  it("starts an ephemeral workspace from its repo's default branch when the caller named no base", () => {
    const ephemeral = buildEphemeral({ baseBranch: null, defaultBranch: "trunk" });

    expect(buildLabel(ephemeral.id, [ephemeral])).toEqual([
      { kind: "branch", text: "hercule/thread-3f1", startedFrom: "from trunk" },
    ]);
  });

  it("gives an ephemeral workspace no base when neither the named base nor the default branch is known", () => {
    const ephemeral = buildEphemeral({ baseBranch: null, defaultBranch: null });

    expect(buildLabel(ephemeral.id, [ephemeral])).toEqual([
      { kind: "branch", text: "hercule/thread-3f1", startedFrom: null },
    ]);
  });

  it("calls a workspace with no branch, or with no record, a workspace", () => {
    const scratch = buildWorkspace({ id: "w-scratch", kind: "ephemeral", checkouts: [] });

    for (const workspaceId of [scratch.id, "w-unknown"]) {
      expect(buildLabel(workspaceId, [scratch])).toEqual([
        { kind: "workspace", text: "Workspace" },
      ]);
    }
  });

  it("says a thread has no workspace as the workspace menu does", () => {
    expect(buildLabel(null, [PRIMARY])).toEqual([{ kind: "workspace", text: "None" }]);
    expect(buildThreadWorkspaceLabel(buildSession({ id: "s1" }), [PRIMARY])).toEqual([
      { kind: "workspace", text: "No workspace" },
    ]);
  });
});

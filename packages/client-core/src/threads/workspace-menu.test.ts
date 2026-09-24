/**
 * Tests the rows the workspace selector offers. Every row is a workspace that
 * exists or one that would be created, in an order that depends on the
 * project (a worktree of each repo comes first when there are several repos).
 * A row that is not available yet says why rather than being hidden.
 */
import { describe, expect, it } from "vitest";
import { buildWorkspaceMenu } from "./workspace-menu";
import {
  COVE,
  INFRA,
  MOSS,
  PRIMARY,
  RUN_3F1,
  RUNBOOKS,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildProject,
  buildSession,
} from "./workspaces.testing";

const SESSIONS = [
  buildSession({ id: "s-flaky", title: "Fix flaky webhook tests" }),
  buildSession({ id: "s-runbook", title: "Write the retry runbook" }),
];

const buildMenu = (over: Partial<Parameters<typeof buildWorkspaceMenu>[0]> = {}) =>
  buildWorkspaceMenu({
    project: WEBSHOP_PROJECT,
    repos: [WEBSHOP],
    workspaces: [PRIMARY, RUN_3F1],
    sessions: SESSIONS,
    runners: [MOSS, COVE],
    runnerId: MOSS.id,
    pick: { kind: "primary", resourceId: WEBSHOP.id },
    ...over,
  });

describe("buildWorkspaceMenu", () => {
  // A project with a repo never offers None.
  it("puts the main workspace first in a project with one repo", () => {
    expect(buildMenu().rows.map((row) => row.name)).toEqual([
      "Main workspace",
      "New workspace",
      "hercule/run-3f1",
    ]);
  });

  it("puts a worktree of each repo first in a project with several repos, naming each main workspace", () => {
    const rows = buildMenu({ repos: [INFRA, RUNBOOKS], workspaces: [] }).rows;

    expect(rows.map((row) => row.name)).toEqual([
      "New workspace",
      "Main workspace of ops-infra",
      "Main workspace of ops-runbooks",
    ]);
    expect(rows[0]?.sub).toBe("a worktree of each repo, side by side, each on a new branch");
  });

  it("shows a main workspace's branch, or that it is not cloned on the runner yet", () => {
    expect(buildMenu().rows[0]?.sub).toBe("on main · you and the agent share the files");
    expect(buildMenu({ runnerId: COVE.id }).rows[0]?.sub).toBe(
      "not cloned on cove · clones on first use",
    );
  });

  it("names a live worktree after its branch, with its runner and its threads", () => {
    const row = buildMenu().rows[2];

    expect(row?.mono).toBe(true);
    expect(row?.note).toBe("moss");
    expect(row?.sub).toBe("2 threads · “Fix flaky webhook tests”, “Write the retry runbook”");
  });

  // None is offered only when there is nothing else to offer.
  it("offers None alone in a project with no repo", () => {
    const empty = buildMenu({
      repos: [],
      workspaces: [],
      project: buildProject("p-sandbox", "sandbox"),
    });

    expect(empty.rows.map((row) => row.name)).toEqual(["None"]);
  });

  it("calls the row No workspace for a draft with no project", () => {
    const loose = buildMenu({ repos: [], workspaces: [], project: undefined });

    expect(loose.rows.map((row) => row.name)).toEqual(["No workspace"]);
  });

  it("uses the current row's name as the selector's label", () => {
    expect(buildMenu().label).toBe("Main workspace");
    expect(buildMenu({ pick: { kind: "existing", workspaceId: RUN_3F1.id } }).label).toBe(
      "hercule/run-3f1",
    );
  });
});

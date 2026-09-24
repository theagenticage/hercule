/**
 * The rows the workspace selector offers. What matters: every row is a thing
 * that exists or a thing that would be made, in the order the project's shape
 * decides (a worktree of each repo leads where there are several), and a row
 * that cannot be had yet says why rather than going missing.
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
  // D-20d: a project that holds a repo never offers None.
  it("leads with the main workspace in a project that holds one repo", () => {
    expect(buildMenu().rows.map((row) => row.name)).toEqual([
      "Main workspace",
      "New workspace",
      "hercule/run-3f1",
    ]);
  });

  it("leads with a worktree of each repo in a project that holds several, naming each checkout", () => {
    const rows = buildMenu({ repos: [INFRA, RUNBOOKS], workspaces: [] }).rows;

    expect(rows.map((row) => row.name)).toEqual([
      "New workspace",
      "Main workspace of ops-infra",
      "Main workspace of ops-runbooks",
    ]);
    expect(rows[0]?.sub).toBe("a worktree of each repo, side by side, each on a new branch");
  });

  it("says what a main workspace is on, and says so when the machine has none", () => {
    expect(buildMenu().rows[0]?.sub).toBe("on main · you and the agent share the files");
    expect(buildMenu({ runnerId: COVE.id }).rows[0]?.sub).toBe(
      "not cloned on cove · clones on first use",
    );
  });

  it("names a live worktree after its branch, with its machine and the threads in it", () => {
    const row = buildMenu().rows[2];

    expect(row?.mono).toBe(true);
    expect(row?.note).toBe("moss");
    expect(row?.sub).toBe("2 threads · “Fix flaky webhook tests”, “Write the retry runbook”");
  });

  // D-20d: None is offered only where there is nothing else to offer.
  it("offers None alone in a project with no repo", () => {
    const empty = buildMenu({
      repos: [],
      workspaces: [],
      project: buildProject("p-sandbox", "sandbox"),
    });

    expect(empty.rows.map((row) => row.name)).toEqual(["None"]);
  });

  it("calls it No workspace on a draft that stands in no project", () => {
    const loose = buildMenu({ repos: [], workspaces: [], project: undefined });

    expect(loose.rows.map((row) => row.name)).toEqual(["No workspace"]);
  });

  it("reads the trigger off the row in force", () => {
    expect(buildMenu().label).toBe("Main workspace");
    expect(buildMenu({ pick: { kind: "existing", workspaceId: RUN_3F1.id } }).label).toBe(
      "hercule/run-3f1",
    );
  });
});

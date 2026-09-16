/**
 * The rows the workspace selector offers. What matters: every row is a thing
 * that exists or a thing that would be made, in the order the project's shape
 * decides (a worktree of each repo leads where there are several), and a row
 * that cannot be had yet says why rather than going missing.
 */
import { describe, expect, it } from "vitest";
import { workspaceMenu } from "./workspace-menu";
import {
  COVE,
  INFRA,
  MOSS,
  PRIMARY,
  RUN_3F1,
  RUNBOOKS,
  WEBSHOP,
  WEBSHOP_PROJECT,
  project,
  session,
} from "./workspaces.testing";

const SESSIONS = [
  session({ id: "s-flaky", title: "Fix flaky webhook tests" }),
  session({ id: "s-runbook", title: "Write the retry runbook" }),
];

const menu = (over: Partial<Parameters<typeof workspaceMenu>[0]> = {}) =>
  workspaceMenu({
    project: WEBSHOP_PROJECT,
    repos: [WEBSHOP],
    workspaces: [PRIMARY, RUN_3F1],
    sessions: SESSIONS,
    runners: [MOSS, COVE],
    runnerId: MOSS.id,
    pick: { kind: "primary", resourceId: WEBSHOP.id },
    ...over,
  });

describe("workspaceMenu", () => {
  it("leads with the shared checkout in a project that holds one repo", () => {
    expect(menu().rows.map((row) => row.name)).toEqual([
      "Current checkout",
      "New workspace",
      "hydra/run-3f1",
      "None",
    ]);
  });

  it("leads with a worktree of each repo in a project that holds several, naming each checkout", () => {
    const rows = menu({ repos: [INFRA, RUNBOOKS], workspaces: [] }).rows;

    expect(rows.map((row) => row.name)).toEqual([
      "New workspace",
      "Current checkout of ops-infra",
      "Current checkout of ops-runbooks",
      "None",
    ]);
    expect(rows[0]?.sub).toBe("a worktree of each repo, side by side, each on a new branch");
  });

  it("says what a shared checkout is on, and says so when the machine has none", () => {
    expect(menu().rows[0]?.sub).toBe("on main · you and the agent share the files");
    expect(menu({ runnerId: COVE.id }).rows[0]?.sub).toBe(
      "not cloned on cove · clones on first use",
    );
  });

  it("names a live worktree after its branch, with its machine and the threads in it", () => {
    const row = menu().rows[2];

    expect(row?.mono).toBe(true);
    expect(row?.note).toBe("moss");
    expect(row?.sub).toBe("2 threads · “Fix flaky webhook tests”, “Write the retry runbook”");
  });

  it("offers None alone in a project with no repo, and a way to give it one", () => {
    const empty = menu({ repos: [], workspaces: [], project: project("p-sandbox", "sandbox") });

    expect(empty.rows.map((row) => row.name)).toEqual(["None"]);
    expect(empty.foot).toEqual({
      projectId: "p-sandbox",
      addRepo: "Add a repo to sandbox →",
      runnerId: MOSS.id,
    });
  });

  it("has nothing to act on in the foot of a draft that stands in no project", () => {
    const loose = menu({ repos: [], workspaces: [], project: undefined });

    expect(loose.rows.map((row) => row.name)).toEqual(["No workspace"]);
    expect(loose.foot).toBeNull();
  });

  it("reads the trigger off the row in force", () => {
    expect(menu().label).toBe("Current checkout");
    expect(menu({ pick: { kind: "existing", workspaceId: RUN_3F1.id } }).label).toBe(
      "hydra/run-3f1",
    );
  });
});

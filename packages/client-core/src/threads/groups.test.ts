/**
 * How the sidebar's threads fall into groups. What matters: both orderings
 * follow activity so the work in hand is at the top, the two "and the rest"
 * groups are pinned last however busy they are, and the draft being written
 * stands in the group it will belong to once it starts.
 */
import { describe, expect, it } from "vitest";
import { threadGroups } from "./groups";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  RUN_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  session,
} from "./workspaces.testing";

const at = (minute: number): string => `2026-09-10T09:0${String(minute)}:00.000Z`;

const SESSIONS = [
  session({
    id: "s-flaky",
    title: "Fix flaky webhook tests",
    projectId: WEBSHOP_PROJECT.id,
    workspaceId: RUN_3F1.id,
    lastActivityAt: at(5),
  }),
  session({
    id: "s-bun",
    title: "Bump the Bun pin",
    projectId: WEBSHOP_PROJECT.id,
    workspaceId: PRIMARY.id,
    lastActivityAt: at(3),
  }),
  session({
    id: "s-promotion",
    title: "Tidy the promotion runbook",
    projectId: WEBSHOP_PROJECT.id,
    lastActivityAt: at(2),
  }),
  session({
    id: "s-keys",
    title: "Rotate the keys",
    projectId: OPS_PROJECT.id,
    lastActivityAt: at(1),
  }),
  session({ id: "s-loose", title: "Nothing to do with a project", lastActivityAt: at(0) }),
];

const groups = (draft: { projectId: string | null; workspaceId: string | null } | null = null) =>
  threadGroups({
    sessions: SESSIONS,
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [PRIMARY, RUN_3F1],
    resources: [WEBSHOP],
    runners: [MOSS],
    mode: "meta",
    draft,
  });

describe("threadGroups", () => {
  it("heads each project with its name and the threads under it, the ones in no project last", () => {
    expect(groups().map((group) => [group.name, group.count])).toEqual([
      ["webshop", 3],
      ["ops", 1],
      [null, 1],
    ]);
  });

  it("orders a project's workspaces by activity and pins the workspace-less lane last", () => {
    expect(groups()[0]?.workspaces.map((lane) => lane.label)).toEqual([
      "hydra/run-3f1",
      "webshop checkout · moss",
      "no workspace",
    ]);
  });

  it("heads nothing where a project's threads are all in no workspace: there is nothing to separate", () => {
    expect(groups()[1]?.workspaces.map((lane) => lane.label)).toEqual([null]);
  });

  it("puts the draft in the group it will join, and puts that group first", () => {
    const webshop = groups({ projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id })[0];

    expect(webshop?.workspaces[0]?.label).toBe("webshop checkout · moss");
    expect(webshop?.workspaces[0]?.draft).toBe(true);
  });

  it("stands a project up for a draft even while nothing has been started in it", () => {
    const fresh = threadGroups({
      sessions: [],
      projects: [WEBSHOP_PROJECT],
      workspaces: [],
      resources: [],
      runners: [],
      mode: "meta",
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null },
    });

    expect(fresh.map((group) => group.name)).toEqual(["webshop"]);
    expect(fresh[0]?.workspaces[0]?.draft).toBe(true);
  });

  it("orders a project's threads newest first", () => {
    expect(groups()[0]?.workspaces[0]?.rows.map((row) => row.title)).toEqual([
      "Fix flaky webhook tests",
    ]);
  });
});

/**
 * How the sidebar's threads fall into groups. What matters: both orderings
 * follow activity so the work in hand is at the top, the two "and the rest"
 * groups are pinned last however busy they are, and the draft being written
 * stands in the group it will belong to once it starts.
 */
import { describe, expect, it } from "vitest";
import { decideDraftPlace, buildThreadGroups } from "./groups";
import { joinLabelText } from "./workspaces";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  RUN_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildSession,
} from "./workspaces.testing";

const buildTimestamp = (minute: number): string => `2026-09-10T09:0${String(minute)}:00.000Z`;

const SESSIONS = [
  buildSession({
    id: "s-flaky",
    title: "Fix flaky webhook tests",
    projectId: WEBSHOP_PROJECT.id,
    workspaceId: RUN_3F1.id,
    lastActivityAt: buildTimestamp(5),
  }),
  buildSession({
    id: "s-bun",
    title: "Bump the Bun pin",
    projectId: WEBSHOP_PROJECT.id,
    workspaceId: PRIMARY.id,
    lastActivityAt: buildTimestamp(3),
  }),
  buildSession({
    id: "s-promotion",
    title: "Tidy the promotion runbook",
    projectId: WEBSHOP_PROJECT.id,
    lastActivityAt: buildTimestamp(2),
  }),
  buildSession({
    id: "s-keys",
    title: "Rotate the keys",
    projectId: OPS_PROJECT.id,
    lastActivityAt: buildTimestamp(1),
  }),
  buildSession({
    id: "s-loose",
    title: "Nothing to do with a project",
    lastActivityAt: buildTimestamp(0),
  }),
];

const buildGroups = (
  draft: { projectId: string | null; workspaceId: string | null } | null = null,
) =>
  buildThreadGroups({
    sessions: SESSIONS,
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [PRIMARY, RUN_3F1],
    resources: [WEBSHOP],
    runners: [MOSS],
    mode: "meta",
    draft,
  });

/** A project's lanes as they read, in the order they stand. */
const listLaneLabels = (
  group: { workspaces: readonly { label: { clip: string; keep: string } | null }[] } | undefined,
) => group?.workspaces.map((lane) => (lane.label === null ? null : joinLabelText(lane.label)));

describe("decideDraftPlace", () => {
  const resources = [WEBSHOP];

  it("files a draft that names no workspace under the project's own checkout on that machine", () => {
    expect(
      decideDraftPlace({
        projectId: WEBSHOP_PROJECT.id,
        workspaceId: null,
        resources,
        workspaces: [PRIMARY, RUN_3F1],
        runnerId: MOSS.id,
      }),
    ).toEqual({ projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id });
  });

  it("files it under no workspace at all while no machine has cloned the repo", () => {
    expect(
      decideDraftPlace({
        projectId: WEBSHOP_PROJECT.id,
        workspaceId: null,
        resources,
        workspaces: [],
        runnerId: MOSS.id,
      }),
    ).toEqual({ projectId: WEBSHOP_PROJECT.id, workspaceId: null });
  });

  it("files it under no workspace when the project opens in a worktree of its own", () => {
    expect(
      decideDraftPlace({
        projectId: WEBSHOP_PROJECT.id,
        workspaceId: null,
        resources,
        workspaces: [PRIMARY],
        runnerId: MOSS.id,
        preferred: "ephemeral",
      }),
    ).toEqual({ projectId: WEBSHOP_PROJECT.id, workspaceId: null });
  });

  it("takes the workspace the address names, whatever the project would open in", () => {
    expect(
      decideDraftPlace({
        projectId: WEBSHOP_PROJECT.id,
        workspaceId: RUN_3F1.id,
        resources,
        workspaces: [PRIMARY, RUN_3F1],
        runnerId: MOSS.id,
      }),
    ).toEqual({ projectId: WEBSHOP_PROJECT.id, workspaceId: RUN_3F1.id });
  });
});

describe("buildThreadGroups", () => {
  it("heads each project with its name and the threads under it, the ones in no project last", () => {
    expect(buildGroups().map((group) => [group.name, group.count])).toEqual([
      ["webshop", 3],
      ["ops", 1],
      [null, 1],
    ]);
  });

  it("puts the worktrees first, then the main workspace, then the workspace-less lane", () => {
    expect(listLaneLabels(buildGroups()[0])).toEqual([
      "hercule/run-3f1",
      "webshop · moss",
      "no workspace",
    ]);
  });

  it("keeps the worktrees in the catalog's own order, whatever their threads did last", () => {
    const second = { ...RUN_3F1, id: "ws-run-8a0" };
    const ordered = buildThreadGroups({
      sessions: [
        buildSession({
          id: "s-newer",
          projectId: WEBSHOP_PROJECT.id,
          workspaceId: second.id,
          lastActivityAt: buildTimestamp(9),
        }),
        ...SESSIONS,
      ],
      projects: [WEBSHOP_PROJECT],
      // The catalog lists run-3f1 first, though run-8a0 holds the newer thread.
      workspaces: [RUN_3F1, second, PRIMARY],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: null,
    })[0];

    expect(listLaneLabels(ordered)).toEqual([
      "hercule/run-3f1",
      "hercule/run-3f1",
      "webshop · moss",
      "no workspace",
    ]);
  });

  it("heads nothing where a project's threads are all in no workspace: there is nothing to separate", () => {
    expect(listLaneLabels(buildGroups()[1])).toEqual([null]);
  });

  // The group order is the workspaces' own, so joining one does not move it:
  // the draft joins the main workspace where the main workspace stands.
  it("puts the draft in the group it will join, in that group's own place", () => {
    const webshop = buildGroups({ projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id })[0];
    const lane = webshop?.workspaces.find((each) => each.draft);

    expect(lane?.label === null ? null : joinLabelText(lane!.label)).toBe("webshop · moss");
    expect(listLaneLabels(webshop)).toEqual(["hercule/run-3f1", "webshop · moss", "no workspace"]);
  });

  it("stands a project up for a draft even while nothing has been started in it", () => {
    const fresh = buildThreadGroups({
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

  it("says nothing over a lane that holds the draft alone: it has no workspace to name yet", () => {
    const webshop = buildThreadGroups({
      // Every thread of this project is in a workspace, so the lane the draft
      // stands in holds nothing else.
      sessions: SESSIONS.filter((each) => each.workspaceId !== null),
      projects: [WEBSHOP_PROJECT],
      workspaces: [PRIMARY, RUN_3F1],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null },
    })[0];
    const lane = webshop?.workspaces.find((each) => each.draft);

    expect(lane?.label).toBeNull();
    expect(lane?.rows).toEqual([]);
  });

  it("keeps the no-workspace label where the draft stands among threads that have none", () => {
    const loose = buildThreadGroups({
      sessions: SESSIONS,
      projects: [WEBSHOP_PROJECT, OPS_PROJECT],
      workspaces: [PRIMARY, RUN_3F1],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null },
    })[0];

    expect(listLaneLabels(loose)).toContain("no workspace");
  });

  it("orders a project's threads newest first", () => {
    expect(buildGroups()[0]?.workspaces[0]?.rows.map((row) => row.title)).toEqual([
      "Fix flaky webhook tests",
    ]);
  });
});

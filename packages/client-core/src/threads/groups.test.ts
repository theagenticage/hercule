/**
 * Tests how the sidebar's threads are grouped. The tests check that:
 *
 * - projects are sorted by activity, so current work is at the top;
 * - inside a project, worktrees come first in catalog order, then the main
 *   workspace, then the threads with no workspace;
 * - threads with no project come last, however recent they are;
 * - the draft being written sits in the group it will belong to once it
 *   starts.
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

/** Returns the labels of a project's workspace groups, in order. */
const listLaneLabels = (
  group: { workspaces: readonly { label: { clip: string; keep: string } | null }[] } | undefined,
) => group?.workspaces.map((lane) => (lane.label === null ? null : joinLabelText(lane.label)));

describe("decideDraftPlace", () => {
  const resources = [WEBSHOP];

  it("puts a draft with no workspace under the project's main workspace on its runner", () => {
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

  it("puts the draft under no workspace while no runner has cloned the repo", () => {
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

  it("puts the draft under no workspace when the project opens in a new worktree", () => {
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

  it("uses the workspace the address names, whatever the project's default", () => {
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
  it("heads each project with its name and threads, with the threads in no project last", () => {
    expect(buildGroups().map((group) => [group.name, group.count])).toEqual([
      ["webshop", 3],
      ["ops", 1],
      [null, 1],
    ]);
  });

  it("puts the worktrees first, then the main workspace, then the threads with no workspace", () => {
    expect(listLaneLabels(buildGroups()[0])).toEqual([
      "hercule/run-3f1",
      "webshop · moss",
      "no workspace",
    ]);
  });

  it("keeps the worktrees in catalog order, however recent their threads are", () => {
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
      // The catalog lists run-3f1 first, although run-8a0 has the newer thread.
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

  it("shows no label when all of a project's threads have no workspace, because there is nothing to tell apart", () => {
    expect(listLaneLabels(buildGroups()[1])).toEqual([null]);
  });

  // Groups follow the workspaces' order, so the draft does not move a group:
  // it joins the main workspace's group where that group already is.
  it("puts the draft in the group it will join, without moving the group", () => {
    const webshop = buildGroups({ projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id })[0];
    const lane = webshop?.workspaces.find((each) => each.draft);

    expect(lane?.label === null ? null : joinLabelText(lane!.label)).toBe("webshop · moss");
    expect(listLaneLabels(webshop)).toEqual(["hercule/run-3f1", "webshop · moss", "no workspace"]);
  });

  it("shows the draft's project even when it has no threads yet", () => {
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

  it("shows no label for a group that holds only the draft, which has no workspace yet", () => {
    const webshop = buildThreadGroups({
      // Every thread of this project is in a workspace, so the draft's group
      // holds nothing else.
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

  it("keeps the no-workspace label when the draft joins threads that have no workspace", () => {
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

  it("leaves out a session that an agent runs, whether or not it answers a conversation", () => {
    const groups = buildThreadGroups({
      sessions: [
        ...SESSIONS,
        buildSession({
          id: "s-assistant",
          title: "Answer Ada's conversation",
          agentId: "agent-ada",
          conversationId: "conversation-ada",
          lastActivityAt: buildTimestamp(9),
        }),
        buildSession({
          id: "s-agent",
          title: "Review the pull request",
          agentId: "agent-reviewer",
          projectId: WEBSHOP_PROJECT.id,
          lastActivityAt: buildTimestamp(8),
        }),
      ],
      projects: [WEBSHOP_PROJECT, OPS_PROJECT],
      workspaces: [PRIMARY, RUN_3F1],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: null,
    });

    const ids = groups.flatMap((group) =>
      group.workspaces.flatMap((lane) => lane.rows.map((row) => row.id)),
    );
    expect(ids).not.toContain("s-assistant");
    expect(ids).not.toContain("s-agent");
    expect(groups.map((group) => [group.name, group.count])).toEqual([
      ["webshop", 3],
      ["ops", 1],
      [null, 1],
    ]);
  });
});

/**
 * Tests how the sidebar's threads are grouped. The tests check that:
 *
 * - projects are sorted by their latest thread in any workspace group, so
 *   current work is at the top;
 * - inside a project, worktrees come first in catalog order, then the main
 *   workspace, then the threads with no workspace;
 * - threads with no project come last, however recent they are, and a thread
 *   whose project is not in the project list joins them;
 * - the threads with no project form one unlabelled group, newest first,
 *   whatever workspaces they are in;
 * - the draft being written sits in the group it will belong to once it
 *   starts, and a draft for a project not in the project list sits with the
 *   threads with no project.
 */
import { describe, expect, it } from "vitest";
import { decideDraftPlace, buildThreadGroups } from "./groups";
import { joinLabelText } from "./workspaces";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
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
    workspaceId: THREAD_3F1.id,
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
    workspaces: [PRIMARY, THREAD_3F1],
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
        workspaces: [PRIMARY, THREAD_3F1],
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
        workspaceId: THREAD_3F1.id,
        resources,
        workspaces: [PRIMARY, THREAD_3F1],
        runnerId: MOSS.id,
      }),
    ).toEqual({ projectId: WEBSHOP_PROJECT.id, workspaceId: THREAD_3F1.id });
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

  it("sorts projects by their latest thread in any workspace group, not only the first", () => {
    const groups = buildThreadGroups({
      sessions: [
        // webshop's first workspace group, the worktree, holds its oldest
        // thread. Its latest thread has no workspace, so its group comes last.
        buildSession({
          id: "s-tree",
          projectId: WEBSHOP_PROJECT.id,
          workspaceId: THREAD_3F1.id,
          lastActivityAt: buildTimestamp(1),
        }),
        buildSession({
          id: "s-new",
          projectId: WEBSHOP_PROJECT.id,
          lastActivityAt: buildTimestamp(8),
        }),
        buildSession({ id: "s-ops", projectId: OPS_PROJECT.id, lastActivityAt: buildTimestamp(5) }),
      ],
      projects: [WEBSHOP_PROJECT, OPS_PROJECT],
      workspaces: [PRIMARY, THREAD_3F1],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: null,
    });

    expect(listLaneLabels(groups[0])).toEqual(["hercule/thread-3f1", "no workspace"]);
    expect(groups.map((group) => group.name)).toEqual(["webshop", "ops"]);
  });

  // A deleted project is never listed again, but its threads keep its id. A
  // group for it would have no name to title it.
  it("puts a thread whose project is not in the project list with the threads in no project", () => {
    const groups = buildThreadGroups({
      sessions: [
        ...SESSIONS,
        buildSession({ id: "s-orphan", projectId: "p-deleted", lastActivityAt: buildTimestamp(9) }),
      ],
      projects: [WEBSHOP_PROJECT, OPS_PROJECT],
      workspaces: [PRIMARY, THREAD_3F1],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: null,
    });

    expect(groups.map((group) => [group.projectId, group.count])).toEqual([
      [WEBSHOP_PROJECT.id, 3],
      [OPS_PROJECT.id, 1],
      [null, 2],
    ]);
    expect(groups[2]?.workspaces.flatMap((lane) => lane.rows.map((row) => row.id))).toEqual([
      "s-orphan",
      "s-loose",
    ]);
  });

  it("keeps the threads with no project in one unlabelled group, newest first, whatever their workspaces", () => {
    const groups = buildThreadGroups({
      sessions: [
        buildSession({
          id: "s-tree",
          workspaceId: THREAD_3F1.id,
          lastActivityAt: buildTimestamp(2),
        }),
        buildSession({ id: "s-main", workspaceId: PRIMARY.id, lastActivityAt: buildTimestamp(4) }),
        buildSession({ id: "s-none", lastActivityAt: buildTimestamp(3) }),
        buildSession({
          id: "s-orphan",
          projectId: "p-deleted",
          workspaceId: PRIMARY.id,
          lastActivityAt: buildTimestamp(1),
        }),
      ],
      projects: [WEBSHOP_PROJECT],
      workspaces: [PRIMARY, THREAD_3F1],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: null,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.workspaces).toEqual([
      {
        workspaceId: null,
        label: null,
        draft: false,
        rows: [
          expect.objectContaining({ id: "s-main" }),
          expect.objectContaining({ id: "s-none" }),
          expect.objectContaining({ id: "s-tree" }),
          expect.objectContaining({ id: "s-orphan" }),
        ],
      },
    ]);
  });

  it("puts the worktrees first, then the main workspace, then the threads with no workspace", () => {
    expect(listLaneLabels(buildGroups()[0])).toEqual([
      "hercule/thread-3f1",
      "webshop · moss",
      "no workspace",
    ]);
  });

  it("keeps the worktrees in catalog order, however recent their threads are", () => {
    const second = { ...THREAD_3F1, id: "ws-thread-8a0" };
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
      // The catalog lists thread-3f1 first, although thread-8a0 has the newer thread.
      workspaces: [THREAD_3F1, second, PRIMARY],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: null,
    })[0];

    expect(listLaneLabels(ordered)).toEqual([
      "hercule/thread-3f1",
      "hercule/thread-3f1",
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
    expect(listLaneLabels(webshop)).toEqual([
      "hercule/thread-3f1",
      "webshop · moss",
      "no workspace",
    ]);
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
      workspaces: [PRIMARY, THREAD_3F1],
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
      workspaces: [PRIMARY, THREAD_3F1],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null },
    })[0];

    expect(listLaneLabels(loose)).toContain("no workspace");
  });

  it("puts a draft with no project in the one group of the threads with no project, whatever its workspace", () => {
    for (const workspaceId of [null, PRIMARY.id]) {
      const loose = buildGroups({ projectId: null, workspaceId }).at(-1);

      expect(loose?.projectId).toBeNull();
      expect(loose?.workspaces.map((lane) => [lane.label, lane.draft])).toEqual([[null, true]]);
    }
  });

  // A project created since the project list was read has no name yet, so a
  // group of its own would have a coloured dot but no name.
  it("puts a draft for a project not in the project list with the threads with no project", () => {
    const groups = buildGroups({ projectId: "p-new", workspaceId: null });

    expect(groups.map((group) => [group.projectId, group.tone])).toEqual([
      [WEBSHOP_PROJECT.id, expect.any(String)],
      [OPS_PROJECT.id, expect.any(String)],
      [null, null],
    ]);
    expect(groups[2]?.workspaces.map((lane) => [lane.label, lane.draft, lane.rows.length])).toEqual(
      [[null, true, 1]],
    );
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
      workspaces: [PRIMARY, THREAD_3F1],
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

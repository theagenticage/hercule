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
 * - a new thread can join a group's workspace only while it is ready;
 * - the draft being written sits in the group it will belong to once it
 *   starts, a draft whose workspace does not exist yet has a group of its
 *   own, and a draft for a project not in the project list sits with the
 *   threads with no project.
 */
import { describe, expect, it } from "vitest";
import {
  decideDraftPlace,
  decideDraftPlaceForPick,
  buildThreadGroups,
  type DraftPlace,
} from "./groups";
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

const buildGroups = (draft: DraftPlace | null = null) =>
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
    ).toEqual({ projectId: WEBSHOP_PROJECT.id, workspaceId: PRIMARY.id, createsWorkspace: false });
  });

  it("gives the draft a group of its own while its runner has not cloned the repo", () => {
    expect(
      decideDraftPlace({
        projectId: WEBSHOP_PROJECT.id,
        workspaceId: null,
        resources,
        workspaces: [],
        runnerId: MOSS.id,
      }),
    ).toEqual({ projectId: WEBSHOP_PROJECT.id, workspaceId: null, createsWorkspace: true });
  });

  it("gives the draft a group of its own when the project opens in a new worktree", () => {
    expect(
      decideDraftPlace({
        projectId: WEBSHOP_PROJECT.id,
        workspaceId: null,
        resources,
        workspaces: [PRIMARY],
        runnerId: MOSS.id,
        preferred: "ephemeral",
      }),
    ).toEqual({ projectId: WEBSHOP_PROJECT.id, workspaceId: null, createsWorkspace: true });
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
    ).toEqual({
      projectId: WEBSHOP_PROJECT.id,
      workspaceId: THREAD_3F1.id,
      createsWorkspace: false,
    });
  });
});

describe("decideDraftPlaceForPick", () => {
  const place = (
    pick: Parameters<typeof decideDraftPlaceForPick>[0]["pick"],
    runnerId: string | null,
  ) =>
    decideDraftPlaceForPick({
      projectId: WEBSHOP_PROJECT.id,
      pick,
      workspaces: [PRIMARY, THREAD_3F1],
      runnerId,
    });

  it("follows a picked workspace, and a main workspace only on the runner that has it cloned", () => {
    expect(place({ kind: "existing", workspaceId: THREAD_3F1.id }, null)).toMatchObject({
      workspaceId: THREAD_3F1.id,
      createsWorkspace: false,
    });
    expect(place({ kind: "primary", resourceId: WEBSHOP.id }, MOSS.id)).toMatchObject({
      workspaceId: PRIMARY.id,
      createsWorkspace: false,
    });
    expect(place({ kind: "primary", resourceId: WEBSHOP.id }, "r_elsewhere")).toMatchObject({
      workspaceId: null,
      createsWorkspace: true,
    });
  });

  it("gives a draft that makes a new worktree a group of its own, and one with no workspace none", () => {
    expect(place({ kind: "ephemeral", checkouts: [] }, MOSS.id)).toMatchObject({
      workspaceId: null,
      createsWorkspace: true,
    });
    expect(place({ kind: "none" }, MOSS.id)).toMatchObject({
      workspaceId: null,
      createsWorkspace: false,
    });
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
        key: "none",
        workspaceId: null,
        label: null,
        joinable: false,
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

  it("lets a new thread join a group's workspace only while it is ready", () => {
    const joinable = buildThreadGroups({
      sessions: SESSIONS,
      projects: [WEBSHOP_PROJECT],
      workspaces: [{ ...THREAD_3F1, status: "provisioning" }, PRIMARY],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: null,
    })[0]?.workspaces.map((lane) => [lane.key, lane.joinable]);

    expect(joinable).toEqual([
      [THREAD_3F1.id, false],
      [PRIMARY.id, true],
      ["none", false],
    ]);
  });

  it("shows no label when all of a project's threads have no workspace, because there is nothing to tell apart", () => {
    expect(listLaneLabels(buildGroups()[1])).toEqual([null]);
  });

  // Groups follow the workspaces' order, so the draft does not move a group:
  // it joins the main workspace's group where that group already is.
  it("puts the draft in the group it will join, without moving the group", () => {
    const webshop = buildGroups({
      projectId: WEBSHOP_PROJECT.id,
      workspaceId: PRIMARY.id,
      createsWorkspace: false,
    })[0];
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
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null, createsWorkspace: true },
    });

    expect(fresh.map((group) => group.name)).toEqual(["webshop"]);
    expect(fresh[0]?.workspaces[0]?.draft).toBe(true);
  });

  // The threads with no workspace keep their place and their label: the
  // draft's thread will not join them.
  it("gives a draft whose workspace does not exist yet a group of its own, first and unlabelled", () => {
    const webshop = buildGroups({
      projectId: WEBSHOP_PROJECT.id,
      workspaceId: null,
      createsWorkspace: true,
    })[0];

    expect(webshop?.workspaces.map((lane) => [lane.key, lane.draft, lane.rows.length])).toEqual([
      ["draft", true, 0],
      [THREAD_3F1.id, false, 1],
      [PRIMARY.id, false, 1],
      ["none", false, 1],
    ]);
    expect(listLaneLabels(webshop)).toEqual([
      null,
      "hercule/thread-3f1",
      "webshop · moss",
      "no workspace",
    ]);
  });

  it("labels the threads with no workspace when a draft with its own group is their only neighbour", () => {
    const lanes = buildThreadGroups({
      sessions: SESSIONS.filter((each) => each.workspaceId === null),
      projects: [WEBSHOP_PROJECT],
      workspaces: [],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null, createsWorkspace: true },
    })[0];

    expect(listLaneLabels(lanes)).toEqual([null, "no workspace"]);
  });

  it("puts a draft with no workspace last among the threads with no workspace, where they are", () => {
    const webshop = buildGroups({
      projectId: WEBSHOP_PROJECT.id,
      workspaceId: null,
      createsWorkspace: false,
    })[0];

    expect(listLaneLabels(webshop)).toEqual([
      "hercule/thread-3f1",
      "webshop · moss",
      "no workspace",
    ]);
    expect(webshop?.workspaces.at(-1)?.draft).toBe(true);
  });

  it("labels the group a draft with no workspace starts, when the project's threads are all in workspaces", () => {
    const webshop = buildThreadGroups({
      sessions: SESSIONS.filter((each) => each.workspaceId !== null),
      projects: [WEBSHOP_PROJECT],
      workspaces: [PRIMARY, THREAD_3F1],
      resources: [WEBSHOP],
      runners: [MOSS],
      mode: "meta",
      draft: { projectId: WEBSHOP_PROJECT.id, workspaceId: null, createsWorkspace: false },
    })[0];

    expect(listLaneLabels(webshop)).toEqual([
      "hercule/thread-3f1",
      "webshop · moss",
      "no workspace",
    ]);
    expect(webshop?.workspaces.at(-1)).toMatchObject({ draft: true, rows: [] });
  });

  it("puts a draft with no project in the one group of the threads with no project, whatever its workspace", () => {
    for (const workspaceId of [null, PRIMARY.id]) {
      const loose = buildGroups({
        projectId: null,
        workspaceId,
        createsWorkspace: workspaceId === null,
      }).at(-1);

      expect(loose?.projectId).toBeNull();
      expect(loose?.workspaces.map((lane) => [lane.label, lane.draft])).toEqual([[null, true]]);
    }
  });

  // A project created since the project list was read has no name yet, so a
  // group of its own would have a coloured dot but no name.
  it("puts a draft for a project not in the project list with the threads with no project", () => {
    const groups = buildGroups({ projectId: "p-new", workspaceId: null, createsWorkspace: true });

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

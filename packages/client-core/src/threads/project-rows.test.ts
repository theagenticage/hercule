/**
 * Tests the desktop sidebar's flat thread lists, built from the groups of
 * `buildThreadGroups`. The tests check that:
 *
 * - a project's threads form one list, newest created first, whatever
 *   workspace they are in and however recently they were active, with ties
 *   broken by session id;
 * - each row names its workspace, machine, branch and provider, or says it
 *   has none, and describes where it works in words, naming each once;
 * - projects are sorted by their newest created thread, the draft's project
 *   first and the threads with no project last, and projects that tie keep
 *   the order they came in.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { buildInstance } from "../providers.testing";
import { buildThreadGroups, type DraftPlace } from "./groups";
import { listProjectRows, sortProjectsByNewestThread } from "./project-rows";
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

const CLAUDE = buildInstance("claude-code", "Claude Code");

/**
 * webshop's threads were created in the opposite order to their latest
 * activity, so a list sorted by activity would differ from one sorted by
 * creation.
 */
const SESSIONS: readonly Session[] = [
  buildSession({
    id: "s-flaky",
    title: "Fix flaky webhook tests",
    projectId: WEBSHOP_PROJECT.id,
    workspaceId: THREAD_3F1.id,
    instanceId: CLAUDE.id,
    createdAt: buildTimestamp(1),
    lastActivityAt: buildTimestamp(9),
  }),
  buildSession({
    id: "s-bun",
    title: "Bump the Bun pin",
    projectId: WEBSHOP_PROJECT.id,
    workspaceId: PRIMARY.id,
    instanceId: CLAUDE.id,
    createdAt: buildTimestamp(3),
    lastActivityAt: buildTimestamp(4),
  }),
  buildSession({
    id: "s-promotion-b",
    title: "Tidy the promotion runbook",
    projectId: WEBSHOP_PROJECT.id,
    instanceId: "i-gone",
    createdAt: buildTimestamp(5),
    lastActivityAt: buildTimestamp(2),
  }),
  buildSession({
    id: "s-promotion-a",
    title: "Write the promotion notes",
    projectId: WEBSHOP_PROJECT.id,
    workspaceId: "ws-deleted",
    runnerId: "r-gone",
    instanceId: CLAUDE.id,
    createdAt: buildTimestamp(5),
    lastActivityAt: buildTimestamp(1),
  }),
  buildSession({
    id: "s-keys",
    title: "Rotate the keys",
    projectId: OPS_PROJECT.id,
    createdAt: buildTimestamp(6),
    lastActivityAt: buildTimestamp(3),
  }),
  buildSession({
    id: "s-loose",
    title: "Nothing to do with a project",
    createdAt: buildTimestamp(8),
    lastActivityAt: buildTimestamp(8),
  }),
];

const SESSIONS_BY_ID = new Map(SESSIONS.map((session) => [session.id, session]));

const buildGroups = (draft: DraftPlace | null = null) =>
  buildThreadGroups({
    sessions: SESSIONS,
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [PRIMARY, THREAD_3F1],
    resources: [WEBSHOP],
    runners: [MOSS],
    instances: [CLAUDE],
    mode: "plain",
    draft,
  });

const listWebshopRows = () =>
  listProjectRows({
    group: buildGroups().find((group) => group.projectId === WEBSHOP_PROJECT.id)!,
    sessions: SESSIONS_BY_ID,
    workspaces: [PRIMARY, THREAD_3F1],
    resources: [WEBSHOP],
    runners: [MOSS],
    instances: [CLAUDE],
  });

describe("listProjectRows", () => {
  it("lists a project's threads in one list, newest created first, ties by session id", () => {
    expect(listWebshopRows().map((row) => row.id)).toEqual([
      "s-promotion-a",
      "s-promotion-b",
      "s-bun",
      "s-flaky",
    ]);
  });

  it("names each thread's workspace, machine, branch and provider, or says it has none", () => {
    expect(
      listWebshopRows().map(
        ({ id, createdAt, workspace, machine, branch, providerId, placeDescription }) => ({
          id,
          createdAt,
          workspace,
          machine,
          branch,
          providerId,
          placeDescription,
        }),
      ),
    ).toEqual([
      {
        id: "s-promotion-a",
        createdAt: buildTimestamp(5),
        workspace: { clip: "No workspace", keep: "" },
        machine: null,
        branch: null,
        providerId: "claude-code",
        placeDescription: "in webshop, no workspace",
      },
      {
        id: "s-promotion-b",
        createdAt: buildTimestamp(5),
        workspace: { clip: "No workspace", keep: "" },
        machine: "moss",
        branch: null,
        providerId: null,
        placeDescription: "in webshop, no workspace, on moss",
      },
      {
        id: "s-bun",
        createdAt: buildTimestamp(3),
        workspace: { clip: "webshop", keep: " · moss" },
        machine: "moss",
        branch: "main",
        providerId: "claude-code",
        placeDescription: "in webshop, webshop main workspace, on moss, branch main",
      },
      {
        id: "s-flaky",
        createdAt: buildTimestamp(1),
        workspace: { clip: "hercule/thread-3f1", keep: "" },
        machine: "moss",
        branch: "hercule/thread-3f1",
        providerId: "claude-code",
        // The workspace is named after its branch, so the branch is not named again.
        placeDescription: "in webshop, workspace hercule/thread-3f1, on moss",
      },
    ]);
  });

  it("describes a thread in no project as in no project", () => {
    const loose = buildGroups().find((group) => group.projectId === null)!;
    const [row] = listProjectRows({
      group: loose,
      sessions: SESSIONS_BY_ID,
      workspaces: [],
      resources: [],
      runners: [MOSS],
      instances: [],
    });

    expect(row?.placeDescription).toBe("in no project, no workspace, on moss");
  });
});

describe("sortProjectsByNewestThread", () => {
  it("sorts projects by their newest created thread, with the threads of no project last", () => {
    // By latest activity webshop comes first; by creation ops does.
    expect(
      sortProjectsByNewestThread(buildGroups(), SESSIONS_BY_ID).map((group) => group.projectId),
    ).toEqual([OPS_PROJECT.id, WEBSHOP_PROJECT.id, null]);
  });

  it("puts the draft's project first", () => {
    const draft = {
      projectId: WEBSHOP_PROJECT.id,
      workspaceId: PRIMARY.id,
      createsWorkspace: false,
    };

    expect(
      sortProjectsByNewestThread(buildGroups(draft), SESSIONS_BY_ID).map(
        (group) => group.projectId,
      ),
    ).toEqual([WEBSHOP_PROJECT.id, OPS_PROJECT.id, null]);
  });

  it("sorts projects whose newest threads were created at the same moment by project id, whatever order they came in", () => {
    // ops's newest thread is now as new as webshop's.
    const tied = new Map(SESSIONS_BY_ID).set("s-keys", {
      ...SESSIONS_BY_ID.get("s-keys")!,
      createdAt: buildTimestamp(5),
    });
    const groups = buildGroups().filter((group) => group.projectId !== null);
    const listIds = (sorted: readonly { readonly projectId: string | null }[]) =>
      sorted.map((group) => group.projectId);

    const byId = listIds(groups).toSorted();

    expect(listIds(sortProjectsByNewestThread(groups, tied))).toEqual(byId);
    expect(listIds(sortProjectsByNewestThread(groups.toReversed(), tied))).toEqual(byId);
  });
});

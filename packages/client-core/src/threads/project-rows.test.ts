/**
 * Tests the desktop sidebar's flat thread lists, built from the groups of
 * `buildThreadGroups`. The tests check that:
 *
 * - a project's threads form one list, most recently started (created or
 *   reopened) first, whatever workspace they are in and however recently
 *   they were active, with ties broken by session id;
 * - each row's second line names a branch a person chose, else the main
 *   workspace, else the machine, and never a generated branch;
 * - each row names its machine, branch and provider, or says it has none,
 *   and describes where it works in words, naming each once;
 * - projects are sorted by their most recently started thread, the draft's
 *   project first and the threads with no project last, and projects that
 *   tie are sorted by project id.
 */
import { describe, expect, it } from "vitest";
import type { Session, Workspace } from "@hercule/contract";
import { buildInstance } from "../providers.testing";
import { buildThreadGroups, type DraftPlace } from "./groups";
import {
  listProjectRows,
  orderProjectIdsByNewestThread,
  sortProjectsByNewestThread,
} from "./project-rows";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildCheckout,
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

const listWebshopRows = (
  sessions: ReadonlyMap<string, Session> = SESSIONS_BY_ID,
  workspaces: readonly Workspace[] = [PRIMARY, THREAD_3F1],
) =>
  listProjectRows({
    group: buildGroups().find((group) => group.projectId === WEBSHOP_PROJECT.id)!,
    sessions,
    workspaces,
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

  it("puts a reopened thread where its reopening puts it, and ignores a reopening older than the thread", () => {
    const reopened = new Map(SESSIONS_BY_ID)
      .set("s-flaky", { ...SESSIONS_BY_ID.get("s-flaky")!, reopenedAt: buildTimestamp(7) })
      // A reopening stamped before the thread was created leaves its place alone.
      .set("s-bun", { ...SESSIONS_BY_ID.get("s-bun")!, reopenedAt: buildTimestamp(0) });

    expect(listWebshopRows(reopened).map((row) => [row.id, row.lastStartedAt])).toEqual([
      ["s-flaky", buildTimestamp(7)],
      ["s-promotion-a", buildTimestamp(5)],
      ["s-promotion-b", buildTimestamp(5)],
      ["s-bun", buildTimestamp(3)],
    ]);
  });

  it("cuts a long branch name in the middle, and names a main workspace with no known branch by its repo and machine", () => {
    const named = {
      ...THREAD_3F1,
      checkouts: [buildCheckout(WEBSHOP.id, "rogier/fix-the-sidebar-rows")],
    };
    const unknown = { ...PRIMARY, checkouts: [buildCheckout(WEBSHOP.id, null)] };
    const placeLabels = new Map(
      listWebshopRows(SESSIONS_BY_ID, [unknown, named]).map((row) => [row.id, row.placeLabel]),
    );

    expect(placeLabels.get("s-flaky")).toEqual({ clip: "rogier/fix-the-", keep: "sidebar-rows" });
    expect(placeLabels.get("s-bun")).toEqual({ clip: "webshop", keep: " · moss" });
  });

  it("gives each thread its second line, machine, branch and provider, or says it has none", () => {
    expect(
      listWebshopRows().map(
        ({ id, placeLabel, machine, branch, providerId, placeDescription }) => ({
          id,
          placeLabel,
          machine,
          branch,
          providerId,
          placeDescription,
        }),
      ),
    ).toEqual([
      {
        id: "s-promotion-a",
        placeLabel: { clip: "No workspace", keep: "" },
        machine: null,
        branch: null,
        providerId: "claude-code",
        placeDescription: "in webshop, no workspace",
      },
      {
        id: "s-promotion-b",
        // No workspace, so the machine is the only place there is to name.
        placeLabel: { clip: "moss", keep: "" },
        machine: "moss",
        branch: null,
        providerId: null,
        placeDescription: "in webshop, no workspace, on moss",
      },
      {
        id: "s-bun",
        // A person named main, so the row shows it.
        placeLabel: { clip: "", keep: "main" },
        machine: "moss",
        branch: "main",
        providerId: "claude-code",
        placeDescription: "in webshop, webshop main workspace, on moss, branch main",
      },
      {
        id: "s-flaky",
        // The controller named the branch, so the row shows the machine instead.
        placeLabel: { clip: "moss", keep: "" },
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

describe("orderProjectIdsByNewestThread", () => {
  it("lists projects by when their newest thread started, newest first", () => {
    expect(orderProjectIdsByNewestThread(SESSIONS)).toEqual([OPS_PROJECT.id, WEBSHOP_PROJECT.id]);
  });

  it("counts a reopening as a start", () => {
    const reopened = SESSIONS.map((session) =>
      session.id === "s-flaky" ? { ...session, reopenedAt: buildTimestamp(7) } : session,
    );

    expect(orderProjectIdsByNewestThread(reopened)).toEqual([WEBSHOP_PROJECT.id, OPS_PROJECT.id]);
  });

  it("sorts projects whose newest threads started at the same moment by project id, whatever order they came in", () => {
    const tied = SESSIONS.map((session) =>
      session.id === "s-keys" ? { ...session, createdAt: buildTimestamp(5) } : session,
    );
    const byId = [OPS_PROJECT.id, WEBSHOP_PROJECT.id].toSorted();

    expect(orderProjectIdsByNewestThread(tied)).toEqual(byId);
    expect(orderProjectIdsByNewestThread(tied.toReversed())).toEqual(byId);
  });

  it("ignores threads marked Done", () => {
    const done = SESSIONS.map((session) =>
      session.id === "s-keys"
        ? { ...session, done: { at: buildTimestamp(9), by: "user" as const } }
        : session,
    );

    expect(orderProjectIdsByNewestThread(done)).toEqual([WEBSHOP_PROJECT.id]);
  });

  it("ignores the sessions of Agents", () => {
    const agents = SESSIONS.map((session) =>
      session.id === "s-keys" ? { ...session, agentId: "a-ada", kind: "agent" as const } : session,
    );

    expect(orderProjectIdsByNewestThread(agents)).toEqual([WEBSHOP_PROJECT.id]);
  });

  it("ignores sessions with no project", () => {
    expect(orderProjectIdsByNewestThread(SESSIONS)).not.toContain(null);
    expect(orderProjectIdsByNewestThread([SESSIONS.find((s) => s.id === "s-loose")!])).toEqual([]);
  });

  it("lists the same projects in the same order as the sidebar's groups", () => {
    const sidebarOrder = sortProjectsByNewestThread(buildGroups(), SESSIONS_BY_ID)
      .map((group) => group.projectId)
      .filter((projectId) => projectId !== null);

    expect(orderProjectIdsByNewestThread(SESSIONS)).toEqual(sidebarOrder);
  });
});

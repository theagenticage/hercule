/**
 * Tests the tab strip above a thread. It appears only when there is something
 * to switch between, it keeps the workspace's thread order rather than
 * sorting by activity, and a draft that joins the workspace is the last tab.
 * It also tests the label each tab shows: a role, numbered when it repeats.
 */
import type { ProviderInstance, Session, Workspace } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildSiblingTabs,
  labelWorkspaceSessions,
  listSessionsOfWorkspace,
  listWorkspaceSessionTabs,
  listWorkspaceThreads,
  type SessionTab,
} from "./siblings";
import { AT, MOSS, THREAD_3F1, buildSession } from "./workspaces.testing";

const SESSIONS = [
  buildSession({ id: "s-runbook", title: "Write the retry runbook", status: "busy" }),
  buildSession({ id: "s-flaky", title: "Fix flaky webhook tests" }),
];

describe("buildSiblingTabs", () => {
  it("is empty for a thread with no workspace", () => {
    expect(
      buildSiblingTabs({ workspace: undefined, sessions: SESSIONS, activeSessionId: "s-flaky" }),
    ).toEqual([]);
  });

  it("is empty while the workspace has one thread, whose title is shown alone", () => {
    expect(
      buildSiblingTabs({
        workspace: { ...THREAD_3F1, sessionIds: ["s-flaky"] },
        sessions: SESSIONS,
        activeSessionId: "s-flaky",
      }),
    ).toEqual([]);
  });

  it("keeps the workspace's order, marking the thread on screen as active", () => {
    expect(
      buildSiblingTabs({ workspace: THREAD_3F1, sessions: SESSIONS, activeSessionId: "s-flaky" }),
    ).toEqual([
      { sessionId: "s-flaky", title: "Fix flaky webhook tests", mark: "idle", active: true },
      { sessionId: "s-runbook", title: "Write the retry runbook", mark: "working", active: false },
    ]);
  });

  it("puts a draft that joins the workspace last, as the active tab", () => {
    const tabs = buildSiblingTabs({
      workspace: { ...THREAD_3F1, sessionIds: ["s-flaky"] },
      sessions: SESSIONS,
      activeSessionId: null,
      draft: true,
    });

    expect(tabs.map((tab) => tab.title)).toEqual(["Fix flaky webhook tests", "New thread"]);
    expect(tabs.at(-1)).toEqual({
      sessionId: null,
      title: "New thread",
      mark: "draft",
      active: true,
    });
  });

  it("skips a session that is not in the session list rather than showing an empty tab", () => {
    const tabs = buildSiblingTabs({
      workspace: { ...THREAD_3F1, sessionIds: ["s-flaky", "s-gone", "s-runbook"] },
      sessions: SESSIONS,
      activeSessionId: "s-flaky",
    });

    expect(tabs.map((tab) => tab.sessionId)).toEqual(["s-flaky", "s-runbook"]);
  });
});

describe("listWorkspaceSessionTabs", () => {
  const FLAKY = SESSIONS[1]!;
  const RUNBOOK = SESSIONS[0]!;
  const IN_3F1 = { workspaceId: THREAD_3F1.id };
  // The sessions of the workspace, as the sidebar's read holds them.
  const HELD = SESSIONS.map((session) => ({ ...session, ...IN_3F1 }));
  const INSTANCES = [
    { id: "i-claude", providerId: "claude-code", snapshots: [] },
  ] as unknown as readonly ProviderInstance[];
  const reads = (workspaces: readonly Workspace[] = [THREAD_3F1]) => ({
    workspaces,
    runners: [MOSS],
    instances: INSTANCES,
  });
  const listIds = (tabs: readonly SessionTab[]): string[] => tabs.map((tab) => tab.sessionId);

  it("gives a session with no workspace one tab, its own", () => {
    expect(listIds(listWorkspaceSessionTabs(FLAKY, SESSIONS, reads()))).toEqual(["s-flaky"]);
  });

  it("gives a session whose workspace is not listed one tab, its own", () => {
    const open = { ...FLAKY, ...IN_3F1 };

    expect(listIds(listWorkspaceSessionTabs(open, SESSIONS, reads([])))).toEqual(["s-flaky"]);
  });

  it("describes each session: its pose, status, Done mark, provider and model", () => {
    const open = buildSession({ id: "s-open", ...IN_3F1, title: "Open", status: "busy" });
    const finished = buildSession({
      id: "s-finished",
      ...IN_3F1,
      title: "Finished",
      done: { at: AT, by: "user" },
      lastActivityAt: AT,
    });
    const workspace = { ...THREAD_3F1, sessionIds: ["s-open", "s-finished"] };

    expect(listWorkspaceSessionTabs(open, [finished], reads([workspace]))).toEqual([
      {
        sessionId: "s-open",
        label: "Open",
        title: "Open",
        pose: "working",
        status: "working",
        activityAt: AT,
        done: false,
        providerId: "claude-code",
        model: "claude-sonnet-5",
      },
      expect.objectContaining({ sessionId: "s-finished", done: true, status: "age" }),
    ]);
  });

  it("keeps the workspace's order, and describes the open session as it was passed in", () => {
    const open = { ...FLAKY, ...IN_3F1, title: "Fix the flaky webhook tests" };
    const tabs = listWorkspaceSessionTabs(open, HELD, reads());

    expect(listIds(tabs)).toEqual(["s-flaky", "s-runbook"]);
    expect(tabs[0]?.title).toBe("Fix the flaky webhook tests");
  });

  it("skips a session of the workspace that is not in the session list", () => {
    const workspace = { ...THREAD_3F1, sessionIds: ["s-flaky", "s-gone", "s-runbook"] };
    const open = { ...FLAKY, ...IN_3F1 };

    expect(listIds(listWorkspaceSessionTabs(open, HELD, reads([workspace])))).toEqual([
      "s-flaky",
      "s-runbook",
    ]);
  });

  it("puts an exited session, which its workspace no longer lists, last", () => {
    const workspace = { ...THREAD_3F1, sessionIds: ["s-runbook"] };
    const open = { ...FLAKY, ...IN_3F1, status: "exited" as const };

    expect(listIds(listWorkspaceSessionTabs(open, HELD, reads([workspace])))).toEqual([
      "s-runbook",
      "s-flaky",
    ]);
  });

  it("takes the first record of a session that the list holds twice", () => {
    const first = { ...RUNBOOK, ...IN_3F1, title: "First read" };
    const open = { ...FLAKY, ...IN_3F1 };
    const tabs = listWorkspaceSessionTabs(
      open,
      [first, { ...first, title: "Second read" }],
      reads(),
    );

    expect(tabs.map((tab) => tab.title)).toEqual([FLAKY.title, "First read"]);
  });

  it("labels a step session by its step id", () => {
    const step = buildSession({ id: "s-step", kind: "run", runId: "r-1", stepId: "implement" });

    expect(listWorkspaceSessionTabs(step, [], reads())[0]?.label).toBe("implement");
  });

  it("numbers a role among every session of the workspace it holds, the exited ones included", () => {
    const at = (minute: number): string => `2026-09-10T09:0${String(minute)}:00.000Z`;
    const ended = buildSession({
      id: "s-ended",
      kind: "agent",
      agentId: "a-1",
      ...IN_3F1,
      role: "review",
      status: "exited",
      createdAt: at(1),
    });
    const open = buildSession({ id: "s-open", ...IN_3F1, role: "Review", createdAt: at(2) });
    const workspace = { ...THREAD_3F1, sessionIds: ["s-open"] };

    expect(
      listWorkspaceSessionTabs(open, [ended], reads([workspace])).map((tab) => tab.label),
    ).toEqual(["Review 2"]);
  });
});

describe("labelWorkspaceSessions", () => {
  const at = (minute: number): string => `2026-09-10T09:${String(minute).padStart(2, "0")}:00.000Z`;
  const labelsOf = (sessions: readonly Session[]): string[] => {
    const labels = labelWorkspaceSessions(sessions);
    return sessions.map((session) => labels.get(session.id) ?? "missing");
  };

  it("labels a session with its role, a Thread included", () => {
    expect(
      labelsOf([
        buildSession({ id: "s-lead", kind: "thread", role: "build", createdAt: at(0) }),
        buildSession({ id: "s-agent", role: "review", title: "Check the diff", createdAt: at(1) }),
      ]),
    ).toEqual(["build", "review"]);
  });

  it("numbers a role that repeats, ignoring case, by when each session was created", () => {
    const sessions = [
      buildSession({ id: "s-late", role: "Review", createdAt: at(3) }),
      buildSession({ id: "s-first", role: "review", createdAt: at(1) }),
      buildSession({ id: "s-other", role: "tests", createdAt: at(2) }),
      buildSession({ id: "s-third", role: "REVIEW", createdAt: at(4) }),
    ];

    expect(labelsOf(sessions)).toEqual(["Review 2", "review", "tests", "REVIEW 3"]);
  });

  it("numbers sessions created at the same moment by session id, whatever the list order", () => {
    const first = buildSession({ id: "s-a", role: "review", createdAt: at(1) });
    const second = buildSession({ id: "s-b", role: "review", createdAt: at(1) });

    expect(labelsOf([second, first])).toEqual(["review 2", "review"]);
    expect(labelsOf([first, second])).toEqual(["review", "review 2"]);
  });

  it("labels a session with no role by its full title, and does not number titles", () => {
    const sessions = [
      buildSession({ id: "s-1", role: null, title: "Fix flaky webhook tests" }),
      buildSession({ id: "s-2", role: "  ", title: "Fix flaky webhook tests" }),
    ];

    expect(labelsOf(sessions)).toEqual(["Fix flaky webhook tests", "Fix flaky webhook tests"]);
  });

  it("labels a run's step session by its step id, not its title or role", () => {
    const step = buildSession({
      id: "s-step",
      kind: "run",
      title: "Ticket to pull request \u00b7 implement",
      role: "review",
      runId: "r-1",
      stepId: "implement",
    });

    expect(labelsOf([step])).toEqual(["implement"]);
  });
});

describe("listWorkspaceThreads", () => {
  it("has no threads when there is no workspace", () => {
    expect(listWorkspaceThreads(undefined, SESSIONS)).toEqual([]);
  });

  it("keeps the workspace's order, and skips a thread that is not in the thread list", () => {
    const workspace = { ...THREAD_3F1, sessionIds: ["s-flaky", "s-gone", "s-runbook"] };

    expect(listWorkspaceThreads(workspace, SESSIONS)).toEqual([SESSIONS[1], SESSIONS[0]]);
  });
});

describe("listSessionsOfWorkspace", () => {
  it("keeps the sessions of the workspace, exited ones too, and drops the others", () => {
    const live = buildSession({ id: "s-live", workspaceId: "w-1" });
    const exited = buildSession({ id: "s-exited", workspaceId: "w-1", status: "exited" });
    const elsewhere = buildSession({ id: "s-elsewhere", workspaceId: "w-2" });

    expect(listSessionsOfWorkspace("w-1", [live, elsewhere, exited])).toEqual([live, exited]);
  });

  it("returns a session that two reads hold once", () => {
    const partner = buildSession({ id: "s-partner", workspaceId: "w-1", kind: "agent" });

    expect(listSessionsOfWorkspace("w-1", [partner, partner])).toEqual([partner]);
  });
});

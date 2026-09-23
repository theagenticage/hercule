/**
 * Tests the tab strip above a thread. It appears only when there is something
 * to switch between, it keeps the workspace's thread order rather than
 * sorting by activity, and a draft that joins the workspace is the last tab.
 */
import { describe, expect, it } from "vitest";
import { buildSiblingTabs } from "./siblings";
import { RUN_3F1, buildSession } from "./workspaces.testing";

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
        workspace: { ...RUN_3F1, sessionIds: ["s-flaky"] },
        sessions: SESSIONS,
        activeSessionId: "s-flaky",
      }),
    ).toEqual([]);
  });

  it("keeps the workspace's order, marking the thread on screen as active", () => {
    expect(
      buildSiblingTabs({ workspace: RUN_3F1, sessions: SESSIONS, activeSessionId: "s-flaky" }),
    ).toEqual([
      { sessionId: "s-flaky", title: "Fix flaky webhook tests", mark: "idle", active: true },
      { sessionId: "s-runbook", title: "Write the retry runbook", mark: "working", active: false },
    ]);
  });

  it("puts a draft that joins the workspace last, as the active tab", () => {
    const tabs = buildSiblingTabs({
      workspace: { ...RUN_3F1, sessionIds: ["s-flaky"] },
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
      workspace: { ...RUN_3F1, sessionIds: ["s-flaky", "s-gone", "s-runbook"] },
      sessions: SESSIONS,
      activeSessionId: "s-flaky",
    });

    expect(tabs.map((tab) => tab.sessionId)).toEqual(["s-flaky", "s-runbook"]);
  });
});

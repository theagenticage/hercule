/**
 * The tab strip on a thread's chrome. What matters: it appears only where
 * there is something to switch between, it keeps the workspace's own thread
 * order rather than an activity order of its own, and a draft joining the
 * workspace is the last tab.
 */
import { describe, expect, it } from "vitest";
import { siblingTabs } from "./siblings";
import { RUN_3F1, session } from "./workspaces.testing";

const SESSIONS = [
  session({ id: "s-runbook", title: "Write the retry runbook", status: "busy" }),
  session({ id: "s-flaky", title: "Fix flaky webhook tests" }),
];

describe("siblingTabs", () => {
  it("is empty on a thread with no workspace: there is nothing beside it", () => {
    expect(
      siblingTabs({ workspace: undefined, sessions: SESSIONS, activeSessionId: "s-flaky" }),
    ).toEqual([]);
  });

  it("is empty while the workspace holds one thread, whose title is the row", () => {
    expect(
      siblingTabs({
        workspace: { ...RUN_3F1, sessionIds: ["s-flaky"] },
        sessions: SESSIONS,
        activeSessionId: "s-flaky",
      }),
    ).toEqual([]);
  });

  it("keeps the workspace's own order, marking the thread on screen", () => {
    expect(
      siblingTabs({ workspace: RUN_3F1, sessions: SESSIONS, activeSessionId: "s-flaky" }),
    ).toEqual([
      { sessionId: "s-flaky", title: "Fix flaky webhook tests", mark: "idle", active: true },
      { sessionId: "s-runbook", title: "Write the retry runbook", mark: "working", active: false },
    ]);
  });

  it("puts the draft joining the workspace last, as the one on screen", () => {
    const tabs = siblingTabs({
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

  it("skips a session the listing does not hold rather than drawing an empty tab", () => {
    const tabs = siblingTabs({
      workspace: { ...RUN_3F1, sessionIds: ["s-flaky", "s-gone", "s-runbook"] },
      sessions: SESSIONS,
      activeSessionId: "s-flaky",
    });

    expect(tabs.map((tab) => tab.sessionId)).toEqual(["s-flaky", "s-runbook"]);
  });
});

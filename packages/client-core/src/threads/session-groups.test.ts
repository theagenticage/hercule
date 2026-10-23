/**
 * Tests how the sidebar's sessions fall into rows: by workspace, with a Thread
 * as the lead, and with the row's start and Done times following the rules the
 * list sorts and the Done shelf rely on.
 */
import type { Session } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildSessionGroups,
  decideAskerLabel,
  orderProjectIdsByNewestGroup,
} from "./session-groups";
import { buildSession } from "./workspaces.testing";

const at = (minute: number): string => `2026-09-10T09:${String(minute).padStart(2, "0")}:00.000Z`;

const thread = (id: string, over: Partial<Session> = {}): Session =>
  buildSession({ id, kind: "thread", workspaceId: "w-1", createdAt: at(0), ...over });

const agent = (id: string, over: Partial<Session> = {}): Session =>
  buildSession({ id, kind: "agent", workspaceId: "w-1", createdAt: at(1), ...over });

const doneAt = (minute: number): Pick<Session, "done"> => ({
  done: { at: at(minute), by: "user" },
});

describe("buildSessionGroups", () => {
  it("makes a lone Thread with no workspace a group of its own", () => {
    const [group, ...rest] = buildSessionGroups([thread("s-1", { workspaceId: null })]);

    expect(rest).toEqual([]);
    expect(group?.key).toBe("session:s-1");
    expect(group?.lead.id).toBe("s-1");
    expect(group?.sessions.map((session) => session.id)).toEqual(["s-1"]);
  });

  it("puts a Thread, its partner and an Agent session of one workspace in one group, oldest first", () => {
    const groups = buildSessionGroups([
      agent("s-agent"),
      thread("s-partner", { createdAt: at(2) }),
      thread("s-lead"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("workspace:w-1");
    expect(groups[0]?.lead.id).toBe("s-lead");
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual([
      "s-lead",
      "s-agent",
      "s-partner",
    ]);
  });

  it("orders sessions created at the same moment by id", () => {
    const groups = buildSessionGroups([thread("s-b"), thread("s-a")]);

    expect(groups[0]?.lead.id).toBe("s-a");
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["s-a", "s-b"]);
  });

  it("keeps an Agent session that has ended in its group", () => {
    const groups = buildSessionGroups([
      thread("s-lead"),
      agent("s-agent", { status: "exited", exitedAt: at(5) }),
    ]);

    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["s-lead", "s-agent"]);
  });

  it("leaves out the sessions of a run and of an assistant", () => {
    const groups = buildSessionGroups([
      thread("s-lead"),
      buildSession({ id: "s-step", kind: "run", workspaceId: "w-1" }),
      buildSession({ id: "s-chat", kind: "assistant", workspaceId: "w-1" }),
      buildSession({ id: "s-step-alone", kind: "run", workspaceId: "w-2" }),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["workspace:w-1"]);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["s-lead"]);
  });

  it("makes no group of a workspace that holds only Agent sessions, or of an Agent session with no workspace", () => {
    expect(buildSessionGroups([agent("s-agent"), agent("s-loose", { workspaceId: null })])).toEqual(
      [],
    );
  });

  it("names the group after its oldest Thread, even when that Thread is Done", () => {
    const groups = buildSessionGroups([
      thread("s-partner", { createdAt: at(2) }),
      thread("s-lead", { ...doneAt(9) }),
    ]);

    expect(groups[0]?.lead.id).toBe("s-lead");
  });

  describe("lastStartedAt", () => {
    it("is the lead's creation, and a partner's creation does not move it", () => {
      const groups = buildSessionGroups([
        thread("s-lead"),
        thread("s-partner", { createdAt: at(7) }),
      ]);

      expect(groups[0]?.lastStartedAt).toBe(at(0));
    });

    it("moves to the latest reopen of any Thread, a partner's included", () => {
      const groups = buildSessionGroups([
        thread("s-lead", { reopenedAt: at(3) }),
        thread("s-partner", { createdAt: at(2), reopenedAt: at(6) }),
      ]);

      expect(groups[0]?.lastStartedAt).toBe(at(6));
    });
  });

  describe("doneAt", () => {
    it("is null while one Thread is not Done", () => {
      const groups = buildSessionGroups([
        thread("s-lead", { ...doneAt(4) }),
        thread("s-partner", { createdAt: at(2) }),
      ]);

      expect(groups[0]?.doneAt).toBeNull();
    });

    it("is null while an Agent session is still live", () => {
      const groups = buildSessionGroups([
        thread("s-lead", { ...doneAt(4) }),
        agent("s-agent", { status: "busy" }),
      ]);

      expect(groups[0]?.doneAt).toBeNull();
    });

    it("is the latest Done time once every Thread is Done and every Agent session has ended", () => {
      const groups = buildSessionGroups([
        thread("s-lead", { ...doneAt(8) }),
        thread("s-partner", { createdAt: at(2), ...doneAt(4) }),
        agent("s-agent", { status: "exited" }),
      ]);

      expect(groups[0]?.doneAt).toBe(at(8));
    });
  });

  it("keeps the last of two reads of the same session", () => {
    const groups = buildSessionGroups([
      thread("s-lead", { title: "Older read" }),
      thread("s-lead", { title: "Newer read" }),
    ]);

    expect(groups[0]?.sessions).toHaveLength(1);
    expect(groups[0]?.lead.title).toBe("Newer read");
  });

  it("lists the group that started last first, and groups that started together by key", () => {
    const groups = buildSessionGroups([
      thread("s-old", { workspaceId: "w-old" }),
      thread("s-b", { workspaceId: "w-b", createdAt: at(5) }),
      thread("s-a", { workspaceId: "w-a", createdAt: at(5) }),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      "workspace:w-a",
      "workspace:w-b",
      "workspace:w-old",
    ]);
  });
});

describe("decideAskerLabel", () => {
  const group = (...sessions: Session[]) => buildSessionGroups(sessions)[0]!;

  it("gives no name to the lead, or to the only session of a group", () => {
    const pair = group(thread("s-lead"), agent("s-agent"));

    expect(decideAskerLabel(pair, "s-lead", "lead")).toBeNull();
    expect(decideAskerLabel(group(thread("s-lead")), "s-lead", "lead")).toBeNull();
  });

  it("gives its label to any other session", () => {
    const pair = group(thread("s-lead"), agent("s-agent"));

    expect(decideAskerLabel(pair, "s-agent", "review")).toBe("review");
  });
});

describe("orderProjectIdsByNewestGroup", () => {
  const inProject = (id: string, projectId: string | null, over: Partial<Session> = {}) =>
    thread(id, { workspaceId: `w-${id}`, projectId, ...over });

  it("lists projects by when their newest group started, newest first", () => {
    const sessions = [
      inProject("s-a", "p-a", { createdAt: at(1) }),
      inProject("s-b", "p-b", { createdAt: at(2) }),
      inProject("s-a2", "p-a", { createdAt: at(0) }),
    ];

    expect(orderProjectIdsByNewestGroup(sessions)).toEqual(["p-b", "p-a"]);
  });

  it("counts a reopening as a start", () => {
    const sessions = [
      inProject("s-a", "p-a", { createdAt: at(1), reopenedAt: at(5) }),
      inProject("s-b", "p-b", { createdAt: at(2) }),
    ];

    expect(orderProjectIdsByNewestGroup(sessions)).toEqual(["p-a", "p-b"]);
  });

  it("sorts projects that started at the same moment by project id, whatever order they came in", () => {
    const sessions = [inProject("s-b", "p-b"), inProject("s-a", "p-a")];

    expect(orderProjectIdsByNewestGroup(sessions)).toEqual(["p-a", "p-b"]);
    expect(orderProjectIdsByNewestGroup(sessions.toReversed())).toEqual(["p-a", "p-b"]);
  });

  it("never moves a project when a partner is spawned in one of its groups", () => {
    const lead = thread("s-lead", { projectId: "p-a", createdAt: at(1) });
    const other = inProject("s-b", "p-b", { createdAt: at(2) });
    const partner = thread("s-partner", { projectId: "p-a", createdAt: at(9) });

    expect(orderProjectIdsByNewestGroup([lead, other])).toEqual(["p-b", "p-a"]);
    expect(orderProjectIdsByNewestGroup([lead, other, partner])).toEqual(["p-b", "p-a"]);
  });

  it("files a group under its lead's project, whatever project a partner is in", () => {
    const lead = thread("s-lead", { projectId: "p-a" });
    const partner = thread("s-partner", { projectId: "p-b", createdAt: at(2) });

    expect(orderProjectIdsByNewestGroup([lead, partner])).toEqual(["p-a"]);
  });

  it("leaves out a group on the Done shelf, but not one with a Thread still to do", () => {
    const finished = inProject("s-a", "p-a", doneAt(9));
    const unfinished = [
      inProject("s-b", "p-b", doneAt(9)),
      thread("s-b2", { workspaceId: "w-s-b", projectId: "p-b", createdAt: at(2) }),
    ];

    expect(orderProjectIdsByNewestGroup([finished, ...unfinished])).toEqual(["p-b"]);
  });

  it("leaves out Agent sessions and groups whose lead has no project", () => {
    const sessions = [
      inProject("s-loose", null),
      agent("s-agent", { workspaceId: "w-s-loose", projectId: "p-a" }),
      agent("s-alone", { workspaceId: "w-alone", projectId: "p-b" }),
    ];

    expect(orderProjectIdsByNewestGroup(sessions)).toEqual([]);
  });
});

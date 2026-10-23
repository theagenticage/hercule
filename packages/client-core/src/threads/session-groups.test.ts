/**
 * Tests `orderProjectIdsByNewestGroup`, which orders the projects other
 * screens list by the sidebar's own rule: by when the project's newest group
 * started.
 */
import type { Session } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { orderProjectIdsByNewestGroup } from "./session-groups";
import { buildSession } from "./workspaces.testing";

const at = (minute: number): string => `2026-09-10T09:${String(minute).padStart(2, "0")}:00.000Z`;

const thread = (id: string, over: Partial<Session> = {}): Session =>
  buildSession({ id, kind: "thread", workspaceId: "w-1", createdAt: at(0), ...over });

const agent = (id: string, over: Partial<Session> = {}): Session =>
  buildSession({ id, kind: "agent", workspaceId: "w-1", createdAt: at(1), ...over });

const doneAt = (minute: number): Pick<Session, "done"> => ({
  done: { at: at(minute), by: "user" },
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

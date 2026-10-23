/**
 * Tests the helpers of the desktop sidebar's rows. The tests check that:
 *
 * - a row's second line names a branch a person chose, else the main
 *   workspace, else the machine, and never a generated branch;
 * - a thread last started when it was created, or reopened after that;
 * - projects are ordered by their most recently started thread, and projects
 *   that tie are ordered by project id.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { buildInstance } from "../providers.testing";
import {
  buildThreadPlaceLabel,
  orderProjectIdsByNewestThread,
  pickLastStartedAt,
} from "./project-rows";
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

describe("buildThreadPlaceLabel", () => {
  const label = (over: Partial<Parameters<typeof buildThreadPlaceLabel>[0]>) =>
    buildThreadPlaceLabel({
      workspace: PRIMARY,
      branch: null,
      machine: "moss",
      resources: [WEBSHOP],
      runners: [MOSS],
      ...over,
    });

  it("cuts a long branch name a person chose in the middle and keeps its end", () => {
    expect(label({ branch: "rogier/fix-the-sidebar-rows" })).toEqual({
      clip: "rogier/fix-the-",
      keep: "sidebar-rows",
    });
    expect(label({ branch: "main" })).toEqual({ clip: "", keep: "main" });
  });

  it("names a main workspace with no known branch by its repo and machine", () => {
    expect(label({})).toEqual({ clip: "webshop", keep: " · moss" });
  });

  it("names the machine when the branch is one the controller generated", () => {
    expect(label({ workspace: THREAD_3F1, branch: "hercule/thread-3f1" })).toEqual({
      clip: "moss",
      keep: "",
    });
  });

  it("names the machine for a thread with no workspace, and says so when it has neither", () => {
    expect(label({ workspace: undefined })).toEqual({ clip: "moss", keep: "" });
    expect(label({ workspace: undefined, machine: null })).toEqual({
      clip: "No workspace",
      keep: "",
    });
  });
});

describe("pickLastStartedAt", () => {
  it("returns the creation time, or a later reopening, and ignores a reopening older than the thread", () => {
    const flaky = SESSIONS_BY_ID.get("s-flaky")!;

    expect(pickLastStartedAt(flaky)).toBe(buildTimestamp(1));
    expect(pickLastStartedAt({ ...flaky, reopenedAt: buildTimestamp(7) })).toBe(buildTimestamp(7));
    expect(pickLastStartedAt({ ...flaky, reopenedAt: buildTimestamp(0) })).toBe(buildTimestamp(1));
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
});

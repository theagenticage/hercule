import { describe, expect, it } from "vitest";
import { buildSession } from "@hercule/client-core/threads/testing";
import { groupSidebarSessions } from "./session-groups";

describe("groupSidebarSessions", () => {
  const listed = [buildSession({ id: "s-listed", title: "Listed" })];
  const open = buildSession({
    id: "s-open",
    title: "Open",
    done: { at: "2026-09-01T09:00:00.000Z", by: "user" },
  });

  it("adds the open session to the list's, and groups both", () => {
    const { sessions, groups } = groupSidebarSessions(listed, open);

    expect(sessions.map((session) => session.id)).toEqual(["s-listed", "s-open"]);
    expect(groups.map((group) => group.key).toSorted()).toEqual([
      "session:s-listed",
      "session:s-open",
    ]);
  });

  it("keeps the list's record when both hold the open session", () => {
    const { sessions } = groupSidebarSessions([{ ...open, title: "From the list" }], open);

    expect(sessions.map((session) => session.title)).toEqual(["From the list"]);
  });

  it("groups once for every caller while the list and the open session stay the same", () => {
    const first = groupSidebarSessions(listed, open);

    expect(groupSidebarSessions(listed, open)).toBe(first);
    expect(groupSidebarSessions([...listed], open)).not.toBe(first);
    expect(groupSidebarSessions(listed, null)).not.toBe(first);
  });
});

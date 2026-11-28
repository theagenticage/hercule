import { describe, expect, it } from "vitest";
import { indexRowMembers } from "./row-members";
import { prepareSessionPresentation } from "./session-presentation";
import { MOSS, buildSession } from "./workspaces.testing";

describe("indexRowMembers", () => {
  const present = (lastActivityAt: string) =>
    prepareSessionPresentation({
      listedSessions: [
        buildSession({ id: "lead", title: "Fix the test", workspaceId: "w-1", role: "lead" }),
        buildSession({
          id: "helper",
          title: "Review it",
          workspaceId: "w-1",
          agentId: "agent-1",
          role: "review",
          status: "exited",
          lastActivityAt,
        }),
      ],
      openSession: null,
      projects: [],
      workspaces: [],
      resources: [],
      runners: [MOSS],
      accounts: [],
    }).groupRows;

  it("names the row of every session, an exited one included", () => {
    const members = indexRowMembers(present("2026-09-10T09:00:00.000Z"));

    expect(members).toEqual({
      lead: { rowKey: "workspace:w-1", rowTitle: "Fix the test", leadId: "lead", label: "lead" },
      helper: {
        rowKey: "workspace:w-1",
        rowTitle: "Fix the test",
        leadId: "lead",
        label: "review",
      },
    });
  });

  it("stays equal when only a session's last activity changes", () => {
    expect(indexRowMembers(present("2026-09-10T10:30:00.000Z"))).toEqual(
      indexRowMembers(present("2026-09-10T09:00:00.000Z")),
    );
  });
});

/**
 * Tests `listWaitingThreads`, which decides the threads the desktop app counts
 * on its dock badge and shows notifications for.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest } from "@hercule/contract";
import { buildSession } from "./workspaces.testing";
import { listWaitingThreads } from "./waiting-threads";

const buildCommandRequest = (requestId: string, command: string): OpenRequest => ({
  requestId,
  itemId: "tool-1",
  decisions: ["allow", "deny"],
  kind: "command_approval",
  detail: { command },
});

describe("listWaitingThreads", () => {
  it("lists the threads with an open Request, in list order, with their question", () => {
    expect(
      listWaitingThreads([
        buildSession({
          id: "s-1",
          title: "Fix the login bug",
          openRequest: buildCommandRequest("r-1", "git push"),
        }),
        buildSession({ id: "s-2", title: "Idle thread" }),
        buildSession({
          id: "s-3",
          title: "Write the release notes",
          openRequest: buildCommandRequest("r-3", "pnpm test"),
        }),
      ]),
    ).toEqual([
      { sessionId: "s-1", requestId: "r-1", title: "Fix the login bug", question: "Run git push?" },
      {
        sessionId: "s-3",
        requestId: "r-3",
        title: "Write the release notes",
        question: "Run pnpm test?",
      },
    ]);
  });
});

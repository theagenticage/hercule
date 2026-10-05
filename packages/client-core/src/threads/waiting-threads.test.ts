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
          openRequests: [buildCommandRequest("r-1", "git push")],
        }),
        buildSession({ id: "s-2", title: "Idle thread" }),
        buildSession({
          id: "s-3",
          title: "Write the release notes",
          openRequests: [buildCommandRequest("r-3", "pnpm test")],
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

  it("shows the oldest of a thread's open Requests, whichever agent asked it", () => {
    expect(
      listWaitingThreads([
        buildSession({
          id: "s-1",
          title: "Fix the login bug",
          openRequests: [
            { ...buildCommandRequest("r-1", "git push"), subagentId: "agent-1" },
            buildCommandRequest("r-2", "pnpm test"),
          ],
        }),
      ]),
    ).toEqual([
      { sessionId: "s-1", requestId: "r-1", title: "Fix the login bug", question: "Run git push?" },
    ]);
  });

  it("lists a thread parked on a question, with its first question as its line", () => {
    const question: OpenRequest = {
      requestId: "r-1",
      itemId: "tool-1",
      kind: "question",
      detail: {
        questions: [
          {
            question: "Which storage should drafts use?",
            header: "Storage",
            options: [
              { label: "localStorage", description: "" },
              { label: "IndexedDB", description: "" },
            ],
            multiSelect: false,
          },
          {
            question: "Which features should ship?",
            header: "Features",
            options: [{ label: "Sync", description: "" }],
            multiSelect: true,
          },
        ],
      },
    };

    expect(
      listWaitingThreads([
        buildSession({ id: "s-1", title: "Save drafts", openRequests: [question] }),
      ]),
    ).toEqual([
      {
        sessionId: "s-1",
        requestId: "r-1",
        title: "Save drafts",
        question: "Which storage should drafts use?",
      },
    ]);
  });
});

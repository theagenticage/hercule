/**
 * Tests `listWaitingThreads`, which decides the threads the desktop app counts
 * on its dock badge and the text of their notifications.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest, Subagent } from "@hercule/contract";
import { buildSubagent } from "../subagents/subagents.testing";
import { buildSession } from "./workspaces.testing";
import { listWaitingThreads } from "./waiting-threads";

const buildCommandRequest = (
  requestId: string,
  command: string,
  subagentId?: string,
): OpenRequest => ({
  requestId,
  itemId: `tool-${requestId}`,
  decisions: ["allow", "deny"],
  kind: "command_approval",
  detail: { command },
  ...(subagentId === undefined ? {} : { subagentId }),
});

const NO_SUBAGENTS = new Map<string, readonly Subagent[]>();

describe("listWaitingThreads", () => {
  it("lists the threads with an open Request, in list order, with their question", () => {
    expect(
      listWaitingThreads(
        [
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
        ],
        NO_SUBAGENTS,
      ),
    ).toEqual([
      {
        sessionId: "s-1",
        title: "Fix the login bug",
        body: "Run git push?",
        openRequestIds: ["r-1"],
      },
      {
        sessionId: "s-3",
        title: "Write the release notes",
        body: "Run pnpm test?",
        openRequestIds: ["r-3"],
      },
    ]);
  });

  it("is about the newest Request, counts the others, and lists every id oldest first", () => {
    expect(
      listWaitingThreads(
        [
          buildSession({
            id: "s-1",
            title: "Fix the login bug",
            openRequests: [
              buildCommandRequest("r-1", "git push", "agent-1"),
              buildCommandRequest("r-2", "ls"),
              buildCommandRequest("r-3", "pnpm test"),
            ],
          }),
        ],
        NO_SUBAGENTS,
      ),
    ).toEqual([
      {
        sessionId: "s-1",
        title: "Fix the login bug",
        body: "Run pnpm test? +2 more waiting",
        openRequestIds: ["r-1", "r-2", "r-3"],
      },
    ]);
  });

  it("names the subagent that asked the newest Request", () => {
    const subagents = new Map([
      ["s-1", [buildSubagent({ id: "agent-1", description: "Explore the auth module" })]],
    ]);
    expect(
      listWaitingThreads(
        [
          buildSession({
            id: "s-1",
            title: "Fix the login bug",
            openRequests: [
              buildCommandRequest("r-1", "ls"),
              buildCommandRequest("r-2", "git push", "agent-1"),
            ],
          }),
        ],
        subagents,
      ).map((thread) => thread.body),
    ).toEqual(["Explore the auth module asks: Run git push? +1 more waiting"]);
  });

  it('names a subagent whose record is not there "A subagent"', () => {
    const otherSubagents = new Map([["s-1", [buildSubagent({ id: "agent-2" })]]]);
    const session = buildSession({
      id: "s-1",
      title: "Fix the login bug",
      openRequests: [buildCommandRequest("r-1", "git push", "agent-1")],
    });
    expect(listWaitingThreads([session], NO_SUBAGENTS)[0]?.body).toBe(
      "A subagent asks: Run git push?",
    );
    expect(listWaitingThreads([session], otherSubagents)[0]?.body).toBe(
      "A subagent asks: Run git push?",
    );
  });

  it("lists a thread parked on a question, with its first question as its body", () => {
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
      listWaitingThreads(
        [buildSession({ id: "s-1", title: "Save drafts", openRequests: [question] })],
        NO_SUBAGENTS,
      ),
    ).toEqual([
      {
        sessionId: "s-1",
        title: "Save drafts",
        body: "Which storage should drafts use?",
        openRequestIds: ["r-1"],
      },
    ]);
  });
});

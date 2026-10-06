/**
 * Tests `listWaiting`, which decides the threads and assistants the desktop
 * app counts on its dock badge, shows notifications for, and lists in
 * Waiting on you and its Go menu.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest, Session } from "@hercule/contract";
import type { AssistantRow } from "./assistants/rows";
import { buildSession } from "./threads/workspaces.testing";
import { listWaiting } from "./waiting";

const EARLY = "2026-09-10T09:00:00.000Z";
const MIDDLE = "2026-09-10T09:05:00.000Z";
const LATE = "2026-09-10T09:10:00.000Z";

const buildCommandRequest = (requestId: string, command: string): OpenRequest => ({
  requestId,
  itemId: "tool-1",
  decisions: ["allow", "deny"],
  kind: "command_approval",
  detail: { command },
});

/** Returns an assistant's row whose current session is `session`, or that has none. */
const buildAssistantRow = (id: string, name: string, session: Session | null): AssistantRow => ({
  id,
  name,
  pose: session === null ? "idle" : "waiting",
  session,
});

describe("listWaiting", () => {
  it("lists the threads with an open Request, with their question", () => {
    expect(
      listWaiting(
        [
          buildSession({
            id: "s-1",
            title: "Fix the login bug",
            lastActivityAt: LATE,
            openRequests: [buildCommandRequest("r-1", "git push")],
          }),
          buildSession({ id: "s-2", title: "Idle thread" }),
          buildSession({
            id: "s-3",
            title: "Write the release notes",
            lastActivityAt: EARLY,
            openRequests: [buildCommandRequest("r-3", "pnpm test")],
          }),
        ],
        [],
      ),
    ).toEqual([
      {
        kind: "thread",
        sessionId: "s-1",
        requestId: "r-1",
        title: "Fix the login bug",
        question: "Run git push?",
        newestRequestId: "r-1",
        openRequestIds: ["r-1"],
        notificationBody: "Run git push?",
        activityAt: LATE,
      },
      {
        kind: "thread",
        sessionId: "s-3",
        requestId: "r-3",
        title: "Write the release notes",
        question: "Run pnpm test?",
        newestRequestId: "r-3",
        openRequestIds: ["r-3"],
        notificationBody: "Run pnpm test?",
        activityAt: EARLY,
      },
    ]);
  });

  it("lists the assistants whose session has an open Request, and skips the rest", () => {
    const asking = buildSession({
      id: "s-ada",
      lastActivityAt: MIDDLE,
      openRequests: [buildCommandRequest("r-ada", "git push")],
    });

    expect(
      listWaiting(
        [],
        [
          buildAssistantRow("a-ada", "Ada", asking),
          buildAssistantRow("a-bob", "Bob", buildSession({ id: "s-bob" })),
          buildAssistantRow("a-cy", "Cy", null),
        ],
      ),
    ).toEqual([
      {
        kind: "assistant",
        assistantId: "a-ada",
        name: "Ada",
        sessionId: "s-ada",
        requestId: "r-ada",
        question: "Run git push?",
        newestRequestId: "r-ada",
        openRequestIds: ["r-ada"],
        notificationBody: "Run git push?",
        activityAt: MIDDLE,
      },
    ]);
  });

  it("mixes threads and assistants, the most recently active first", () => {
    const waiting = listWaiting(
      [
        buildSession({
          id: "s-old",
          lastActivityAt: EARLY,
          openRequests: [buildCommandRequest("r-old", "ls")],
        }),
        buildSession({
          id: "s-new",
          lastActivityAt: LATE,
          openRequests: [buildCommandRequest("r-new", "ls")],
        }),
      ],
      [
        buildAssistantRow(
          "a-ada",
          "Ada",
          buildSession({
            id: "s-ada",
            lastActivityAt: MIDDLE,
            openRequests: [buildCommandRequest("r-ada", "ls")],
          }),
        ),
      ],
    );

    expect(waiting.map((entry) => entry.sessionId)).toEqual(["s-new", "s-ada", "s-old"]);
  });

  it("orders entries active at the same moment by session id, whatever the order of the lists", () => {
    const asking = (id: string) =>
      buildSession({
        id,
        lastActivityAt: MIDDLE,
        openRequests: [buildCommandRequest(`r-${id}`, "ls")],
      });

    const waiting = listWaiting(
      [asking("s-c"), asking("s-a")],
      [buildAssistantRow("a-ada", "Ada", asking("s-b"))],
    );

    expect(waiting.map((entry) => entry.sessionId)).toEqual(["s-a", "s-b", "s-c"]);
  });

  it("shows the oldest of a session's open Requests in the row, whichever agent asked it", () => {
    const [waiting] = listWaiting(
      [
        buildSession({
          id: "s-1",
          title: "Fix the login bug",
          openRequests: [
            { ...buildCommandRequest("r-1", "git push"), subagentId: "agent-1" },
            buildCommandRequest("r-2", "pnpm test"),
          ],
        }),
      ],
      [],
    );

    expect(waiting).toMatchObject({ requestId: "r-1", question: "Run git push?" });
  });

  it("shows the newest of a session's open Requests in the notification, and counts the others", () => {
    const [waiting] = listWaiting(
      [
        buildSession({
          id: "s-1",
          openRequests: [
            buildCommandRequest("r-1", "git push"),
            buildCommandRequest("r-2", "pnpm test"),
            buildCommandRequest("r-3", "make deploy"),
          ],
        }),
      ],
      [],
    );

    expect(waiting).toMatchObject({
      newestRequestId: "r-3",
      openRequestIds: ["r-1", "r-2", "r-3"],
      notificationBody: "Run make deploy?\n+2 more waiting",
    });
  });

  it("starts the notification with the subagent's name when a subagent asked the newest Request", () => {
    const [waiting] = listWaiting(
      [],
      [
        buildAssistantRow(
          "a-ada",
          "Ada",
          buildSession({
            id: "s-ada",
            openRequests: [
              buildCommandRequest("r-1", "git push"),
              {
                ...buildCommandRequest("r-2", "pnpm test"),
                subagentId: "agent-1",
                subagentName: "Review the diff",
              },
            ],
          }),
        ),
      ],
    );

    expect(waiting).toMatchObject({
      requestId: "r-1",
      question: "Run git push?",
      newestRequestId: "r-2",
      notificationBody: "Review the diff asks: Run pnpm test?\n+1 more waiting",
    });
  });

  it('starts the notification with "A subagent asks: " when the subagent has no name yet', () => {
    const [waiting] = listWaiting(
      [
        buildSession({
          id: "s-1",
          openRequests: [{ ...buildCommandRequest("r-1", "pnpm test"), subagentId: "agent-1" }],
        }),
      ],
      [],
    );

    expect(waiting?.notificationBody).toBe("A subagent asks: Run pnpm test?");
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
      listWaiting(
        [buildSession({ id: "s-1", title: "Save drafts", openRequests: [question] })],
        [],
      ),
    ).toEqual([
      {
        kind: "thread",
        sessionId: "s-1",
        requestId: "r-1",
        title: "Save drafts",
        question: "Which storage should drafts use?",
        newestRequestId: "r-1",
        openRequestIds: ["r-1"],
        notificationBody: "Which storage should drafts use?",
        activityAt: EARLY,
      },
    ]);
  });
});

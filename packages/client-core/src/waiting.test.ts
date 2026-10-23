/**
 * Tests `listWaiting`, which adds the assistants to the Threads and Agent
 * sessions that wait on the user and sorts them for the desktop app's dock
 * badge, notifications, Waiting on you and Go menu, and
 * `listWaitingRunSessions`, which decides the runs' sessions Waiting on you
 * lists under "From runs".
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest, Session } from "@hercule/contract";
import type { AssistantRow } from "./assistants/rows";
import { buildSession } from "./threads/workspaces.testing";
import { listWaiting, listWaitingRunSessions, type WaitingSession } from "./waiting";

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

/** Returns an assistant's session that asks to run `command`, last active at `lastActivityAt`. */
const buildAsking = (id: string, lastActivityAt: string, command = "ls"): Session =>
  buildSession({
    id,
    lastActivityAt,
    openRequests: [buildCommandRequest(`r-${id}`, command)],
  });

/** Returns the entry of a Thread that waits, last active at `activityAt`. */
const buildWaitingSession = (sessionId: string, activityAt: string): WaitingSession => ({
  kind: "session",
  sessionId,
  requestId: `r-${sessionId}`,
  title: "A thread",
  groupKey: `session:${sessionId}`,
  groupName: "A thread",
  askerLabel: null,
  question: "Run ls?",
  newestRequestId: `r-${sessionId}`,
  openRequestIds: [`r-${sessionId}`],
  notificationBody: "Run ls?",
  activityAt,
});

describe("listWaiting", () => {
  it("lists the assistants whose session has an open Request, and skips the rest", () => {
    expect(
      listWaiting(
        [],
        [
          buildAssistantRow("a-ada", "Ada", buildAsking("s-ada", MIDDLE, "git push")),
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
        requestId: "r-s-ada",
        question: "Run git push?",
        newestRequestId: "r-s-ada",
        openRequestIds: ["r-s-ada"],
        notificationBody: "Run git push?",
        activityAt: MIDDLE,
      },
    ]);
  });

  it("mixes sessions and assistants, the most recently active first, and ties by session id", () => {
    const sessions = [buildWaitingSession("s-old", EARLY), buildWaitingSession("s-new", LATE)];
    const ada = buildAssistantRow("a-ada", "Ada", buildAsking("s-ada", MIDDLE));
    const tied = [buildWaitingSession("s-c", MIDDLE), buildWaitingSession("s-a", MIDDLE)];
    const bob = buildAssistantRow("a-bob", "Bob", buildAsking("s-b", MIDDLE));

    expect(listWaiting(sessions, [ada]).map((entry) => entry.sessionId)).toEqual([
      "s-new",
      "s-ada",
      "s-old",
    ]);
    expect(listWaiting(tied, [bob]).map((entry) => entry.sessionId)).toEqual(["s-a", "s-b", "s-c"]);
  });
});

describe("listWaitingRunSessions", () => {
  it("lists the run sessions with an open Request, most recently active first, with their oldest question", () => {
    expect(
      listWaitingRunSessions([
        buildSession({
          id: "s-security",
          title: "Release · security",
          agentId: "a-flow",
          runId: "run-1",
          stepId: "security",
          lastActivityAt: EARLY,
          openRequests: [buildCommandRequest("r-1", "npm audit fix")],
        }),
        buildSession({
          id: "s-publish",
          title: "Release · publish",
          agentId: "a-flow",
          runId: "run-1",
          stepId: "publish",
          lastActivityAt: LATE,
          openRequests: [
            buildCommandRequest("r-2", "npm publish"),
            buildCommandRequest("r-3", "git push --tags"),
          ],
        }),
      ]),
    ).toEqual([
      {
        sessionId: "s-publish",
        runId: "run-1",
        stepId: "publish",
        title: "Release · publish",
        question: "Run npm publish?",
        activityAt: LATE,
      },
      {
        sessionId: "s-security",
        runId: "run-1",
        stepId: "security",
        title: "Release · security",
        question: "Run npm audit fix?",
        activityAt: EARLY,
      },
    ]);
  });

  it("leaves out a run session that asks nothing, and a waiting session of no run", () => {
    expect(
      listWaitingRunSessions([
        buildSession({
          id: "s-step",
          agentId: "a-flow",
          runId: "run-1",
          stepId: "build",
          lastActivityAt: MIDDLE,
        }),
        buildSession({
          id: "s-assistant",
          agentId: "a-ada",
          conversationId: "c-1",
          openRequests: [buildCommandRequest("r-1", "git push")],
        }),
      ]),
    ).toEqual([]);
  });
});

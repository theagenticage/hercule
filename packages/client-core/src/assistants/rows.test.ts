/**
 * Tests `buildAssistantRows`, which decides the rows of the desktop sidebar's
 * Assistants section and their order, and `decideAssistantPose`, which
 * decides the pose each assistant's face shows.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest, Runner, Session } from "@hercule/contract";
import { buildRunner, buildSession } from "../threads/workspaces.testing";
import { buildAssistantRows, decideAssistantPose } from "./rows";

const ONLINE = buildRunner("r-moss", "moss");
const OFFLINE: Runner = { ...ONLINE, connectivity: "offline" };

const ADA = { id: "a-ada", name: "Ada" };

const REQUEST: OpenRequest = {
  requestId: "r-1",
  itemId: "tool-1",
  decisions: ["allow", "deny"],
  kind: "command_approval",
  detail: { command: "git push" },
};

/** Returns the current session of Ada's main conversation, on the runner moss. */
const buildAdaSession = (over: Partial<Session> = {}): Session =>
  buildSession({
    id: "s-ada",
    agentId: ADA.id,
    conversationId: "c-ada",
    runnerId: ONLINE.id,
    ...over,
  });

describe("buildAssistantRows", () => {
  it("shows an assistant with no session yet as idle", () => {
    expect(buildAssistantRows([ADA], new Map(), [ONLINE])).toEqual([
      { id: "a-ada", name: "Ada", pose: "idle", session: null },
    ]);
  });

  it("carries the current session on the row", () => {
    const session = buildAdaSession();

    expect(buildAssistantRows([ADA], new Map([[ADA.id, session]]), [ONLINE])[0]?.session).toBe(
      session,
    );
  });

  it("decides the pose of each row with decideAssistantPose", () => {
    const session = buildAdaSession({ status: "exited", resumable: false });

    expect(buildAssistantRows([ADA], new Map([[ADA.id, session]]), [OFFLINE])[0]?.pose).toBe(
      decideAssistantPose(session, OFFLINE),
    );
  });

  it("sorts the rows by name, whatever the order of the list, and by id for the same name", () => {
    const assistants = [
      { id: "a-3", name: "zoë" },
      { id: "a-2", name: "Bob" },
      { id: "a-4", name: "ada" },
      { id: "a-1", name: "Bob" },
    ];

    expect(buildAssistantRows(assistants, new Map(), []).map((row) => row.id)).toEqual([
      "a-4",
      "a-1",
      "a-2",
      "a-3",
    ]);
  });
});

describe("decideAssistantPose", () => {
  it("shows an assistant with no session yet as idle", () => {
    expect(decideAssistantPose(null, ONLINE)).toBe("idle");
  });

  it("decides each pose from the current session, as a thread's", () => {
    expect(decideAssistantPose(buildAdaSession({ status: "busy" }), ONLINE)).toBe("working");
    expect(decideAssistantPose(buildAdaSession({ status: "idle" }), ONLINE)).toBe("idle");
    expect(decideAssistantPose(buildAdaSession({ openRequests: [REQUEST] }), ONLINE)).toBe(
      "waiting",
    );
    expect(
      decideAssistantPose(buildAdaSession({ status: "exited", resumable: true }), ONLINE),
    ).toBe("asleep");
    expect(
      decideAssistantPose(buildAdaSession({ status: "exited", resumable: false }), ONLINE),
    ).toBe("away");
  });

  it("shows an assistant whose session's runner is offline as away", () => {
    expect(decideAssistantPose(buildAdaSession({ status: "idle" }), OFFLINE)).toBe("away");
  });

  it("counts a missing runner as connected", () => {
    expect(decideAssistantPose(buildAdaSession({ status: "idle" }), undefined)).toBe("idle");
  });
});

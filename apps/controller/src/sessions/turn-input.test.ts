/** Tests which session `buildTurnInput` names as the sender of an input. */
import { describe, expect, it } from "vitest";
import type { InputSource } from "@hercule/contract";
import type { StoredInput } from "./inputs";
import { buildTurnInput } from "./turn-input";

const RECEIVER_ID = "0199f0b7-0000-7000-8000-000000000001";
const SENDER_ID = "0199f0b7-0000-7000-8000-000000000002";
const RUN_ID = "0199f0b7-0000-7000-8000-000000000003";

/** The session the input is for: a Thread, started by no step. */
const receiver = {
  id: RECEIVER_ID,
  runId: null,
  stepId: null,
  modelSelection: { model: "clever", options: {} },
};

/** Builds a waiting input for `receiver` with this source and actor stamp. */
const buildRow = (source: InputSource, actor: string): StoredInput => ({
  id: "0199f0b7-0000-7000-8000-000000000004",
  sessionId: RECEIVER_ID,
  source,
  actor,
  text: "The 3DS fix is merged, rebase on main",
  attachments: [],
  status: "queued",
  delivery: null,
  createdAt: "2026-10-10T12:00:00.000Z",
  deliveredAt: null,
  sentAt: null,
  reason: null,
  stepIteration: null,
});

describe("buildTurnInput's sender", () => {
  it("names the session whose agent sent the input as a message", () => {
    const input = buildTurnInput(receiver, buildRow("user", `session:${SENDER_ID}`));
    expect(input.senderSessionId).toBe(SENDER_ID);
  });

  it.each<readonly [string, InputSource, string]>([
    ["the owner's message", "user", "user"],
    ["a run's input", "user", `run:${RUN_ID}`],
    ["a session's message to itself", "user", `session:${RECEIVER_ID}`],
    ["a subscription delivery", "subscription", `session:${SENDER_ID}`],
    ["a heartbeat", "heartbeat", `session:${SENDER_ID}`],
    ["a reminder", "reminder", `session:${SENDER_ID}`],
  ])("names no sender for %s", (_, source, actor) => {
    expect(buildTurnInput(receiver, buildRow(source, actor))).not.toHaveProperty("senderSessionId");
  });
});

/**
 * Tests `splitQueuedInputs(session, inputs)`, which splits a session's queued
 * inputs into the ones that wait and the ones on their way into the session,
 * and `canSteerQueuedInputs(session)`.
 */
import { describe, expect, it } from "vitest";
import type { Input, SessionStatus } from "@hercule/contract";
import { canSteerQueuedInputs, splitQueuedInputs } from "./queued-inputs";
import { buildSession } from "./workspaces.testing";

const SESSION_ID = "01a12f36-6bab-7539-97e1-94b213c91582";

const buildInput = (id: string, over: Partial<Input> = {}): Input => ({
  id,
  sessionId: SESSION_ID,
  source: "user",
  actor: "user",
  text: `message ${id}`,
  attachments: [],
  status: "queued",
  delivery: null,
  createdAt: "2026-10-12T19:02:39.059Z",
  deliveredAt: null,
  sentAt: null,
  reason: null,
  ...over,
});

const sessionIn = (status: SessionStatus) => buildSession({ id: SESSION_ID, status });

const FIRST = buildInput("01a1317e-d8d3-7402-8971-cfcc37f653c1");
const SECOND = buildInput("01a1317e-d8d3-7402-8971-cfcc37f653c2");
const HANDED_OVER = { ...FIRST, sentAt: "2026-10-12T19:02:39.071Z" };

describe("splitQueuedInputs", () => {
  it("shows an input the runner was handed as sending, whatever the session's status", () => {
    for (const status of ["idle", "starting", "busy"] as const) {
      expect(splitQueuedInputs(sessionIn(status), [HANDED_OVER, SECOND])).toEqual({
        waiting: [SECOND],
        sending: [HANDED_OVER],
      });
    }
  });

  it("shows the input a waiting start will carry as sending, and the rest as waiting", () => {
    expect(splitQueuedInputs(sessionIn("queued"), [FIRST, SECOND])).toEqual({
      waiting: [SECOND],
      sending: [FIRST],
    });
  });

  it("keeps every input of a busy session waiting until the runner is handed one", () => {
    expect(splitQueuedInputs(sessionIn("busy"), [FIRST, SECOND])).toEqual({
      waiting: [FIRST, SECOND],
      sending: [],
    });
  });

  it("leaves out inputs that are no longer queued", () => {
    const delivered = { ...FIRST, status: "delivered" as const };
    const cancelled = { ...SECOND, status: "cancelled" as const };
    expect(splitQueuedInputs(sessionIn("queued"), [delivered, cancelled])).toEqual({
      waiting: [],
      sending: [],
    });
  });
});

describe("canSteerQueuedInputs", () => {
  it("offers Steer only while a turn runs", () => {
    expect(canSteerQueuedInputs(sessionIn("busy"))).toBe(true);
    for (const status of ["queued", "starting", "idle", "exited"] as const) {
      expect(canSteerQueuedInputs(sessionIn(status))).toBe(false);
    }
  });

  it("never offers Steer on a session that answers an assistant's conversation", () => {
    const conversation = buildSession({
      id: SESSION_ID,
      status: "busy",
      conversationId: "01a12f36-0000-7000-8000-000000000001",
    });
    expect(canSteerQueuedInputs(conversation)).toBe(false);
  });
});

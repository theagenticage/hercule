/**
 * Tests `isThreadCopy`, which decides whether a thread copy read back from
 * disk still fits the contract. The copy goes through `structuredClone` first,
 * because that is how IndexedDB stores it.
 */
import { describe, expect, it } from "vitest";
import type { Input, Session, Subagent, TranscriptRow } from "@hercule/contract";
import { isThreadCopy, type ThreadCopy } from "./thread-copy";

const SESSION_ID = "01a12f36-6bab-7539-97e1-94b213c91582";
const AT = "2026-10-19T09:00:00.000Z";

const SESSION: Session = {
  id: SESSION_ID,
  title: "Fix the flaky upload test",
  status: "idle",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: "01a12f36-6bab-7539-97e1-94b213c91583",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: "01a12f36-6bab-7539-97e1-94b213c91584",
  runnerId: "01a12f36-6bab-7539-97e1-94b213c91585",
  workspaceId: "01a12f36-6bab-7539-97e1-94b213c91586",
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: { effort: "high" } },
  parentSessionId: null,
  openRequests: [],
  openPermissionRequests: [],
  usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.02 },
  toolCalls: 2,
  createdAt: AT,
  startedAt: AT,
  exitedAt: null,
  lastActivityAt: AT,
  unenforced: [],
};

const SUBAGENT: Subagent = {
  id: "agent-1",
  sessionId: SESSION_ID,
  description: "Read the test",
  status: "completed",
  toolCalls: 1,
  startedAt: AT,
  endedAt: AT,
};

const QUEUED_INPUT: Input = {
  id: "01a12f36-6bab-7539-97e1-94b213c91590",
  sessionId: SESSION_ID,
  source: "user",
  actor: "user",
  text: "Also run the linter",
  attachments: [],
  status: "queued",
  delivery: null,
  createdAt: AT,
  deliveredAt: null,
  sentAt: null,
  reason: null,
};

/** Builds one turn's worth of rows, starting at `first`: a turn start, a tool call, text, a turn end. */
const buildTurnRows = (
  first: number,
): [TranscriptRow, TranscriptRow, TranscriptRow, TranscriptRow] => {
  const turnId = `turn-${first}`;
  const event = { sessionId: SESSION_ID, at: AT, turnId };
  return [
    { position: first, at: AT, event: { _tag: "turn.started", eventId: `e${first}`, ...event } },
    {
      position: first + 1,
      at: AT,
      event: {
        _tag: "item.started",
        eventId: `e${first + 1}`,
        ...event,
        itemId: "item-1",
        kind: "command_execution",
        detail: { command: "pnpm test", cwd: null, flags: ["-u"] },
      },
    },
    {
      position: first + 2,
      at: AT,
      event: {
        _tag: "content.delta",
        eventId: `e${first + 2}`,
        ...event,
        itemId: "item-2",
        streamKind: "assistant_text",
        delta: "The upload test waits on a timer.",
      },
    },
    {
      position: first + 3,
      at: AT,
      event: {
        _tag: "turn.completed",
        eventId: `e${first + 3}`,
        ...event,
        state: "completed",
        usage: { inputTokens: 1200, outputTokens: 340 },
      },
    },
  ];
};

const FIRST_TURN = buildTurnRows(1);

const COPY: ThreadCopy = {
  session: SESSION,
  subagents: [SUBAGENT],
  queuedInputs: [QUEUED_INPUT],
  transcript: [...FIRST_TURN, ...buildTurnRows(5)],
  subagentTranscripts: { "agent-1": FIRST_TURN },
};

/** Returns `record` without the key `name`. */
const omit = (record: object, name: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== name));

/** Returns `value` as IndexedDB hands it back: the stored form of a structured clone. */
const readBack = (value: unknown): unknown => structuredClone(value);

const [FIRST_ROW, SECOND_ROW, ...OTHER_ROWS] = FIRST_TURN;

describe("isThreadCopy", () => {
  it("accepts a copy that went through structured clone", () => {
    expect(isThreadCopy(readBack(COPY))).toBe(true);
  });

  it.each([
    [
      "a row without a position",
      { ...COPY, transcript: [FIRST_ROW, omit(SECOND_ROW, "position"), ...OTHER_ROWS] },
    ],
    [
      "a subagent row without a position",
      { ...COPY, subagentTranscripts: { "agent-1": [omit(FIRST_ROW, "position")] } },
    ],
    [
      "an event of a kind this app does not know",
      {
        ...COPY,
        transcript: [{ ...FIRST_ROW, event: { ...FIRST_ROW.event, _tag: "turn.vanished" } }],
      },
    ],
    [
      "a session status this app does not know",
      { ...COPY, session: { ...SESSION, status: "hovering" } },
    ],
    [
      "a subagent field of the wrong type",
      { ...COPY, subagents: [{ ...SUBAGENT, toolCalls: "1" }] },
    ],
    ["a queued input without a status", { ...COPY, queuedInputs: [omit(QUEUED_INPUT, "status")] }],
    ["no subagent transcripts", omit(COPY, "subagentTranscripts")],
    ["null", null],
    ["a string", "thread"],
    ["an empty object", {}],
  ])("returns false for %s", (_name, stored) => {
    expect(isThreadCopy(readBack(stored))).toBe(false);
  });
});

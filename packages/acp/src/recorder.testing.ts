/**
 * What the tests of `openAcpConnection` share: the messages they send, a
 * recorder of what the handlers receive, and a fake harness
 * (`./testing`) wired to a connection. The fake answers the calls the client
 * writes with real replies from a recording, and with what a test scripts.
 */
import * as Effect from "effect/Effect";
import { createChangeNotifier } from "./change-notifier.testing";
import { openAcpConnection } from "./connection";
import {
  answerWith,
  readRecording,
  startFakeHarness,
  type HarnessScript,
  type JsonRpcMessage,
} from "./testing";
import type {
  AcpConnection,
  ApprovalOutcome,
  ApprovalRequest,
  ElicitationReply,
  ElicitationRequest,
  SessionUpdateNotification,
  UnhandledMessage,
} from "./types";

export const SESSION = "session-1";
export const SYNC_ADVICE = "Sync packages/acp/vendor with T3 Code (packages/acp/README.md).";

/** The real reply of Antigravity to a call, from the recording `edit-shell`. */
const findRecordedResult = (method: string): unknown => {
  const recording = readRecording("edit-shell");
  const id = recording.find(({ message }) => message.method === method)?.message.id;
  return recording.find(({ direction, message }) => direction === "in" && message.id === id)
    ?.message.result;
};

export const PROMPT_RESULT = {
  stopReason: "end_turn",
  usage: { totalTokens: 6, inputTokens: 1, outputTokens: 2, cachedReadTokens: 3 },
};

const TOOL_CALL = {
  toolCallId: "call_1",
  name: "run_command",
  title: "Run ls",
  kind: "execute",
  status: "pending",
  rawInput: { CommandLine: "ls" },
};

export const APPROVAL_PARAMS = {
  sessionId: SESSION,
  toolCall: { sessionUpdate: "tool_call", ...TOOL_CALL },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
};

export const ELICITATION_PARAMS = {
  sessionId: SESSION,
  toolCallId: "call_2",
  mode: "form",
  message: "The agent has a question.",
  requestedSchema: {
    type: "object",
    properties: {
      q1: {
        type: "string",
        title: "Which colour?",
        oneOf: [
          { const: "1", title: "Red" },
          { const: "2", title: "Green" },
        ],
      },
      q1_other: { type: "string", title: "Something else" },
    },
  },
};

export const MESSAGE_CHUNK = {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "Hello" },
};

export const TEXT = [{ type: "text", text: "Hello" }] as const;

export const buildRequest = (
  id: string | number,
  method: string,
  params: unknown,
): JsonRpcMessage => ({ jsonrpc: "2.0", id, method, params });
export const buildNotification = (method: string, params: unknown): JsonRpcMessage => ({
  jsonrpc: "2.0",
  method,
  params,
});
export const buildSessionUpdate = (update: unknown): JsonRpcMessage =>
  buildNotification("session/update", { sessionId: SESSION, update });
export const buildResult = (id: string | number, result: unknown): JsonRpcMessage => ({
  jsonrpc: "2.0",
  id,
  result,
});
export const buildFailure = (
  id: string | number,
  code: number,
  message: string,
): JsonRpcMessage => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** Returns whether `message` is a request or notification of `method`. */
export const isMethod =
  (method: string) =>
  (message: JsonRpcMessage): boolean =>
    message.method === method;

/** Returns whether `message` is the reply to the request `id`. */
export const isReplyTo =
  (id: string | number) =>
  (message: JsonRpcMessage): boolean =>
    message.method === undefined && message.id === id;

/**
 * The answers to the calls no test is about: real ones from a recording for
 * `initialize` and `session/new`, and empty ones for the rest.
 */
const DEFAULT_SCRIPTS: Readonly<Record<string, HarnessScript>> = {
  initialize: answerWith(findRecordedResult("initialize")),
  authenticate: answerWith({}),
  "session/new": answerWith(findRecordedResult("session/new")),
  "session/resume": answerWith({}),
  "session/close": answerWith({}),
  "session/set_mode": answerWith({}),
  "session/set_config_option": answerWith({ configOptions: [] }),
  "session/prompt": answerWith(PROMPT_RESULT),
};

export const ALLOW: ApprovalOutcome = { outcome: "selected", optionId: "allow" };

/** What the recorder answers to the harness, where a test wants something other than allow and accept. */
export interface Answers {
  readonly approval?: (request: ApprovalRequest) => Effect.Effect<ApprovalOutcome>;
  readonly elicitation?: (request: ElicitationRequest) => Effect.Effect<ElicitationReply>;
  readonly onUnhandledMessage?: (message: UnhandledMessage) => void;
  readonly onSessionUpdate?: (notification: SessionUpdateNotification) => void;
}

/**
 * Starts a fake harness and a recorder of the handler calls, which share one
 * change notifier. `scripts` replace the default answers of the fake by method.
 * `open` opens a connection to the fake.
 */
export const createTestHarness = (
  options: {
    readonly scripts?: Readonly<Record<string, HarnessScript>> | undefined;
    readonly answers?: Answers;
    /** Replaces the exit of the fake, for a process that exits while its output stays open. */
    readonly exited?: Promise<number>;
    /** Replaces the fake's `write`, for a pipe whose write returns a promise. `write` is the fake's own. */
    readonly writeWith?: (write: (text: string) => void) => (text: string) => void | Promise<void>;
  } = {},
) => {
  const { answers = {} } = options;
  const notifier = createChangeNotifier();
  const fake = startFakeHarness({
    scripts: { ...DEFAULT_SCRIPTS, ...options.scripts },
    onChange: notifier.notifyChange,
  });
  const updates: Array<SessionUpdateNotification> = [];
  const approvalRequests: Array<ApprovalRequest> = [];
  const elicitationRequests: Array<ElicitationRequest> = [];
  const unhandled: Array<UnhandledMessage> = [];
  return {
    fake,
    updates,
    approvalRequests,
    elicitationRequests,
    unhandled,
    waitUntil: notifier.waitUntil,
    /** Puts a line on the fake's output. */
    say: (message: JsonRpcMessage | string): void => {
      fake.sendLine(typeof message === "string" ? message : JSON.stringify(message));
    },
    /** Waits until the client has written a message that `match` accepts. */
    whenWritten: (what: string, match: (message: JsonRpcMessage) => boolean) =>
      notifier.waitUntil(what, () => fake.received.some(match)),
    /** Waits until the client stopped reading the fake's output before its end. */
    whenReadingStopped: notifier.waitUntil("the client stopped reading", fake.isReadingStopped),
    open: openAcpConnection({
      pipes: {
        write: options.writeWith?.(fake.write) ?? fake.write,
        stdout: fake.stdout,
        exited: options.exited ?? fake.exited,
      },
      clientVersion: "9.9.9",
      handlers: {
        onSessionUpdate: (notification) => {
          updates.push(notification);
          try {
            answers.onSessionUpdate?.(notification);
          } finally {
            notifier.notifyChange();
          }
        },
        onApprovalRequest: (request) => {
          approvalRequests.push(request);
          notifier.notifyChange();
          return answers.approval?.(request) ?? Effect.succeed(ALLOW);
        },
        onElicitation: (request) => {
          elicitationRequests.push(request);
          notifier.notifyChange();
          return (
            answers.elicitation?.(request) ??
            Effect.succeed({ action: "accept", content: { q1: "1" } })
          );
        },
        onUnhandledMessage: (message) => {
          unhandled.push(message);
          try {
            answers.onUnhandledMessage?.(message);
          } finally {
            notifier.notifyChange();
          }
        },
      },
    }),
  };
};

/** Makes every call once, so the whole of what the client writes can be inspected. */
export const callEverything = (connection: AcpConnection) =>
  Effect.gen(function* () {
    yield* connection.authenticate("oauth-personal");
    yield* connection.newSession({ cwd: "/work", mcpServers: [] });
    yield* connection.resumeSession({ nativeSessionId: SESSION, cwd: "/work", mcpServers: [] });
    yield* connection.setMode(SESSION, "auto");
    yield* connection.setConfigOption(SESSION, "model", "gemini");
    yield* connection.prompt(SESSION, TEXT);
    yield* connection.cancel(SESSION);
    yield* connection.closeSession(SESSION);
  });

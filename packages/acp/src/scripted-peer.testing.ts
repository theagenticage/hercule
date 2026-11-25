/**
 * What the tests of `openAcpConnection` share: a scripted peer that plays the
 * harness over an in-memory pipe pair, and a recorder of what the handlers
 * receive. The peer answers the calls the client writes and sends what a test
 * tells it to.
 */
import * as Effect from "effect/Effect";
import { openAcpConnection } from "./connection";
import { createChangeNotifier } from "./change-notifier.testing";
import { readRecording } from "./testing";
import type {
  AcpConnection,
  AcpHandlers,
  ElicitationReply,
  ElicitationRequest,
  ApprovalOutcome,
  ApprovalRequest,
  SessionUpdateNotification,
  UnhandledMessage,
} from "./types";

// ---------------------------------------------------------------------------
// Messages of the harness
// ---------------------------------------------------------------------------

export type Message = Readonly<Record<string, unknown>>;

export const SESSION = "session-1";
export const SYNC_ADVICE = "Sync packages/acp/vendor with T3 Code (packages/acp/README.md).";

/** The real reply of Antigravity to a call, from the recording `edit-shell`. */
export const findRecordedResult = (method: string): unknown => {
  const recording = readRecording("edit-shell");
  const id = recording.find(({ message }) => message.method === method)?.message.id;
  return recording.find(({ direction, message }) => direction === "in" && message.id === id)
    ?.message.result;
};
export const INITIALIZE_RESULT = findRecordedResult("initialize");
export const NEW_SESSION_RESULT = findRecordedResult("session/new");

export const PROMPT_RESULT = {
  stopReason: "end_turn",
  usage: { totalTokens: 6, inputTokens: 1, outputTokens: 2, cachedReadTokens: 3 },
};

export const TOOL_CALL = {
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

export const buildRequest = (id: string | number, method: string, params: unknown): Message => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
export const buildNotification = (method: string, params: unknown): Message => ({
  jsonrpc: "2.0",
  method,
  params,
});
export const buildSessionUpdate = (update: unknown): Message =>
  buildNotification("session/update", { sessionId: SESSION, update });
export const buildResult = (id: unknown, value: unknown): Message => ({
  jsonrpc: "2.0",
  id,
  result: value,
});
export const buildFailure = (id: unknown, code: number, message: string): Message => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/**
 * Returns `value` with a field the client has never heard of in every object,
 * except inside maps, whose keys are data and not fields: `_meta`, and
 * `properties` of a form.
 */
export const withUnknownFields = (value: unknown, parentKey?: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => withUnknownFields(item, parentKey));
  if (typeof value !== "object" || value === null || parentKey === "_meta") return value;
  const fields = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, withUnknownFields(item, key)]),
  );
  return parentKey === "properties" ? fields : { ...fields, zzNew: { a: [1] } };
};

// ---------------------------------------------------------------------------
// The scripted peer and the recorder of handler calls
// ---------------------------------------------------------------------------

export interface Call {
  readonly id: string | number;
  readonly params: unknown;
  /** Ends the harness's output after the lines the script returns. */
  readonly endOutput: () => void;
}

/** What the peer writes to the client in answer to a call: lines, as objects or as text. */
export type Script = (call: Call) => ReadonlyArray<Message | string>;

export const answerWith =
  (value: unknown): Script =>
  ({ id }) => [buildResult(id, value)];

export const DEFAULT_SCRIPTS: Readonly<Record<string, Script>> = {
  initialize: answerWith(INITIALIZE_RESULT),
  authenticate: answerWith({}),
  "session/new": answerWith(NEW_SESSION_RESULT),
  "session/resume": answerWith({}),
  "session/close": answerWith({}),
  "session/set_mode": answerWith({}),
  "session/set_config_option": answerWith({ configOptions: [] }),
  "session/prompt": answerWith(PROMPT_RESULT),
};

export interface Peer {
  readonly pipes: {
    readonly write: (text: string) => void;
    readonly stdout: AsyncIterable<string>;
  };
  /** Every line the client wrote, as text. */
  readonly lines: Array<string>;
  /** Every message the client wrote. */
  readonly written: Array<Message>;
  readonly say: (message: Message | string) => void;
  readonly endOutput: () => void;
  /** Makes the harness's output fail with `error`, the way a broken pipe does. */
  readonly failOutput: (error: unknown) => void;
  /** Makes every write fail with `error`. */
  readonly breakWrites: (error?: unknown) => void;
  /** Waits until the client has written a message that `match` accepts. */
  readonly whenWritten: (what: string, match: (message: Message) => boolean) => Effect.Effect<void>;
  /** Waits until the client stopped reading the harness's output before its end. */
  readonly whenReadingStopped: Effect.Effect<void>;
}

export const wroteMethod =
  (method: string) =>
  (message: Message): boolean =>
    message["method"] === method;

export const wroteReplyTo =
  (id: string | number) =>
  (message: Message): boolean =>
    message["method"] === undefined && message["id"] === id;

export const parseMessage = (line: string): Message => JSON.parse(line) as Message;

export const createPeer = (scripts: Readonly<Record<string, Script>> = {}): Peer => {
  const notifier = createChangeNotifier();
  const pending: Array<string> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let outputFailure: { readonly error: unknown } | undefined;
  let readingStopped = false;
  let writeFailure: { readonly error: unknown } | undefined;
  const lines: Array<string> = [];
  const written: Array<Message> = [];
  const allScripts = { ...DEFAULT_SCRIPTS, ...scripts };

  const say = (message: Message | string): void => {
    pending.push(typeof message === "string" ? message : JSON.stringify(message));
    wake?.();
  };
  const endOutput = (): void => {
    ended = true;
    wake?.();
  };

  return {
    pipes: {
      write: (text) => {
        if (writeFailure !== undefined) throw writeFailure.error;
        lines.push(text);
        const message = parseMessage(text);
        written.push(message);
        const { id, method, params } = message;
        if (typeof method === "string" && (typeof id === "string" || typeof id === "number")) {
          for (const line of allScripts[method]?.({ id, params, endOutput }) ?? []) say(line);
        }
        notifier.notifyChange();
      },
      stdout: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            for (;;) {
              if (pending.length > 0) return { done: false, value: pending.shift() as string };
              if (outputFailure !== undefined) throw outputFailure.error;
              if (ended) return { done: true, value: undefined };
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          },
          // Called when the client stops reading before the output ended.
          return: () => {
            readingStopped = true;
            notifier.notifyChange();
            return Promise.resolve({ done: true, value: undefined });
          },
        }),
      },
    },
    lines,
    written,
    say,
    endOutput,
    failOutput: (error) => {
      outputFailure = { error };
      wake?.();
    },
    breakWrites: (error = new Error("EPIPE")) => {
      writeFailure = { error };
    },
    whenWritten: (what, match) => notifier.waitUntil(what, () => written.some(match)),
    whenReadingStopped: notifier.waitUntil("the client stopped reading", () => readingStopped),
  };
};

export interface Recorder {
  readonly handlers: AcpHandlers;
  readonly updates: Array<SessionUpdateNotification>;
  readonly approvalRequests: Array<ApprovalRequest>;
  readonly elicitationRequests: Array<ElicitationRequest>;
  readonly unhandled: Array<UnhandledMessage>;
  readonly waitUntil: (what: string, ready: () => boolean) => Effect.Effect<void>;
}

export const ALLOW: ApprovalOutcome = { outcome: "selected", optionId: "allow" };

/** Collects what the handlers receive. Requests are answered with `answers`, by default allow and accept. */
export const createRecorder = (
  answers: {
    readonly approval?: (request: ApprovalRequest) => Effect.Effect<ApprovalOutcome>;
    readonly elicitation?: (request: ElicitationRequest) => Effect.Effect<ElicitationReply>;
    readonly onUnhandledMessage?: (message: UnhandledMessage) => void;
    readonly onSessionUpdate?: (notification: SessionUpdateNotification) => void;
  } = {},
): Recorder => {
  const notifier = createChangeNotifier();
  const updates: Array<SessionUpdateNotification> = [];
  const approvalRequests: Array<ApprovalRequest> = [];
  const elicitationRequests: Array<ElicitationRequest> = [];
  const unhandled: Array<UnhandledMessage> = [];
  return {
    updates,
    approvalRequests,
    elicitationRequests,
    unhandled,
    waitUntil: notifier.waitUntil,
    handlers: {
      onSessionUpdate: (notification) => {
        updates.push(notification);
        try {
          answers.onSessionUpdate?.(notification);
        } finally {
          notifier.notifyChange();
        }
      },
      onApprovalRequest: (approvalRequest) => {
        approvalRequests.push(approvalRequest);
        notifier.notifyChange();
        return answers.approval?.(approvalRequest) ?? Effect.succeed(ALLOW);
      },
      onElicitation: (elicitationRequest) => {
        elicitationRequests.push(elicitationRequest);
        notifier.notifyChange();
        return (
          answers.elicitation?.(elicitationRequest) ??
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
  };
};

export const openConnection = (peer: Peer, recorder: Recorder) =>
  openAcpConnection({ pipes: peer.pipes, clientVersion: "9.9.9", handlers: recorder.handlers });

export const TEXT = [{ type: "text", text: "Hello" }] as const;

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

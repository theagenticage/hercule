/**
 * Plays every recording of a real harness session through `openAcpConnection`.
 * The fake harness (`./testing`) sends what the harness sent, and this driver
 * does what the client did, so the test protects what the connection must do
 * with real traffic: every update arrives once, in order, with its fields
 * untouched; every prompt ends with the recorded stop reason and usage; and
 * nothing real is reported as unhandled.
 *
 * The driver reads the recording and knows no recording by name. It walks the
 * messages of the client, in order, and makes the matching call. When the
 * client answered a harness request in the recording, the driver's handlers
 * give the same answer.
 */
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { AcpError } from "./error";
import { openAcpConnection } from "./connection";
import { createChangeNotifier } from "./change-notifier.testing";
import {
  readRecording,
  RECORDING_NAMES,
  startFakeHarness,
  type JsonRpcMessage,
  type RecordedMessage,
  type RecordingName,
} from "./testing";
import type {
  AcpConnection,
  ElicitationReply,
  ElicitationRequest,
  ApprovalOutcome,
  ApprovalRequest,
  AuthenticateReply,
  NewSessionReply,
  PromptReply,
  SessionUpdateNotification,
  UnhandledMessage,
} from "./types";

const ApprovalOutcomeSchema = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("selected"), optionId: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal("cancelled") }),
]);

const ApprovalAnswerSchema = Schema.Struct({ outcome: ApprovalOutcomeSchema });

const ElicitationReplySchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("accept"),
    content: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]),
    ),
  }),
  Schema.Struct({ action: Schema.Literals(["decline", "cancel"]) }),
]);

const PromptContentSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String }),
]);

const McpServerSchema = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
});

const SessionMeta = Schema.Record(Schema.String, Schema.Json);

/** The params of each request or notification the client sent in the recordings, by method. */
const ClientParams = {
  authenticate: Schema.Struct({ methodId: Schema.String }),
  "session/new": Schema.Struct({
    cwd: Schema.String,
    mcpServers: Schema.Array(McpServerSchema),
    _meta: Schema.optionalKey(SessionMeta),
  }),
  "session/resume": Schema.Struct({
    sessionId: Schema.String,
    cwd: Schema.String,
    mcpServers: Schema.Array(McpServerSchema),
    _meta: Schema.optionalKey(SessionMeta),
  }),
  "session/close": Schema.Struct({ sessionId: Schema.String }),
  "session/prompt": Schema.Struct({
    sessionId: Schema.String,
    prompt: Schema.Array(PromptContentSchema),
  }),
  "session/cancel": Schema.Struct({ sessionId: Schema.String }),
  "session/set_mode": Schema.Struct({ sessionId: Schema.String, modeId: Schema.String }),
  "session/set_config_option": Schema.Struct({
    sessionId: Schema.String,
    configId: Schema.String,
    value: Schema.String,
  }),
} as const;

const SessionUpdateParams = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.StructWithRest(Schema.Struct({ sessionUpdate: Schema.String }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
});

const PromptResult = Schema.Struct({
  stopReason: Schema.String,
  usage: Schema.optionalKey(Schema.Unknown),
});

/** The kinds of update the connection reads. Every other kind is `other`. */
const KNOWN_UPDATE_KINDS = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "current_mode_update",
  "config_option_update",
]);

/** The parts of the recorded reply to `initialize` that the harness description is built from. */
interface RecordedInitializeResult {
  readonly agentInfo: { readonly version: string };
  readonly agentCapabilities: {
    readonly promptCapabilities: { readonly image: boolean };
    readonly mcpCapabilities: { readonly http: boolean };
    readonly _meta: unknown;
  };
}

const NewSessionResult = Schema.Struct({
  sessionId: Schema.String,
  modes: Schema.Unknown,
  models: Schema.Unknown,
  configOptions: Schema.Array(Schema.Unknown),
});

const ApprovalParams = Schema.Struct({
  sessionId: Schema.String,
  toolCall: Schema.Record(Schema.String, Schema.Unknown),
  options: Schema.Array(Schema.Unknown),
});

const ElicitationParams = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  message: Schema.String,
  requestedSchema: Schema.Unknown,
});

/** Returns `object` without the fields in `fields`. */
const omitFields = (object: Readonly<Record<string, unknown>>, fields: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(object).filter(([field]) => !fields.includes(field)));

/**
 * The fields of a tool call that the types in `./types` do not name, and that
 * the comparison with the recorded message therefore leaves out. In an
 * approval request the harness also repeats the kind of update (`tool_call`),
 * which belongs to updates.
 */
const UNNAMED_FIELDS_OF_A_TOOL_CALL = ["args"];
const UNNAMED_FIELDS_OF_A_TOOL_CALL_TO_APPROVE = ["args", "sessionUpdate"];

/** Returns the update the connection must hand on for a recorded `update`. */
const expectUpdate = (update: Readonly<Record<string, unknown>> & { sessionUpdate: string }) =>
  KNOWN_UPDATE_KINDS.has(update.sessionUpdate)
    ? omitFields(update, UNNAMED_FIELDS_OF_A_TOOL_CALL)
    : { sessionUpdate: "other", name: update.sessionUpdate };

const isHarnessCall = ({ direction, message }: RecordedMessage): boolean =>
  direction === "in" && message.method !== undefined;

const isClientCall = ({ direction, message }: RecordedMessage): boolean =>
  direction === "out" && message.method !== undefined;

// A recorder note ({"note": ...}) is an "out" entry with no method and no id. It is not a reply.
const isClientReply = ({ direction, message }: RecordedMessage): boolean =>
  direction === "out" && message.method === undefined && message.id !== undefined;

/** Replays one recording and returns what the handlers saw and what the calls returned. */
const replayRecording = (name: RecordingName) =>
  Effect.gen(function* () {
    const recording = readRecording(name);
    const fake = startFakeHarness({ recording });
    const progress = createChangeNotifier();
    const updates: Array<SessionUpdateNotification> = [];
    const approvalRequests: Array<ApprovalRequest> = [];
    const elicitationRequests: Array<ElicitationRequest> = [];
    const unhandled: Array<UnhandledMessage> = [];

    const findRecordedReply = (id: string | number): JsonRpcMessage | undefined =>
      recording.find((entry) => isClientReply(entry) && entry.message.id === id)?.message;

    const answerApproval = (request: ApprovalRequest): Effect.Effect<ApprovalOutcome> => {
      approvalRequests.push(request);
      progress.notifyChange();
      const recorded = findRecordedReply(request.requestId);
      if (recorded === undefined) return Effect.never;
      const result = Schema.decodeUnknownSync(ApprovalAnswerSchema)(recorded.result);
      return Effect.succeed(result.outcome);
    };

    const answerElicitation = (request: ElicitationRequest): Effect.Effect<ElicitationReply> => {
      elicitationRequests.push(request);
      progress.notifyChange();
      const recorded = findRecordedReply(request.requestId);
      if (recorded === undefined) return Effect.never;
      return Effect.succeed(Schema.decodeUnknownSync(ElicitationReplySchema)(recorded.result));
    };

    const scope = yield* Scope.make();
    const connection: AcpConnection = yield* openAcpConnection({
      pipes: {
        write: async (text) => {
          await fake.write(text);
          progress.notifyChange();
        },
        stdout: fake.stdout,
        exited: fake.exited,
      },
      clientVersion: "test",
      handlers: {
        onSessionUpdate: (notification) => {
          updates.push(notification);
          progress.notifyChange();
        },
        onApprovalRequest: answerApproval,
        onElicitation: answerElicitation,
        onUnhandledMessage: (message) => {
          unhandled.push(message);
          progress.notifyChange();
        },
      },
    }).pipe(Scope.provide(scope));

    const harnessCallsHandled = (): number =>
      updates.length + approvalRequests.length + elicitationRequests.length;
    const wasReceived = (id: string | number | undefined): boolean =>
      fake.received.some((message) => message.method === undefined && message.id === id);

    /** Waits until the fake has played what came before `index` and the client has answered it. */
    const waitForRecordingUpTo = (index: number) => {
      const before = recording.slice(0, index);
      const harnessCalls = before.filter(isHarnessCall).length;
      const replies = before.filter(isClientReply);
      return progress.waitUntil(
        `the ${harnessCalls} harness calls before message ${index} were handled`,
        () =>
          harnessCallsHandled() >= harnessCalls && replies.every((r) => wasReceived(r.message.id)),
      );
    };

    const prompts: Array<{
      readonly fiber: Fiber.Fiber<PromptReply, AcpError>;
      readonly recordedReply: JsonRpcMessage | undefined;
    }> = [];
    const authentications: Array<{
      readonly reply: AuthenticateReply;
      readonly recordedReply: JsonRpcMessage | undefined;
    }> = [];
    const sessions: Array<{
      readonly reply: NewSessionReply;
      readonly recordedReply: JsonRpcMessage | undefined;
    }> = [];
    const refusals: Array<{
      readonly fiber: Fiber.Fiber<unknown, AcpError>;
      readonly recordedReply: JsonRpcMessage | undefined;
    }> = [];

    for (const [index, entry] of recording.entries()) {
      if (!isClientCall(entry) || entry.message.method === "initialize") continue;
      yield* waitForRecordingUpTo(index);
      const { id, method, params } = entry.message;
      const recordedReply = recording.find(
        (other) =>
          other.direction === "in" && other.message.method === undefined && other.message.id === id,
      )?.message;
      switch (method) {
        case "authenticate": {
          const reply = yield* connection.authenticate(
            Schema.decodeUnknownSync(ClientParams.authenticate)(params).methodId,
          );
          authentications.push({ reply, recordedReply });
          break;
        }
        case "session/new": {
          const request = Schema.decodeUnknownSync(ClientParams["session/new"])(params);
          const reply = yield* connection.newSession({
            cwd: request.cwd,
            mcpServers: request.mcpServers,
            ...(request._meta === undefined ? {} : { meta: request._meta }),
          });
          sessions.push({ reply, recordedReply });
          break;
        }
        case "session/resume": {
          const request = Schema.decodeUnknownSync(ClientParams["session/resume"])(params);
          yield* connection.resumeSession({
            nativeSessionId: request.sessionId,
            cwd: request.cwd,
            mcpServers: request.mcpServers,
            ...(request._meta === undefined ? {} : { meta: request._meta }),
          });
          break;
        }
        case "session/close":
          yield* connection.closeSession(
            Schema.decodeUnknownSync(ClientParams["session/close"])(params).sessionId,
          );
          break;
        case "session/set_mode": {
          const request = Schema.decodeUnknownSync(ClientParams["session/set_mode"])(params);
          yield* connection.setMode(request.sessionId, request.modeId);
          break;
        }
        case "session/set_config_option": {
          const request = Schema.decodeUnknownSync(ClientParams["session/set_config_option"])(
            params,
          );
          const call = connection.setConfigOption(
            request.sessionId,
            request.configId,
            request.value,
          );
          if (recordedReply?.error === undefined) {
            yield* call;
          } else {
            // Forked so the request is sent now: the recording goes on after it.
            refusals.push({ fiber: yield* Effect.forkChild(call), recordedReply });
          }
          break;
        }
        case "session/prompt": {
          const request = Schema.decodeUnknownSync(ClientParams["session/prompt"])(params);
          // A prompt waits for its reply, which comes after later messages of the client.
          const fiber = yield* Effect.forkChild(
            Effect.flatten(connection.sendPrompt(request.sessionId, request.prompt)),
          );
          prompts.push({ fiber, recordedReply });
          break;
        }
        case "session/cancel":
          yield* connection.cancel(
            Schema.decodeUnknownSync(ClientParams["session/cancel"])(params).sessionId,
          );
          break;
        default:
          return yield* Effect.die(
            new Error(`The replay driver does not know how to send ${method} yet.`),
          );
      }
    }

    // Updates after the last reply of the client are still on their way.
    yield* progress.waitUntil(
      "every harness call of the recording was handled",
      () => harnessCallsHandled() >= recording.filter(isHarnessCall).length,
    );

    const replies: Array<{ readonly reply: PromptReply; readonly recordedReply: JsonRpcMessage }> =
      [];
    const unanswered: Array<Fiber.Fiber<PromptReply, AcpError>> = [];
    for (const { fiber, recordedReply } of prompts) {
      if (recordedReply === undefined) unanswered.push(fiber);
      else replies.push({ reply: yield* Fiber.join(fiber), recordedReply });
    }
    const refusalErrors: Array<{
      readonly error: AcpError;
      readonly recordedReply: JsonRpcMessage;
    }> = [];
    for (const { fiber, recordedReply } of refusals) {
      refusalErrors.push({
        error: yield* Effect.flip(Fiber.join(fiber)),
        recordedReply: recordedReply!,
      });
    }

    // A prompt the harness never answered, like the second one of a steered turn,
    // is still waiting. It ends only because the connection does.
    const stillWaiting = unanswered.map((fiber) => fiber.pollUnsafe() === undefined);
    yield* Scope.close(scope, Exit.void);
    const endings = yield* Effect.forEach(unanswered, (fiber) => Effect.flip(Fiber.join(fiber)));

    return {
      recording,
      harness: connection.harness,
      authentications,
      sessions,
      fake,
      updates,
      approvalRequests,
      elicitationRequests,
      unhandled,
      replies,
      refusalErrors,
      stillWaiting,
      endings,
    };
  });

/**
 * Recordings that the generic replay below cannot play, with the reason. Tests
 * of their own cover them.
 *
 * - `resume`, `tmpdir-resume` and `t3-resume` hold several harness processes in one file,
 *   each starting with its own `initialize`. The replay opens one connection.
 * - `subagent-approval2` ends with the recorder closing the harness while a
 *   prompt was open, so the prompt's error reply comes from the recorder, not
 *   from the harness.
 * - `stop-bg` ends with the recorder stopping the harness process while a
 *   prompt was open, so the prompt's error reply comes from the recorder.
 * - `stop-cancel` sends `session/cancel` twice, once as a request and once as a
 *   notification, to measure what the harness answers; no single script
 *   reproduces that.
 */
const RECORDINGS_THE_GENERIC_REPLAY_CANNOT_PLAY: ReadonlyArray<RecordingName> = [
  "resume",
  "stop-bg",
  "stop-cancel",
  "subagent-approval2",
  "t3-resume",
  "tmpdir-resume",
];

it.live.each(
  RECORDING_NAMES.filter((name) => !RECORDINGS_THE_GENERIC_REPLAY_CANNOT_PLAY.includes(name)),
)("plays the recording %s through the connection", (name) =>
  Effect.gen(function* () {
    const played = yield* replayRecording(name);
    const { recording } = played;

    const recordedUpdates = recording
      .filter((entry) => isHarnessCall(entry) && entry.message.method === "session/update")
      .map((entry) => Schema.decodeUnknownSync(SessionUpdateParams)(entry.message.params));
    expect(recordedUpdates.length).toBeGreaterThan(0);

    // Every update arrives once, in order, with the fields the harness sent.
    expect(played.updates.map((notification) => notification.raw)).toEqual(
      recording
        .filter((entry) => isHarnessCall(entry) && entry.message.method === "session/update")
        .map((entry) => entry.message.params),
    );
    expect(played.updates.map((notification) => notification.nativeSessionId)).toEqual(
      recordedUpdates.map((params) => params.sessionId),
    );
    // The update itself keeps every field our types name, with its value. A change
    // in the vendored client that renames or drops one (`rawInput`, `content`,
    // `title`) shows here. It may carry more: the vendored client keeps what it knows.
    expect(played.updates.map((notification) => notification.update)).toMatchObject(
      recordedUpdates.map(({ update }) => expectUpdate(update)),
    );

    // Requests of the harness arrive with their id and params untouched, and in our types.
    const recordedRequests = recording
      .filter((entry) => isHarnessCall(entry) && entry.message.method !== "session/update")
      .map((entry) => entry.message);
    expect(
      [...played.approvalRequests, ...played.elicitationRequests]
        .map(({ requestId, raw }) => ({ id: requestId, params: raw }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ).toEqual(
      recordedRequests
        .map(({ id, params }) => ({ id, params }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    );
    for (const request of played.approvalRequests) {
      const sent = Schema.decodeUnknownSync(ApprovalParams)(request.raw);
      expect(request.nativeSessionId).toBe(sent.sessionId);
      expect(request.toolCall).toMatchObject(
        omitFields(sent.toolCall, UNNAMED_FIELDS_OF_A_TOOL_CALL_TO_APPROVE),
      );
      expect(request.options).toEqual(sent.options);
    }
    for (const request of played.elicitationRequests) {
      const sent = Schema.decodeUnknownSync(ElicitationParams)(request.raw);
      expect(request.nativeSessionId).toBe(sent.sessionId);
      expect(request.toolCallId).toBe(sent.toolCallId);
      expect(request.message).toBe(sent.message);
      expect(request.requestedSchema).toMatchObject(sent.requestedSchema as object);
    }

    // Every call the client made reached the harness with the parameters of the recording.
    // The handshake is left out: it carries the identity of this client, not the recorded one.
    const sentByClient = played.fake.received.map(({ method, params }) => ({ method, params }));
    for (const entry of recording.filter(isClientCall)) {
      const { method, params } = entry.message;
      if (method === "initialize") continue;
      expect(sentByClient).toContainEqual({ method, params });
    }

    // Every answer the client gave in the recording was written to the harness unchanged.
    for (const entry of recording.filter(isClientReply)) {
      expect(played.fake.received).toContainEqual(entry.message);
    }

    // What the handshake and the setup calls returned is what the harness replied.
    const recordedInitialize = recording.find(
      ({ direction, message }) => direction === "in" && message.result !== undefined,
    )?.message.result as RecordedInitializeResult;
    expect(played.harness).toEqual({
      version: recordedInitialize.agentInfo.version,
      acceptsImages: recordedInitialize.agentCapabilities.promptCapabilities.image,
      acceptsHttpMcpServers: recordedInitialize.agentCapabilities.mcpCapabilities.http,
      meta: recordedInitialize.agentCapabilities._meta,
    });
    for (const { reply, recordedReply } of played.authentications) {
      expect(reply.meta).toEqual((recordedReply?.result as { _meta?: unknown })._meta);
    }
    for (const { reply, recordedReply } of played.sessions) {
      const recorded = Schema.decodeUnknownSync(NewSessionResult)(recordedReply?.result);
      expect(reply.nativeSessionId).toBe(recorded.sessionId);
      expect(reply.modes).toEqual(recorded.modes);
      expect(reply.models).toEqual(recorded.models);
      expect(reply.configOptions).toMatchObject(recorded.configOptions);
    }

    // Every prompt that was answered ends as it did.
    for (const { reply, recordedReply } of played.replies) {
      const recorded = Schema.decodeUnknownSync(PromptResult)(recordedReply.result);
      expect(reply.stopReason).toBe(recorded.stopReason);
      expect(reply.usage).toEqual(recorded.usage);
    }
    // A change refused by the harness fails with its code and message.
    for (const { error, recordedReply } of played.refusalErrors) {
      expect(error).toMatchObject({
        reason: "refused",
        code: recordedReply.error?.code,
      });
      expect(error.message).toContain(recordedReply.error?.message);
    }
    // A prompt with no recorded reply waited until the connection ended.
    expect(played.stillWaiting.every(Boolean)).toBe(true);
    for (const ending of played.endings) expect(ending.reason).toBe("closed");

    // The harness sent nothing this client does not understand.
    expect(played.unhandled).toEqual([]);
  }),
);

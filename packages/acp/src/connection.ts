/**
 * One connection to a harness that speaks the Agent Client Protocol (ACP) over
 * the lines of its stdio.
 *
 * The vendored ACP client (`../vendor`, copied from T3 Code) does the work:
 * JSON-RPC ids, schemas, replies and errors. This file feeds it the harness's
 * lines, gives its handlers to the caller in our own types (`./types`), and
 * turns its failures into `AcpError`. It is the only file that imports the
 * vendored client, so a change there reaches the rest of the code only
 * through here.
 *
 * A value that the vendored client's schemas do not know, or that ACP version
 * 1 does not allow, is never dropped silently: the message is reported to
 * `onUnhandledMessage` or fails the call, and names the field and the value.
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SchemaV1 from "../vendor/effect-acp/src/_generated/schema-v1.gen";
import * as VendorClient from "../vendor/effect-acp/src/client";
import * as Compat from "../vendor/effect-acp/src/compat";
import * as VendorErrors from "../vendor/effect-acp/src/errors";
import { acpRequestIdentity } from "../vendor/effect-acp/src/protocol";
import { AcpError } from "./error";
import { createHarnessStdio } from "./stdio";
import type {
  AcpConnection,
  AcpHandlers,
  AcpPipes,
  HarnessDescription,
  NewSessionRequest,
  SessionSettings,
  SessionUpdate,
} from "./types";
import { describeRefusal, describeUnreadable, type Sender } from "./unreadable";
import { createWireMemory, type CallTicket, type RefusedRequest, type WireMemory } from "./wire";

/**
 * How long a call waits for its reply, `session/prompt` excepted: a turn may
 * take as long as the agent works. A harness that never replies to a call
 * would otherwise hang its caller.
 */
const CALL_DEADLINE = Duration.seconds(30);

/**
 * The ACP version 1 schema of every message the connection reads, by ACP
 * method, and who starts that message. The vendored client's schemas are
 * unions with version 2, which accept and empty a value that version 1
 * refuses. These schemas name the field that was the problem.
 */
const METHOD_SCHEMAS: ReadonlyMap<
  string,
  { readonly sender: Sender; readonly schema: Schema.Decoder<unknown> }
> = new Map([
  ["initialize", { sender: "answered", schema: SchemaV1.InitializeResponse }],
  ["authenticate", { sender: "answered", schema: SchemaV1.AuthenticateResponse }],
  [
    "session/new",
    {
      sender: "answered",
      schema: Schema.Struct({
        ...SchemaV1.NewSessionResponse.fields,
        models: Schema.optionalKey(Schema.NullOr(Compat.SessionModelState)),
      }),
    },
  ],
  [
    "session/resume",
    {
      sender: "answered",
      schema: Schema.Struct({
        ...SchemaV1.ResumeSessionResponse.fields,
        models: Schema.optionalKey(Schema.NullOr(Compat.SessionModelState)),
      }),
    },
  ],
  ["session/close", { sender: "answered", schema: SchemaV1.CloseSessionResponse }],
  ["session/set_mode", { sender: "answered", schema: SchemaV1.SetSessionModeResponse }],
  [
    "session/set_config_option",
    { sender: "answered", schema: SchemaV1.SetSessionConfigOptionResponse },
  ],
  ["session/prompt", { sender: "answered", schema: SchemaV1.PromptResponse }],
  ["session/update", { sender: "sent", schema: SchemaV1.SessionNotification }],
  ["session/request_permission", { sender: "sent", schema: SchemaV1.RequestPermissionRequest }],
  ["elicitation/create", { sender: "sent", schema: SchemaV1.CreateElicitationRequest }],
]);

/**
 * Returns a sentence that names the field and the value of `payload` that ACP
 * version 1 does not allow in a message of `method`. Returns `undefined` when
 * `payload` is allowed, or when `sender` did not start messages of `method`
 * here: a harness may send a request named like one of our calls.
 */
const describeMethodRefusal = (
  options: {
    readonly method: string;
    readonly sender: Sender;
    readonly payload: unknown;
  },
  wire: WireMemory,
): string | undefined => {
  const entry = METHOD_SCHEMAS.get(options.method);
  return entry?.sender === options.sender
    ? describeRefusal({ ...options, schema: entry.schema, quote: wire.quoteHarnessText })
    : undefined;
};

/**
 * Returns `describeMethodRefusal`'s sentence, or, when it names no field, a
 * sentence that shows `detail`, the vendored client's own account.
 */
const describeUnreadableMessage = (
  options: {
    readonly method: string;
    readonly sender: Sender;
    readonly payload: unknown;
    readonly detail: string;
  },
  wire: WireMemory,
): string =>
  describeMethodRefusal(options, wire) ??
  describeUnreadable({ ...options, quote: wire.quoteHarnessText });

/** Describes why the vendored client ended its connection, for the `message` of an `AcpError`. */
const describeTermination = (error: VendorErrors.AcpError, wire: WireMemory): string =>
  error._tag === "AcpProtocolParseError" && error.operation === "decode-wire-message"
    ? `The harness wrote a line that is not a JSON-RPC message, or ended in the middle of one, so nothing it sends can be trusted any more. The line starts with: ${wire.quoteHarnessText(wire.getLastLineRead().line)}`
    : error._tag === "AcpInputStreamEndedError"
      ? "The harness closed its output."
      : wire.quoteHarnessText(error.message);

/** Describes a request of the harness that the vendored client answered with an error. */
const describeRefusedRequest = ({ request, error }: RefusedRequest, wire: WireMemory): string => {
  const detail =
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message).replace(/\.$/, "")
      : "no reason was given";
  return (
    describeMethodRefusal(
      { method: request.method, sender: "sent", payload: request.params },
      wire,
    ) ??
    `The harness sent the request ${wire.quoteHarnessText(request.method)}, which this version could not answer: ${wire.quoteHarnessText(detail)}.`
  );
};

/**
 * Returns a sentence when `reply` to `initialize` is an ACP version 2 reply,
 * and `undefined` otherwise. The vendored client takes a reply with an `info`
 * field for version 2, and so do we: a version 1 reply that only says its
 * protocol version is 2, as Antigravity's does, is a version 1 reply.
 */
const describeVersionTwoReply = (reply: unknown): string | undefined =>
  typeof reply === "object" && reply !== null && "info" in reply
    ? 'The harness speaks ACP version 2, which this version does not: its reply to initialize has an "info" field, which only version 2 has.'
    : undefined;

/** What the vendored client logs when it drops a notification it cannot decode. */
const readDroppedNotification = Schema.decodeUnknownOption(
  Schema.Struct({
    operation: Schema.Literal("decode-notification-payload"),
    method: Schema.String,
    issueSummary: Schema.optionalKey(Schema.String),
  }),
);

/** Returns the data of the handshake that an adapter needs, from the reply to `initialize`. */
const readHarnessDescription = (reply: Compat.InitializeResponse): HarnessDescription => {
  const capabilities = reply.agentCapabilities;
  return {
    ...(reply.agentInfo?.name === undefined ? {} : { name: reply.agentInfo.name }),
    ...(reply.agentInfo?.version === undefined ? {} : { version: reply.agentInfo.version }),
    acceptsImages: capabilities?.promptCapabilities?.image === true,
    acceptsHttpMcpServers: capabilities?.mcpCapabilities?.http === true,
    canResumeSession: capabilities?.sessionCapabilities?.resume != null,
    canCloseSession: capabilities?.sessionCapabilities?.close != null,
    ...(capabilities?._meta == null ? {} : { meta: capabilities._meta }),
  };
};

/** Returns the modes, models, config options and `_meta` of the reply to `session/new` or `session/resume`. */
const readSessionSettings = (reply: Compat.LoadSessionResponse): SessionSettings => ({
  ...(reply.modes == null ? {} : { modes: reply.modes }),
  ...(reply.models == null ? {} : { models: reply.models }),
  configOptions: reply.configOptions ?? [],
  ...(reply._meta == null ? {} : { meta: reply._meta }),
});

/**
 * Returns `update` in our types. A kind this client does not use becomes
 * `other` with the kind as its name. The vendored client wraps a kind it does
 * not know in `_t3_unknown` for a harness on ACP version 2 and passes it
 * through unwrapped for version 1, so both are read here.
 */
const readSessionUpdate = (update: Compat.SessionUpdate): SessionUpdate => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "usage_update":
    case "current_mode_update":
    case "config_option_update":
      return update;
    case "_t3_unknown":
      return { sessionUpdate: "other", name: update.originalSessionUpdate };
    default:
      return { sessionUpdate: "other", name: update.sessionUpdate };
  }
};

const TOOL_CALL_ID = Schema.Struct({ update: Schema.Struct({ toolCallId: Schema.String }) });
const MODE_ID = Schema.Struct({ update: Schema.Struct({ currentModeId: Schema.String }) });

/**
 * For the `session/update` kinds that carry an identifier, a schema that
 * requires it to be a string. The vendored client's catch-all for unknown
 * update kinds lets a tool call without a string id, and a mode change without
 * a string mode id, through.
 */
const IDENTIFIER_SCHEMAS = new Map<string, Schema.Decoder<unknown>>([
  ["tool_call", TOOL_CALL_ID],
  ["tool_call_update", TOOL_CALL_ID],
  ["current_mode_update", MODE_ID],
]);

/** Reads the tool call id in the `params` of an approval request exactly as the harness sent them. */
const readSentToolCall = Schema.decodeUnknownOption(
  Schema.Struct({ toolCall: Schema.Struct({ toolCallId: Schema.String }) }),
);

/** Checks that `request` is in the form mode, the only mode this client advertises. */
const isFormElicitation = (
  request: Compat.CreateElicitationRequest,
): request is Extract<Compat.CreateElicitationRequest, { readonly mode: "form" }> =>
  request.mode === "form";

/** Returns the MCP servers and `_meta` of a session request in the format of `session/new`. */
const buildSessionParams = (request: NewSessionRequest) => ({
  cwd: request.cwd,
  mcpServers: request.mcpServers.map(({ name, url, headers }) => ({
    type: "http" as const,
    name,
    url,
    headers,
  })),
  ...(request.meta === undefined ? {} : { _meta: request.meta }),
});

/**
 * Gives the vendored client the handlers that pass what the harness sends to
 * `handlers`, in our types. The vendored client interrupts a handler that is
 * still waiting when the connection ends, whether the harness went away or
 * the scope closed.
 */
const registerHandlers = (
  client: VendorClient.AcpClient["Service"],
  handlers: AcpHandlers,
  wire: WireMemory,
  reportUnhandled: (reason: string, payload: unknown) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* client.handleSessionUpdate((notification) =>
      Effect.suspend(() => {
        const { params, message } = wire.getLastLineRead();
        const identifierSchema = IDENTIFIER_SCHEMAS.get(notification.update.sessionUpdate);
        const refusal =
          identifierSchema === undefined
            ? undefined
            : describeRefusal({
                sender: "sent",
                method: "session/update",
                schema: identifierSchema,
                payload: params,
                quote: wire.quoteHarnessText,
              });
        if (refusal !== undefined) return reportUnhandled(refusal, message);
        handlers.onSessionUpdate({
          nativeSessionId: notification.sessionId,
          update: readSessionUpdate(notification.update),
          raw: params,
        });
        return Effect.void;
      }),
    );
    yield* client.handleRequestPermission((request, context) => {
      const open = wire.readOpenRequest(context.requestId);
      // The vendored client reads a request with a top-level `title` as version 2
      // and replaces its tool call. The user must not approve another call than
      // the one the harness asked about.
      const isSentToolCall = Option.exists(
        readSentToolCall(open.params),
        (sent) => sent.toolCall.toolCallId === request.toolCall.toolCallId,
      );
      if (!isSentToolCall) {
        return Effect.fail(
          VendorErrors.AcpRequestError.invalidParams(
            "The tool call in this request was read differently from how the harness sent it, so it was not shown for approval.",
          ),
        );
      }
      return Effect.suspend(() =>
        handlers.onApprovalRequest({
          requestId: open.id,
          nativeSessionId: request.sessionId,
          toolCall: request.toolCall,
          options: request.options,
          raw: open.params,
        }),
      ).pipe(Effect.map((outcome) => ({ outcome })));
    });
    yield* client.handleElicitation((request, context) => {
      const open = wire.readOpenRequest(context.requestId);
      if (!isFormElicitation(request)) {
        return Effect.fail(
          VendorErrors.AcpRequestError.invalidParams(
            `This client only answers elicitations in the form mode, not ${request.mode}.`,
          ),
        );
      }
      return Effect.suspend(() =>
        handlers.onElicitation({
          requestId: open.id,
          ...("sessionId" in request ? { nativeSessionId: request.sessionId } : {}),
          ...("toolCallId" in request ? { toolCallId: request.toolCallId } : {}),
          message: request.message,
          requestedSchema: request.requestedSchema,
          raw: open.params,
        }),
      );
    });
    yield* client.handleUnknownExtNotification((method) =>
      reportUnhandled(
        `The harness sent the notification ${wire.quoteHarnessText(method)}, which this version does not use.`,
        wire.getLastLineRead().message,
      ),
    );
  });

/**
 * Returns the function that runs the calls of the vendored client. It returns
 * what the call returns, or an `AcpError`:
 *
 * - `refused` when the harness answered with an error.
 * - `unreadable` when the reply holds a value that ACP version 1 does not
 *   allow, whether the vendored client refused it or let it through.
 * - `timed-out` after `CALL_DEADLINE`, unless the call has no deadline.
 * - `closed` for anything else, and for a call made after the connection ended.
 *   A call that fails as `closed` ends the connection too, so `awaitClosed`
 *   never disagrees with a call.
 *
 * The vendored client fails its own pending calls, in order, when its input
 * ends, so a reply that arrived before the end still reaches its call.
 */
const createCallRunner = (
  wire: WireMemory,
  closed: Deferred.Deferred<AcpError>,
  end: (message: string) => void,
) => {
  /**
   * Fails with `closed`. Ends the connection with `reason` unless it has ended
   * already, and then words the failure with the first reason. It never waits.
   */
  const failClosed = (method: string, reason: string): Effect.Effect<never, AcpError> =>
    Effect.suspend(() => {
      end(reason);
      return Deferred.await(closed).pipe(
        Effect.flatMap((ended) =>
          Effect.fail(
            new AcpError({
              reason: "closed",
              message: `The call to ${method} failed. ${ended.message}`,
              method,
            }),
          ),
        ),
      );
    });

  return <A>(
    method: string,
    exchange: Effect.Effect<A, VendorErrors.AcpError>,
    options: {
      readonly withoutDeadline?: true;
      /** Returns a reason to fail the call although it succeeded, or `undefined`. Gets the raw reply. */
      readonly refuseReply?: (reply: unknown) => string | undefined;
    } = {},
  ): Effect.Effect<A, AcpError> =>
    Effect.suspend(() => {
      if (Deferred.isDoneUnsafe(closed)) {
        return failClosed(method, "The connection to the harness is over.");
      }
      const run = (ticket: CallTicket) =>
        exchange.pipe(
          // The vendored client fails a call whose reply it cannot decode with a defect.
          Effect.catchDefect((defect) =>
            defect instanceof Schema.SchemaError
              ? Effect.fail(
                  new AcpError({
                    reason: "unreadable",
                    message: describeUnreadableMessage(
                      { method, sender: "answered", payload: ticket.reply, detail: defect.message },
                      wire,
                    ),
                    method,
                  }),
                )
              : Effect.die(defect),
          ),
          Effect.catch((error) =>
            error instanceof AcpError
              ? Effect.fail(error)
              : error._tag === "AcpRequestError"
                ? Effect.fail(
                    new AcpError({
                      reason: "refused",
                      message: `The harness refused ${method}: ${wire.quoteHarnessText(error.errorMessage)} (code ${error.code}).`,
                      method,
                      code: error.code,
                      harnessMessage: wire.hideSecrets(error.errorMessage),
                    }),
                  )
                : failClosed(method, describeTermination(error, wire)),
          ),
          // The vendored client interrupts its pending calls from inside when
          // the scope closes. That is the connection ending, not this call
          // being cancelled: a cancelled call never gets here.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? failClosed(method, "The call was dropped when the connection ended.")
              : Effect.failCause(cause),
          ),
          options.withoutDeadline === true
            ? (effect) => effect
            : Effect.timeoutOrElse({
                duration: CALL_DEADLINE,
                orElse: () =>
                  Effect.fail(
                    new AcpError({
                      reason: "timed-out",
                      message: `The harness did not answer ${method} within ${Duration.toSeconds(CALL_DEADLINE)} seconds. It is not known whether it did what was asked.`,
                      method,
                    }),
                  ),
              }),
          // The vendored client's reply schemas let through what ACP version 1 refuses.
          Effect.flatMap((value) => {
            const reason =
              options.refuseReply?.(ticket.reply) ??
              describeMethodRefusal({ method, sender: "answered", payload: ticket.reply }, wire);
            return reason === undefined
              ? Effect.succeed(value)
              : Effect.fail(new AcpError({ reason: "unreadable", message: reason, method }));
          }),
        );
      return Effect.acquireUseRelease(
        Effect.sync(() => wire.takeTicket(method)),
        run,
        (ticket) => Effect.sync(() => wire.dropTicket(ticket)),
      );
    });
};

/**
 * Opens a connection to the harness behind `options.pipes` and performs the
 * `initialize` handshake. Fails with an `AcpError` when the handshake fails;
 * the connection is over then, and the caller closes the scope.
 *
 * The connection lives as long as the scope. It does not own the process: the
 * caller closes the scope when the process has exited, because a descendant of
 * the process may keep the pipe open.
 */
export const openAcpConnection = (options: {
  readonly pipes: AcpPipes;
  readonly clientVersion: string;
  readonly handlers: AcpHandlers;
}): Effect.Effect<AcpConnection, AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const { pipes, handlers } = options;
    const wire = createWireMemory(acpRequestIdentity);

    // Completed once, with the first reason the connection ended. Once it is
    // complete, the harness's output is no longer read.
    const closed = Deferred.makeUnsafe<AcpError>();
    const end = (message: string): void => {
      Deferred.doneUnsafe(closed, Effect.succeed(new AcpError({ reason: "closed", message })));
    };

    /**
     * Calls `onUnhandledMessage`. A throw is logged, so that one bad handler
     * cannot stop the reader or the writer.
     */
    const reportUnhandled = (reason: string, payload: unknown): Effect.Effect<void> =>
      Effect.try({
        try: () => handlers.onUnhandledMessage({ reason, payload }),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => Effect.logError("The handler onUnhandledMessage threw", error)),
      );

    const client = yield* VendorClient.make(
      createHarnessStdio({
        pipes,
        wire,
        connectionEnded: Deferred.await(closed),
        end,
        report: reportUnhandled,
        onRefusedRequest: (refused) =>
          reportUnhandled(describeRefusedRequest(refused, wire), refused.request.message),
      }),
      {
        // The client logs a notification it drops, and nothing else tells us.
        logIncoming: true,
        logger: (event) => {
          const dropped =
            event.stage === "decode_failed"
              ? readDroppedNotification(event.payload)
              : Option.none();
          if (Option.isNone(dropped)) return Effect.void;
          const { params, message } = wire.getLastLineRead();
          const reason = describeUnreadableMessage(
            {
              method: dropped.value.method,
              sender: "sent",
              payload: params,
              detail: dropped.value.issueSummary ?? "no details",
            },
            wire,
          );
          return reportUnhandled(reason, message);
        },
        onTermination: (error) => Effect.sync(() => end(describeTermination(error, wire))),
      },
    );
    // Registered after the vendored client, so that it runs before the client's
    // own finalizers when the scope closes. A pending call then finds the
    // connection over when the client interrupts it, even while the client
    // waits for a handler that does not stop.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => end("The connection to the harness was closed.")),
    );
    // The vendored client keeps up to 32 unread notifications of its own. Nobody
    // reads them here, so drain them.
    yield* Stream.runDrain(client.raw.notifications).pipe(Effect.forkScoped);
    yield* registerHandlers(client, handlers, wire, reportUnhandled);

    const call = createCallRunner(wire, closed, end);
    const harness = yield* call(
      "initialize",
      client.agent.initialize({
        // The vendored client ignores this value and always offers version 2
        // beside the version 1 fields. The type requires the field.
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {} },
        },
        clientInfo: { name: "hercule", title: "Hercule", version: options.clientVersion },
      }),
      { refuseReply: describeVersionTwoReply },
    ).pipe(
      // A connection whose handshake failed is of no use: end it, so that
      // nothing more reaches a handler while the caller closes the scope.
      Effect.tapError((error) =>
        Effect.sync(() => end(`The handshake with the harness failed. ${error.message}`)),
      ),
      Effect.map(readHarnessDescription),
    );

    return {
      harness,
      authenticate: (methodId) =>
        call("authenticate", client.agent.authenticate({ methodId })).pipe(
          Effect.map((reply) => (reply._meta == null ? {} : { meta: reply._meta })),
        ),
      newSession: (request) =>
        call("session/new", client.agent.createSession(buildSessionParams(request))).pipe(
          Effect.map((reply) => ({
            nativeSessionId: reply.sessionId,
            ...readSessionSettings(reply),
          })),
        ),
      resumeSession: (request) =>
        call(
          "session/resume",
          client.agent.resumeSession({
            sessionId: request.nativeSessionId,
            ...buildSessionParams(request),
          }),
        ).pipe(Effect.map(readSessionSettings)),
      closeSession: (nativeSessionId) =>
        call("session/close", client.agent.closeSession({ sessionId: nativeSessionId })).pipe(
          Effect.asVoid,
        ),
      prompt: (nativeSessionId, content) =>
        call(
          "session/prompt",
          client.agent.prompt({ sessionId: nativeSessionId, prompt: content }),
          { withoutDeadline: true },
        ).pipe(
          Effect.map((reply) => ({
            stopReason: reply.stopReason,
            ...(reply.usage == null ? {} : { usage: reply.usage }),
          })),
        ),
      cancel: (nativeSessionId) =>
        call("session/cancel", client.agent.cancel({ sessionId: nativeSessionId })),
      setMode: (nativeSessionId, modeId) =>
        call(
          "session/set_mode",
          client.agent.setSessionMode({ sessionId: nativeSessionId, modeId }),
        ).pipe(Effect.asVoid),
      setConfigOption: (nativeSessionId, configId, value) =>
        call(
          "session/set_config_option",
          client.agent.setSessionConfigOption({ sessionId: nativeSessionId, configId, value }),
        ).pipe(Effect.map((reply) => reply.configOptions)),
      awaitClosed: Deferred.await(closed),
    } satisfies AcpConnection;
  });

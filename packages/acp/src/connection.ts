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
 * The vendored client decodes strictly. A value it cannot read is never
 * dropped silently: it fails the call or is reported to `onUnhandledMessage`,
 * with the field that was the problem and advice to sync the copy. What the
 * client does not decode is read from its own hooks, because our stdin gives
 * it one line at a time:
 *
 * - The `logger` shows each message before it is handled, so the handler that
 *   runs next finds the untouched `params` (`raw`), and a reply that could
 *   not be decoded finds the value that could not. It also shows a dropped
 *   update and each answer to a request of the harness.
 * - `onIncomingRequest` hands over the untouched `params` of a request of the
 *   harness, which the handler reads when it starts.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as VendorClient from "../vendor/effect-acp/src/client";
import type * as Compat from "../vendor/effect-acp/src/compat";
import * as VendorErrors from "../vendor/effect-acp/src/errors";
import { acpRequestIdentity } from "../vendor/effect-acp/src/protocol";
import { AcpError } from "./error";
import type {
  AcpConnection,
  AcpHandlers,
  AcpPipes,
  HarnessDescription,
  NewSessionRequest,
  SessionSettings,
  SessionUpdate,
} from "./types";

/**
 * How long a call waits for its reply, `session/prompt` excepted: a turn may
 * take as long as the agent works. A harness that never replies to a call
 * would otherwise hang its caller.
 */
const CALL_DEADLINE = Duration.seconds(30);

/**
 * How long the connection waits for the end of `stdout` after the process has
 * exited. A descendant of the process may hold the pipe open, but a last reply
 * that is still in the pipe is read well within this time.
 */
const EXIT_GRACE = Duration.millis(250);

const SYNC_ADVICE = "Sync packages/acp/vendor with T3 Code (packages/acp/README.md).";

/**
 * The longest harness text that `quoteHarnessText` leaves whole. A config
 * option that could not be decoded is about 400 characters with its choices
 * cut short, and the field that tells it apart from the others comes late.
 */
const QUOTE_LENGTH = 500;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The reply to the call that is being made. The vendored client logs each
 * request in the fiber of its caller, so the logger finds this object there
 * and files it under the request's id. The reply fills it in when it arrives.
 */
const CurrentCall = Context.Reference<{ reply: unknown } | undefined>("acp/CurrentCall", {
  defaultValue: () => undefined,
});

/**
 * A message that the vendored client logs, in the part this file reads: a
 * request or notification has a `payload` (its `params`), a request of ours
 * has an `id`, and an answer (`Exit`) has the `requestId` it belongs to.
 */
const LoggedMessage = Schema.Struct({
  _tag: Schema.String,
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  requestId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  payload: Schema.optionalKey(Schema.Unknown),
  exit: Schema.optionalKey(
    Schema.Struct({
      _tag: Schema.String,
      value: Schema.optionalKey(Schema.Unknown),
      cause: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            _tag: Schema.String,
            error: Schema.optionalKey(
              Schema.Struct({
                code: Schema.optionalKey(Schema.Number),
                message: Schema.optionalKey(Schema.String),
              }),
            ),
            defect: Schema.optionalKey(Schema.Unknown),
          }),
        ),
      ),
    }),
  ),
});
type LoggedMessage = typeof LoggedMessage.Type;

const readIncomingMessages = Schema.decodeUnknownOption(Schema.Array(LoggedMessage));
const readOutgoingMessage = Schema.decodeUnknownOption(LoggedMessage);

/** What the vendored client logs when it drops a notification it cannot decode. */
const readDroppedNotification = Schema.decodeUnknownOption(
  Schema.Struct({
    operation: Schema.Literal("decode-notification-payload"),
    method: Schema.String,
    issueSummary: Schema.optionalKey(Schema.String),
  }),
);

/** The error code of "method not found" in JSON-RPC. */
const METHOD_NOT_FOUND = -32601;

/** Returns the data of the handshake that an adapter needs, from the reply to `initialize`. */
const readHarnessDescription = (reply: Compat.InitializeResponse): HarnessDescription => {
  const capabilities = reply.agentCapabilities;
  return {
    ...(reply.agentInfo?.version === undefined ? {} : { version: reply.agentInfo.version }),
    acceptsImages: capabilities?.promptCapabilities?.image === true,
    acceptsHttpMcpServers: capabilities?.mcpCapabilities?.http === true,
    ...(capabilities?._meta == null ? {} : { meta: capabilities._meta }),
  };
};

/** Returns the modes, models and config options of the reply to `session/new` or `session/resume`. */
const readSessionSettings = (reply: Compat.LoadSessionResponse): SessionSettings => ({
  ...(reply.modes == null ? {} : { modes: reply.modes }),
  ...(reply.models == null ? {} : { models: reply.models }),
  configOptions: reply.configOptions ?? [],
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
    case "current_mode_update":
    case "config_option_update":
      return update;
    case "_t3_unknown":
      return { sessionUpdate: "other", name: update.originalSessionUpdate };
    default:
      return { sessionUpdate: "other", name: update.sessionUpdate };
  }
};

/** Checks that `request` is in the form mode, the only mode this client advertises. */
const isFormElicitation = (
  request: Compat.CreateElicitationRequest,
): request is Extract<Compat.CreateElicitationRequest, { readonly mode: "form" }> =>
  request.mode === "form";

/** Checks that `params`, as the harness sent them, name a tool call (ACP version 1). */
const hasToolCall = (params: unknown): boolean =>
  typeof params === "object" && params !== null && "toolCall" in params;

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
 * Returns the secrets in the headers of the MCP servers of `request`: each
 * header value, and the credential after the scheme (`abc` of `Bearer abc`),
 * because a harness may echo the credential alone. Each comes with its form
 * inside JSON text (quotes and backslashes escaped) when that differs, because
 * the sentences for people quote values with `JSON.stringify`. A value comes
 * before its credential, so the whole value is replaced first.
 */
const readHeaderSecrets = (request: NewSessionRequest): ReadonlyArray<string> =>
  request.mcpServers.flatMap(({ headers }) =>
    headers.flatMap(({ value }) => {
      if (value === "") return [];
      const credential = /^\S+\s+(\S.*)$/.exec(value)?.[1];
      return [value, ...(credential === undefined ? [] : [credential])].flatMap((secret) => {
        const escaped = JSON.stringify(secret).slice(1, -1);
        return escaped === secret ? [secret] : [secret, escaped];
      });
    }),
  );

/** Writes a path as people write it: `toolCall.kind`, or `configOptions[3]`. */
const formatPath = (path: ReadonlyArray<PropertyKey>): string =>
  path
    .map((key, index) =>
      typeof key === "number" ? `[${key}]` : `${index === 0 ? "" : "."}${String(key)}`,
    )
    .join("");

/** Returns the value at `path` in `payload`, or `undefined` when the path leads nowhere. */
const readAtPath = (payload: unknown, path: ReadonlyArray<PropertyKey>): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined,
    payload,
  );

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Returns the path of each issue of a failed decoding of a reply, without the
 * first segment: the vendored client decodes the reply inside an envelope
 * whose only field is `value`.
 */
const listIssuePaths = (issue: SchemaIssue.Issue): ReadonlyArray<ReadonlyArray<PropertyKey>> =>
  formatIssues(issue).issues.map(({ path = [] }) =>
    path.slice(1).map((segment) => (typeof segment === "object" ? segment.key : segment)),
  );

/**
 * Opens a connection to the harness behind `options.pipes` and performs the
 * `initialize` handshake. Fails with an `AcpError` when the handshake fails;
 * the connection is over then, and the caller closes the scope.
 *
 * The connection lives as long as the scope. It does not own the process. It
 * ends by itself when `stdout` ends, or a short while after the process has
 * exited, and then `awaitClosed` returns. The caller closes the scope after
 * `awaitClosed`, not at the exit, so that a reply written just before the exit
 * is still read.
 */
export const openAcpConnection = (options: {
  readonly pipes: AcpPipes;
  readonly clientVersion: string;
  readonly handlers: AcpHandlers;
}): Effect.Effect<AcpConnection, AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const { pipes, handlers } = options;

    // What the log events of the vendored client told us. Each is valid for
    // the line being handled, because the client handles one line at a time.
    let lastLine = "";
    let incoming: ReadonlyArray<LoggedMessage> = [];
    // The calls of ours that wait for their reply, by the id of their request.
    const waitingCalls = new Map<string, { reply: unknown }>();
    // Requests of the harness that are not answered yet, by the id the client's handlers get.
    const openRequests = new Map<string, { readonly method: string; readonly params: unknown }>();
    const secrets = new Set<string>();

    // ---- Text for people ----

    const hideSecrets = (text: string): string =>
      [...secrets].reduce((hidden, secret) => hidden.replaceAll(secret, "[hidden]"), text);

    /**
     * Returns `text` of the harness as it may appear in a sentence for a
     * person: the secrets hidden first, so that a cut never leaves half of one,
     * then cut to `QUOTE_LENGTH` characters with `...` when something was cut.
     */
    const quoteHarnessText = (text: string): string => {
      const hidden = hideSecrets(text);
      return hidden.length > QUOTE_LENGTH ? `${hidden.slice(0, QUOTE_LENGTH)}...` : hidden;
    };

    /** Returns a sentence that says what `sender` did with `method`, with `detail` as the reason this version could not read it. */
    const describeUnreadable = (
      sender: "sent" | "answered",
      method: string,
      detail: string,
    ): string =>
      `The harness ${sender} ${quoteHarnessText(method)} with a value this version cannot read: ${quoteHarnessText(detail)}. ${SYNC_ADVICE}`;

    const describeUnused = (kind: "notification" | "request", method: string): string =>
      `The harness sent the ${kind} ${quoteHarnessText(method)}, which this version does not use.`;

    /**
     * Returns `path in reply is <value>`, or `is missing`. For an object that
     * has a `type`, it names the type first, because the cut may come before it.
     */
    const describeField = (reply: unknown, path: ReadonlyArray<PropertyKey>): string => {
      const value = readAtPath(reply, path);
      const field = path.length === 0 ? "the reply" : formatPath(path);
      if (value === undefined) return `${field} is missing`;
      const type = readAtPath(value, ["type"]);
      return `${field}${typeof type === "string" ? ` (type ${JSON.stringify(type)})` : ""} is ${JSON.stringify(value)}`;
    };

    /**
     * Returns a sentence that names the field of `reply`, the reply to the
     * call, that the vendored client could not decode, and its value. When the issues
     * name more than one field, it takes the first one the reply has a value
     * for: the client also lists what ACP version 2 would have needed.
     */
    const describeUnreadableReply = (
      method: string,
      issue: SchemaIssue.Issue,
      reply: unknown,
    ): string => {
      const paths = listIssuePaths(issue);
      const path = paths.find((each) => readAtPath(reply, each) !== undefined) ?? paths[0] ?? [];
      return describeUnreadable("answered", method, describeField(reply, path));
    };

    /** Returns the `refused` error for a harness that answered `method` with an error of `code` and `text`. */
    const buildRefusal = (method: string, code: number, text: string): AcpError =>
      new AcpError({
        reason: "refused",
        message: `The harness refused ${method}: ${quoteHarnessText(text)} (code ${code}).`,
        code,
        harnessMessage: hideSecrets(text),
      });

    /** Describes why the vendored client ended its connection, for the `message` of an `AcpError`. */
    const describeTermination = (error: VendorErrors.AcpError): string =>
      error._tag === "AcpProtocolParseError" && error.operation === "decode-wire-message"
        ? `The harness wrote a line that is not a JSON-RPC message, or ended in the middle of one, so nothing it sends can be trusted any more. The line starts with: ${quoteHarnessText(lastLine)}`
        : error._tag === "AcpInputStreamEndedError"
          ? "The harness closed its output."
          : quoteHarnessText(error.message);

    // ---- The end of the connection ----

    // The requests of the harness whose reply is not written yet, by request id.
    const replies = new Map<string, Deferred.Deferred<void, AcpError>>();
    // Completed once, with the first reason the connection ended. Once it is
    // complete, the harness's output is no longer read.
    const closed = Deferred.makeUnsafe<AcpError>();
    const endConnection = (message: string): void => {
      // A reply that is not written yet never will be. Each entry leaves the map as it
      // settles. This runs before `closed` completes: completing it runs other
      // code at once, which may end the connection again with another reason.
      for (const [key, written] of [...replies]) {
        replies.delete(key);
        Deferred.doneUnsafe(
          written,
          Effect.fail(
            new AcpError({
              reason: "closed",
              message: `The connection to the harness ended before the reply to its request was written: ${message}`,
            }),
          ),
        );
      }
      Deferred.doneUnsafe(closed, Effect.succeed(new AcpError({ reason: "closed", message })));
    };

    /**
     * Opens the record of one request of the harness whose reply is not written
     * yet, and returns the effect that reports when it is. The entry is removed
     * when the vendored client reports the write or its failure, or when the
     * connection ends.
     */
    const openReply = (requestId: string): Effect.Effect<void, AcpError> => {
      const written = Deferred.makeUnsafe<void, AcpError>();
      if (Deferred.isDoneUnsafe(closed)) {
        Deferred.doneUnsafe(
          written,
          Effect.fail(
            new AcpError({
              reason: "closed",
              message:
                "The connection to the harness had ended when its request arrived, so the reply was not written.",
            }),
          ),
        );
      } else {
        replies.set(requestId, written);
      }
      return Deferred.await(written);
    };

    /** Ends the connection because a pipe failed, and returns the error the vendored client sees. */
    const failPipe = (method: "read" | "write", why: string, cause: unknown) => {
      // The exception of a pipe may hold text of the harness.
      const description = quoteHarnessText(String(cause));
      endConnection(`${why}: ${description}`);
      return PlatformError.systemError({
        _tag: "Unknown",
        module: "AcpConnection",
        method,
        description,
      });
    };

    /**
     * Calls `onUnhandledMessage`. A throw is logged, so that one bad handler
     * cannot stop the reader or the writer of the vendored client.
     */
    const reportUnhandled = (method: string, reason: string, raw: unknown): Effect.Effect<void> =>
      Effect.try({
        try: () => handlers.onUnhandledMessage({ method, reason, raw }),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => Effect.logError("The handler onUnhandledMessage threw", error)),
      );

    // ---- What the vendored client logs ----

    /** Returns the `params` of the message being handled, or `undefined` when its line held several. */
    const readCurrentParams = (): unknown =>
      incoming.length === 1 ? incoming[0]?.payload : undefined;

    /** Reports a notification the vendored client dropped because it could not decode it. */
    const reportDroppedNotification = (diagnostics: unknown): Effect.Effect<void> => {
      const dropped = readDroppedNotification(diagnostics);
      return Option.isNone(dropped)
        ? Effect.void
        : reportUnhandled(
            dropped.value.method,
            describeUnreadable(
              "sent",
              dropped.value.method,
              dropped.value.issueSummary ?? "no details",
            ),
            readCurrentParams(),
          );
    };

    /** Forgets the request of the harness that `message` answers, and reports it when it was answered with an error. */
    const reportAnswerWithError = (message: LoggedMessage): Effect.Effect<void> => {
      if (message._tag !== "Exit" || message.requestId === undefined) return Effect.void;
      const key = acpRequestIdentity(message.requestId);
      const request = openRequests.get(key);
      openRequests.delete(key);
      if (request === undefined || message.exit?._tag !== "Failure") return Effect.void;
      const failure = message.exit.cause?.[0];
      // The vendored client answers a request whose id is still open as
      // interrupted. That request was reported when it arrived.
      if (failure?._tag === "Interrupt") return Effect.void;
      const defect = failure?.defect;
      const text =
        failure?.error?.message ?? (typeof defect === "string" ? defect : "no reason was given");
      return reportUnhandled(
        request.method,
        failure?.error?.code === METHOD_NOT_FOUND
          ? describeUnused("request", request.method)
          : describeUnreadable("sent", request.method, text),
        request.params,
      );
    };

    // ---- The pipes, as the vendored client reads them ----

    const stdio = Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromAsyncIterable(pipes.stdout, (cause) =>
        failPipe("read", "The harness's output failed", cause),
      ).pipe(
        Stream.map((line) => encoder.encode(`${line}\n`)),
        // Nothing the harness sends after the end may reach a handler.
        Stream.interruptWhen(Deferred.await(closed)),
      ),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.try({
            try: () => pipes.write(typeof chunk === "string" ? chunk : decoder.decode(chunk)),
            catch: (cause) => failPipe("write", "Could not write to the harness", cause),
          }).pipe(
            // The vendored client reports a reply as written only after this
            // effect succeeds, so a write that fails here is never reported as done.
            Effect.flatMap((pending) =>
              pending instanceof Promise
                ? Effect.tryPromise({
                    try: () => pending,
                    catch: (cause) => failPipe("write", "Could not write to the harness", cause),
                  })
                : Effect.void,
            ),
          ),
        ),
      stderr: () => Sink.drain,
    });

    const client = yield* VendorClient.make(stdio, {
      logIncoming: true,
      logOutgoing: true,
      logger: (event) => {
        if (event.direction === "incoming") {
          if (event.stage === "raw") {
            lastLine = String(event.payload).trimEnd();
          } else if (event.stage === "decoded") {
            const messages = readIncomingMessages(event.payload);
            incoming = Option.getOrElse(messages, () => []);
            for (const { requestId, exit } of incoming) {
              if (requestId === undefined || exit === undefined) continue;
              const key = acpRequestIdentity(requestId);
              const call = waitingCalls.get(key);
              if (call !== undefined && exit._tag === "Success") call.reply = exit.value;
              waitingCalls.delete(key);
            }
          } else {
            return reportDroppedNotification(event.payload);
          }
          return Effect.void;
        }
        const outgoing =
          event.stage === "decoded" ? readOutgoingMessage(event.payload) : Option.none();
        if (Option.isNone(outgoing)) return Effect.void;
        const { _tag, id } = outgoing.value;
        // A notification of ours (`session/cancel`) has an empty id and no reply.
        if (_tag !== "Request" || id === undefined || id === "") {
          return reportAnswerWithError(outgoing.value);
        }
        return Effect.gen(function* () {
          const call = yield* CurrentCall;
          if (call !== undefined) waitingCalls.set(acpRequestIdentity(id), call);
        });
      },
      onIncomingRequest: (requestId, method, params) => {
        if (openRequests.has(requestId)) {
          return reportUnhandled(
            method,
            "The harness sent a request with the id of a request that was still open, so the vendored client did not hand it to a handler and answered the harness with an error.",
            params,
          );
        }
        return Effect.sync(() => {
          openRequests.set(requestId, { method, params });
        });
      },
      onOutgoingResponse: (requestId) =>
        Effect.sync(() => {
          const written = replies.get(requestId);
          replies.delete(requestId);
          if (written !== undefined) Deferred.doneUnsafe(written, Effect.void);
        }),
      onOutgoingResponseFailure: (requestId, error) =>
        Effect.sync(() => {
          const written = replies.get(requestId);
          replies.delete(requestId);
          if (written === undefined) return;
          Deferred.doneUnsafe(
            written,
            Effect.fail(
              new AcpError({
                reason: "closed",
                message: `Writing the reply to the harness's request failed: ${quoteHarnessText(error.message)}`,
              }),
            ),
          );
        }),
      onTermination: (error) => Effect.sync(() => endConnection(describeTermination(error))),
    });
    // Registered after the vendored client, so that it runs before the client's
    // own finalizers when the scope closes. A pending call then finds the
    // connection over when the client interrupts it, even while the client
    // waits for a handler that does not stop.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => endConnection("The connection to the harness was closed.")),
    );
    // Does nothing when the output ended first: the first reason to end wins.
    yield* Effect.promise(() => pipes.exited).pipe(
      Effect.tap(() => Effect.sleep(EXIT_GRACE)),
      Effect.flatMap((code) =>
        Effect.sync(() =>
          endConnection(`The harness exited with code ${code}, and its output did not end.`),
        ),
      ),
      Effect.forkScoped,
    );
    // The vendored client keeps up to 32 unread notifications of its own. Nobody
    // reads them here, so drain them.
    yield* Stream.runDrain(client.raw.notifications).pipe(Effect.forkScoped);

    // ---- What the harness sends ----

    yield* client.handleSessionUpdate((notification) =>
      Effect.sync(() =>
        handlers.onSessionUpdate({
          nativeSessionId: notification.sessionId,
          update: readSessionUpdate(notification.update),
          raw: readCurrentParams(),
        }),
      ),
    );
    yield* client.handleRequestPermission((request, context) => {
      const sent = openRequests.get(context.requestId)?.params;
      // Version 1 has no `title`, and the vendored client strips it. It sets
      // `title` only when it read the request as version 2, and then it builds
      // the tool call itself. When the harness sent a tool call, the user must
      // not approve a different one.
      if ("title" in request && hasToolCall(sent)) {
        return Effect.fail(
          VendorErrors.AcpRequestError.invalidParams(
            "The tool call in this request was read differently from how the harness sent it, so it was not shown for approval.",
          ),
        );
      }
      return Effect.suspend(() =>
        handlers.onApprovalRequest({
          requestId: context.requestId,
          nativeSessionId: request.sessionId,
          toolCall: request.toolCall,
          options: request.options,
          raw: sent,
          replyWritten: openReply(context.requestId),
        }),
      ).pipe(Effect.map((outcome) => ({ outcome })));
    });
    yield* client.handleElicitation((request, context) => {
      if (!isFormElicitation(request)) {
        return Effect.fail(
          VendorErrors.AcpRequestError.invalidParams(
            `This client only answers elicitations in the form mode, not ${request.mode}.`,
          ),
        );
      }
      return Effect.suspend(() =>
        handlers.onElicitation({
          requestId: context.requestId,
          ...("sessionId" in request ? { nativeSessionId: request.sessionId } : {}),
          ...("toolCallId" in request ? { toolCallId: request.toolCallId } : {}),
          message: request.message,
          requestedSchema: request.requestedSchema,
          raw: openRequests.get(context.requestId)?.params,
          replyWritten: openReply(context.requestId),
        }),
      );
    });
    yield* client.handleUnknownExtNotification((method, params) =>
      reportUnhandled(method, describeUnused("notification", method), params),
    );
    // This client advertises only the form mode, which never sends it. Without a
    // handler the vendored client keeps every one it receives, without bound.
    yield* client.handleElicitationComplete(() =>
      reportUnhandled(
        "elicitation/complete",
        describeUnused("notification", "elicitation/complete"),
        readCurrentParams(),
      ),
    );

    // ---- The calls ----

    /**
     * Fails with `closed`. Ends the connection with `reason` unless it has ended
     * already, and then words the failure with the first reason. It never waits.
     */
    const failClosed = (method: string, reason: string): Effect.Effect<never, AcpError> =>
      Effect.suspend(() => {
        endConnection(reason);
        return Deferred.await(closed).pipe(
          Effect.flatMap((ended) =>
            Effect.fail(
              new AcpError({
                reason: "closed",
                message: `The call to ${method} failed. ${ended.message}`,
              }),
            ),
          ),
        );
      });

    /**
     * Runs `exchange`, a call of the vendored client, and returns what it
     * returns, or an `AcpError`:
     *
     * - `refused` when the harness answered with an error.
     * - `unreadable` when the vendored client could not decode the reply.
     * - `timed-out` after `CALL_DEADLINE`, unless the call has no deadline.
     * - `closed` for anything else, and for a call made after the connection
     *   ended. A call that fails as `closed` ends the connection too, so
     *   `awaitClosed` never disagrees with a call.
     *
     * The vendored client fails its own pending calls, in order, when its input
     * ends, so a reply that arrived before the end still reaches its call.
     */
    const callHarness = <A>(
      method: string,
      exchange: Effect.Effect<A, VendorErrors.AcpError>,
      {
        withoutDeadline = false,
        checkReply = () => undefined,
      }: {
        readonly withoutDeadline?: boolean;
        /** Returns the error to fail with when the decoded reply is no good, given the reply as it was sent. */
        readonly checkReply?: (decoded: A, reply: unknown) => AcpError | undefined;
      } = {},
    ): Effect.Effect<A, AcpError> =>
      Effect.suspend(() => {
        if (Deferred.isDoneUnsafe(closed)) {
          return failClosed(method, "The connection to the harness is over.");
        }
        const call = { reply: undefined as unknown };
        return exchange.pipe(
          Effect.provideService(CurrentCall, call),
          Effect.catch((error) =>
            error._tag === "AcpRequestError"
              ? Effect.fail(buildRefusal(method, error.code, error.errorMessage))
              : failClosed(method, describeTermination(error)),
          ),
          // The vendored client fails a call whose reply it cannot decode with a defect.
          Effect.catchDefect((defect) =>
            defect instanceof Schema.SchemaError
              ? Effect.fail(
                  new AcpError({
                    reason: "unreadable",
                    message: describeUnreadableReply(method, defect.issue, call.reply),
                  }),
                )
              : Effect.die(defect),
          ),
          // The vendored client interrupts its pending calls from inside when
          // the scope closes. That is the connection ending, not this call
          // being cancelled: a cancelled call never gets here.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? failClosed(method, "The call was dropped when the connection ended.")
              : Effect.failCause(cause),
          ),
          withoutDeadline
            ? (effect) => effect
            : Effect.timeoutOrElse({
                duration: CALL_DEADLINE,
                orElse: () =>
                  Effect.fail(
                    new AcpError({
                      reason: "timed-out",
                      message: `The harness did not answer ${method} within ${Duration.toSeconds(CALL_DEADLINE)} seconds. It is not known whether it did what was asked.`,
                    }),
                  ),
              }),
          Effect.flatMap((decoded) => {
            const error = checkReply(decoded, call.reply);
            return error === undefined ? Effect.succeed(decoded) : Effect.fail(error);
          }),
          Effect.ensuring(
            Effect.sync(() => {
              for (const [key, waiting] of waitingCalls) {
                if (waiting === call) waitingCalls.delete(key);
              }
            }),
          ),
        );
      });

    /** Runs `exchange` like `callHarness`, after it has hidden the header values of `request`. */
    const callWithSecrets = <A>(
      method: string,
      request: NewSessionRequest,
      exchange: Effect.Effect<A, VendorErrors.AcpError>,
    ) =>
      Effect.sync(() => {
        for (const secret of readHeaderSecrets(request)) secrets.add(secret);
      }).pipe(Effect.andThen(callHarness(method, exchange)));

    const harness = yield* callHarness(
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
    ).pipe(
      // A connection whose handshake failed is of no use: end it, so that
      // nothing more reaches a handler while the caller closes the scope.
      Effect.tapError((error) =>
        Effect.sync(() => endConnection(`The handshake with the harness failed. ${error.message}`)),
      ),
      Effect.map(readHarnessDescription),
    );

    return {
      harness,
      authenticate: (methodId) =>
        callHarness("authenticate", client.agent.authenticate({ methodId })).pipe(
          Effect.map((reply) => (reply._meta == null ? {} : { meta: reply._meta })),
        ),
      newSession: (request) =>
        callWithSecrets(
          "session/new",
          request,
          client.agent.createSession(buildSessionParams(request)),
        ).pipe(
          Effect.map((reply) => ({
            nativeSessionId: reply.sessionId,
            ...readSessionSettings(reply),
          })),
        ),
      resumeSession: (request) =>
        callWithSecrets(
          "session/resume",
          request,
          client.agent.resumeSession({
            sessionId: request.nativeSessionId,
            ...buildSessionParams(request),
          }),
        ).pipe(Effect.map(readSessionSettings)),
      closeSession: (nativeSessionId) =>
        callHarness(
          "session/close",
          client.agent.closeSession({ sessionId: nativeSessionId }),
        ).pipe(Effect.asVoid),
      prompt: (nativeSessionId, content) =>
        callHarness(
          "session/prompt",
          client.agent.prompt({ sessionId: nativeSessionId, prompt: content }),
          {
            withoutDeadline: true,
            checkReply: (decoded, reply) => {
              if (decoded.error != null) {
                return buildRefusal("session/prompt", decoded.error.code, decoded.error.message);
              }
              // The vendored client leaves out a stop reason it does not know.
              const stopReason: string | undefined = decoded.stopReason;
              return stopReason === undefined
                ? new AcpError({
                    reason: "unreadable",
                    message: describeUnreadable(
                      "answered",
                      "session/prompt",
                      describeField(reply, ["stopReason"]),
                    ),
                  })
                : undefined;
            },
          },
        ).pipe(
          Effect.map((reply) => ({
            stopReason: reply.stopReason,
            ...(reply.usage == null ? {} : { usage: reply.usage }),
          })),
        ),
      cancel: (nativeSessionId) =>
        callHarness("session/cancel", client.agent.cancel({ sessionId: nativeSessionId })),
      setMode: (nativeSessionId, modeId) =>
        callHarness(
          "session/set_mode",
          client.agent.setSessionMode({ sessionId: nativeSessionId, modeId }),
        ).pipe(Effect.asVoid),
      setConfigOption: (nativeSessionId, configId, value) =>
        callHarness(
          "session/set_config_option",
          client.agent.setSessionConfigOption({ sessionId: nativeSessionId, configId, value }),
        ).pipe(Effect.map((reply) => reply.configOptions)),
      awaitClosed: Deferred.await(closed),
    } satisfies AcpConnection;
  });

/**
 * The messages of the Agent Client Protocol (ACP) as the rest of Hercule sees
 * them, and the interface of a connection: plain TypeScript types, with no
 * schema and no import of the vendored client.
 *
 * Each type lists only the fields an adapter reads. `connection.ts` assigns
 * the vendored client's types to these, so the compiler rejects a vendor sync
 * that removes or retypes a required field. A field that is optional here is
 * not checked that way: `connection.integration.test.ts` plays recordings of a
 * real harness and compares what arrives with what was sent.
 *
 * Three rules hold for every type here:
 *
 * - An optional field that the protocol allows to be `null` is typed
 *   `| null` as well. A caller treats an absent field and `null` alike.
 * - A field that holds one of a fixed set of words in the protocol (a tool
 *   kind, a status) is typed `string`. The harness ships often and adds words,
 *   and the vendored client lets some of them through.
 * - An optional field that is absent means "not known", never "none". The
 *   vendored client's schemas leave out a value they cannot read, in some
 *   places, so a missing `modes` or `usage` may be a value this version
 *   dropped, and not a harness that has none.
 */
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { AcpError } from "./error";

/** A piece of content in a message chunk or a tool call. `text` is set when `type` is `text`. */
export interface ContentBlock {
  readonly type: string;
  readonly text?: string | null;
}

/** One entry of a tool call's content: a content block, a diff, or a terminal. */
export interface ToolCallContent {
  readonly type: string;
  readonly content?: ContentBlock | null;
  readonly path?: string;
  readonly oldText?: string | null;
  readonly newText?: string;
}

/**
 * The fields of a tool call, whether it starts (`tool_call`), changes
 * (`tool_call_update`), or is shown in an approval request. A harness may
 * send all of them again on every update, so none but the id is required.
 */
export interface ToolCall {
  readonly toolCallId: string;
  readonly name?: string | null;
  readonly title?: string | null;
  readonly kind?: string | null;
  readonly status?: string | null;
  readonly content?: ReadonlyArray<ToolCallContent> | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

/** One value a select config option offers. */
export interface ConfigOptionChoice {
  readonly value: string;
  readonly name: string;
  readonly description?: string | null;
}

/** A named group of choices of a select config option. */
export interface ConfigOptionGroup {
  readonly name: string;
  readonly options: ReadonlyArray<ConfigOptionChoice>;
}

interface ConfigOptionBase {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly category?: string | null;
}

/**
 * A setting of a session that the harness lets the client change, such as the
 * model, the thinking level, or the mode.
 */
export type ConfigOption =
  | (ConfigOptionBase & {
      readonly type: "select";
      readonly currentValue: string;
      readonly options: ReadonlyArray<ConfigOptionChoice> | ReadonlyArray<ConfigOptionGroup>;
    })
  | (ConfigOptionBase & { readonly type: "boolean"; readonly currentValue: boolean });

/** The modes a session offers and the one it is in. */
export interface SessionModes {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description?: string | null;
  }>;
}

interface MessageChunk {
  readonly content: ContentBlock;
}

/**
 * What the harness reports about a session while it works. `other` stands for
 * every kind this client does not use, such as `usage_update` and
 * `available_commands_update`; `name` is the kind the harness sent, and `raw`
 * of the notification has the rest.
 */
export type SessionUpdate =
  | (MessageChunk & { readonly sessionUpdate: "agent_message_chunk" })
  | (MessageChunk & { readonly sessionUpdate: "agent_thought_chunk" })
  | (ToolCall & { readonly sessionUpdate: "tool_call" })
  | (ToolCall & { readonly sessionUpdate: "tool_call_update" })
  | { readonly sessionUpdate: "current_mode_update"; readonly currentModeId: string }
  | {
      readonly sessionUpdate: "config_option_update";
      readonly configOptions: ReadonlyArray<ConfigOption>;
    }
  | { readonly sessionUpdate: "other"; readonly name: string };

export interface SessionUpdateNotification {
  readonly nativeSessionId: string;
  readonly update: SessionUpdate;
  /**
   * The `params` of the notification exactly as the harness sent them, with the
   * fields this client does not know. `undefined` when the harness sent several
   * messages in one line, which ACP does not do. A request keeps its own `raw`
   * then.
   *
   * This is also true of `raw` of the requests below and of `UnhandledMessage`:
   * it is untouched, so it may hold a secret that the harness echoes. The
   * connection hides only what it was given: the header values and the
   * credential after the scheme of the MCP servers of `newSession` and
   * `resumeSession`, also as they read inside JSON text (quotes and backslashes
   * escaped), in the text of an `AcpError` and in a `reason`. It does not hide
   * them in `raw`, in the text of an update, in a token that is part of a URL,
   * or in any other encoded form of a secret (URL encoding, base64). A caller
   * decides what to do with `raw` before it shows or stores it.
   */
  readonly raw: unknown;
}

/** One answer an approval request offers. `kind` is such as `allow_once` or `reject_once`. */
export interface ApprovalOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

/**
 * The harness asks whether a tool call may run. It is the ACP method
 * `session/request_permission`; Hercule calls it an approval request.
 */
export interface ApprovalRequest {
  /** The id of the request as the connection names it. It is only good for telling requests apart. */
  readonly requestId: string;
  readonly nativeSessionId: string;
  readonly toolCall: ToolCall;
  readonly options: ReadonlyArray<ApprovalOption>;
  /** The `params` of the request exactly as the harness sent them. See `SessionUpdateNotification.raw`. */
  readonly raw: unknown;
  /**
   * Succeeds when the reply to this request was written to the harness, and
   * fails with an `AcpError` (reason `closed`) when writing it failed or the
   * connection ended before it was written. "Written" means the transport
   * handed the reply to the harness's stdin: it does not prove that the
   * harness read it. Run it after the handler returns its reply, or in a
   * fiber beside it: it waits until the connection writes the reply, and
   * never before. Each run reports the same result.
   */
  readonly replyWritten: Effect.Effect<void, AcpError>;
}

/** How an approval request is answered: with one of its options, or not at all. */
export type ApprovalOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

/** One value a form field offers. */
export interface ElicitationChoice {
  readonly const: string;
  readonly title: string;
}

/** One question of a form. A select has `oneOf` or `enum`; a multi-select has `items`. */
export interface ElicitationField {
  readonly type: string;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly enum?: ReadonlyArray<string> | null;
  readonly oneOf?: ReadonlyArray<ElicitationChoice> | null;
  /**
   * For a multi-select, the values it offers: `enum` is a list of strings, or
   * `anyOf` is a list of `ElicitationChoice`. The protocol leaves the shape
   * open, so a caller checks what it finds.
   */
  readonly items?: { readonly [key: string]: Schema.Json } | null;
}

/** The harness asks the user a question: a form of fields. Only the `form` mode is advertised. */
export interface ElicitationRequest {
  /** The id of the request as the connection names it. It is only good for telling requests apart. */
  readonly requestId: string;
  readonly nativeSessionId?: string;
  readonly toolCallId?: string | null;
  readonly message: string;
  readonly requestedSchema: {
    readonly properties?: Readonly<Record<string, ElicitationField>>;
    readonly required?: ReadonlyArray<string> | null;
  };
  /** The `params` of the request exactly as the harness sent them. See `SessionUpdateNotification.raw`. */
  readonly raw: unknown;
  /**
   * Succeeds when the reply to this request was written to the harness, and
   * fails with an `AcpError` (reason `closed`) when writing it failed or the
   * connection ended before it was written. "Written" means the transport
   * handed the reply to the harness's stdin: it does not prove that the
   * harness read it. Run it after the handler returns its reply, or in a
   * fiber beside it: it waits until the connection writes the reply, and
   * never before. Each run reports the same result.
   */
  readonly replyWritten: Effect.Effect<void, AcpError>;
}

/** An answer to one field: text, a number, a flag, or the chosen values of a multi-select. */
export type ElicitationValue = string | number | boolean | ReadonlyArray<string>;

/** How an elicitation is answered: with a value per field name, declined, or cancelled. */
export type ElicitationReply =
  | { readonly action: "accept"; readonly content: Readonly<Record<string, ElicitationValue>> }
  | { readonly action: "decline" }
  | { readonly action: "cancel" };

/** What an adapter needs to know about the harness, from the reply to `initialize`. */
export interface HarnessDescription {
  readonly version?: string;
  /** Whether a prompt may contain images. */
  readonly acceptsImages: boolean;
  /** Whether `session/new` may name MCP servers that are reached over HTTP. */
  readonly acceptsHttpMcpServers: boolean;
  /** Whether `session/new` and `session/resume` may name additional directories to add to the workspace. */
  readonly acceptsAdditionalDirectories: boolean;
  /** The `_meta` of the harness's capabilities, where harness-specific features are announced. */
  readonly meta?: unknown;
}

export interface AuthenticateReply {
  readonly meta?: unknown;
}

/** An MCP server reached over HTTP, which the harness is told to use in a session. */
export interface McpServer {
  readonly name: string;
  readonly url: string;
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export interface NewSessionRequest {
  readonly cwd: string;
  readonly mcpServers: ReadonlyArray<McpServer>;
  /**
   * Absolute paths of folders the harness adds to the workspace of this
   * session only. Sent whenever the field is present, even as an empty list:
   * leave it out when there are no folders. Check
   * `HarnessDescription.acceptsAdditionalDirectories` before naming any.
   */
  readonly additionalDirectories?: ReadonlyArray<string>;
  /** Sent as `_meta`, where a harness announces its own options, such as an appended system prompt. */
  readonly meta?: Readonly<Record<string, Schema.Json>>;
}

export interface ResumeSessionRequest extends NewSessionRequest {
  readonly nativeSessionId: string;
}

/** The models a session offers and the one it uses. Older harnesses list their models here instead of in `configOptions`. */
export interface SessionModels {
  readonly currentModelId: string;
  readonly availableModels: ReadonlyArray<{ readonly modelId: string; readonly name: string }>;
}

/** What a session has after `session/new` or `session/resume`. */
export interface SessionSettings {
  readonly modes?: SessionModes;
  readonly models?: SessionModels;
  /** Empty when the harness sends none. */
  readonly configOptions: ReadonlyArray<ConfigOption>;
}

/** What a new session has, and the id the harness gave it. */
export interface NewSessionReply extends SessionSettings {
  readonly nativeSessionId: string;
}

export type PromptContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mimeType: string; readonly data: string };

/** The tokens the harness counted for one prompt. A number it does not report is absent. */
export interface Usage {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thoughtTokens?: number | null;
  readonly cachedReadTokens?: number | null;
  readonly cachedWriteTokens?: number | null;
}

/** How a prompt ended, such as `end_turn` or `cancelled`, and what it used. */
export interface PromptReply {
  /** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` or `cancelled`. */
  readonly stopReason: string;
  readonly usage?: Usage | null;
}

/**
 * What the connection needs from the process of the harness. A `FramedChild`
 * fits as it is.
 *
 * The connection learns that the process is dead from the end of `stdout`, from
 * `exited`, or from the caller closing the scope.
 */
export interface AcpPipes {
  /**
   * Writes `text` to the harness's stdin. It is one whole line. The returned
   * promise resolves when the process has accepted the line, and rejects when
   * the write failed (for example EPIPE, or the process is gone). A rejection
   * ends the connection; the reply of an open request is then reported as not
   * written (`replyWritten`). The connection waits for the promise before it
   * reports a reply as written.
   */
  readonly write: (text: string) => Promise<void>;
  /** The harness's stdout. Each item is one whole line, without its newline. */
  readonly stdout: AsyncIterable<string>;
  /**
   * Resolves with the exit code when the process has exited. A descendant of
   * the process may keep `stdout` open after that, so when `stdout` has not
   * ended a short while after the exit, the connection ends and names the code.
   * When `stdout` ends first, nothing changes: every line is read before the end.
   */
  readonly exited: Promise<number>;
}

/**
 * What the connection calls when the harness sends something. A handler that
 * throws is logged and does not stop the connection.
 */
export interface AcpHandlers {
  /** Called for each `session/update`, in the order the harness sent them. */
  readonly onSessionUpdate: (notification: SessionUpdateNotification) => void;
  /**
   * Called when the harness asks whether a tool call may run. The harness waits
   * for the answer, and meanwhile later messages are still handled. The
   * connection answers the harness itself, and interrupts the effect when the
   * connection ends.
   *
   * The request may be handed over after updates that the harness sent right
   * after it, because it is handled apart from the updates. The tool call in
   * it is the one the harness sent: a request whose tool call was read
   * differently is answered with an error and reported instead.
   */
  readonly onApprovalRequest: (request: ApprovalRequest) => Effect.Effect<ApprovalOutcome>;
  /** Called when the harness asks the user a question. Works like `onApprovalRequest`. */
  readonly onElicitation: (request: ElicitationRequest) => Effect.Effect<ElicitationReply>;
  /**
   * Called for a message this client does not use or cannot read: a
   * notification or request of a kind it does not know, a notification it
   * could not decode, or a request it answered with an error.
   */
  readonly onUnhandledMessage: (message: UnhandledMessage) => void;
}

/**
 * A connection to one harness. Every call fails with an `AcpError`. Every call
 * but `prompt` fails with `timed-out` when the harness has not answered within
 * 30 seconds.
 */
export interface AcpConnection {
  readonly harness: HarnessDescription;
  /** Logs in with the authentication method `methodId`, a method id the caller knows. */
  readonly authenticate: (methodId: string) => Effect.Effect<AuthenticateReply, AcpError>;
  /**
   * Starts a session in `request.cwd` with the MCP servers and `_meta` of
   * `request`, and returns its id and settings. The header values of the MCP
   * servers are secrets: they are hidden in every message of an `AcpError`
   * and every `reason` of an unhandled message from then on.
   */
  readonly newSession: (request: NewSessionRequest) => Effect.Effect<NewSessionReply, AcpError>;
  /** Resumes the session `request.nativeSessionId`. Hides secrets like `newSession`. */
  readonly resumeSession: (
    request: ResumeSessionRequest,
  ) => Effect.Effect<SessionSettings, AcpError>;
  /** Tells the harness it may free the session `nativeSessionId`. */
  readonly closeSession: (nativeSessionId: string) => Effect.Effect<void, AcpError>;
  /**
   * Sends a prompt in two stages. The returned effect succeeds once the line
   * of the `session/prompt` request was written to the harness's input, and
   * its value is a second effect that waits until the turn ends, which may take
   * as long as the agent works.
   *
   * The first effect succeeds when the write succeeded, and also when the
   * harness's reply arrives before the write is acknowledged: the reply proves
   * the harness got the prompt. It fails in two ways that differ for a caller
   * that wants to send the prompt again:
   *
   * - `not-sent`: the harness certainly did not get the prompt. The write
   *   failed, or the connection had ended before the line was written. Sending
   *   it again cannot run it twice.
   * - `closed`: the connection ended while the write was in flight. It is not
   *   known whether the harness got the prompt, so sending it again may run it
   *   twice.
   *
   * No reply comes after either failure. The second effect fails when the
   * connection ends first, with `refused` when the harness reports an error for
   * the turn, and with `unreadable` when the reply has no stop reason this
   * version knows. Updates the harness sent before its reply are handled before
   * the second effect returns. Updates it sends after its reply may be handled
   * before the caller sees the reply.
   */
  readonly sendPrompt: (
    nativeSessionId: string,
    content: ReadonlyArray<PromptContent>,
  ) => Effect.Effect<Effect.Effect<PromptReply, AcpError>, AcpError>;
  /**
   * Asks the harness to stop the turn. Returns when the request is queued for
   * writing. It does not answer an approval request that is still open: the
   * caller answers it with `cancelled`.
   */
  readonly cancel: (nativeSessionId: string) => Effect.Effect<void, AcpError>;
  /** Switches the session to the mode `modeId`, one of `SessionModes.availableModes`. */
  readonly setMode: (nativeSessionId: string, modeId: string) => Effect.Effect<void, AcpError>;
  /** Changes a config option and returns every config option with its current value. */
  readonly setConfigOption: (
    nativeSessionId: string,
    configId: string,
    value: string,
  ) => Effect.Effect<ReadonlyArray<ConfigOption>, AcpError>;
  /**
   * Waits until the connection is over, and returns why. The connection ends
   * when the harness closes its output, when a write to it fails, when it
   * writes a line that is not a JSON-RPC message (or ended in the middle of
   * one), when `initialize` fails, and when the scope closes. Calls then fail,
   * nothing more reaches a handler, and parked handlers are interrupted.
   */
  readonly awaitClosed: Effect.Effect<AcpError>;
}

/** A message the connection could not give to any handler, and why. */
export interface UnhandledMessage {
  /** The ACP method of the message, such as `session/update`. */
  readonly method: string;
  /** A sentence for a person: what was wrong and what to do about it. Secrets of the session are hidden in it. */
  readonly reason: string;
  /**
   * The `params` of the message exactly as the harness sent them, or
   * `undefined` when the harness sent several messages in one line. See
   * `SessionUpdateNotification.raw` for the secrets it may hold.
   */
  readonly raw: unknown;
}

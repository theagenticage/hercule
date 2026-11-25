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
 * Two rules hold for every type here:
 *
 * - An optional field that the protocol allows to be `null` is typed
 *   `| null` as well. A caller treats an absent field and `null` alike.
 * - A field that holds one of a fixed set of words in the protocol (a tool
 *   kind, a status) is typed `string`. The harness ships often and adds words,
 *   and the vendored client lets some of them through.
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

export interface ToolCallLocation {
  readonly path: string;
  readonly line?: number | null;
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
  readonly locations?: ReadonlyArray<ToolCallLocation> | null;
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
  readonly groupId: string;
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
 * every kind this client does not use; `name` is the kind the harness sent.
 */
export type SessionUpdate =
  | (MessageChunk & { readonly sessionUpdate: "agent_message_chunk" })
  | (MessageChunk & { readonly sessionUpdate: "agent_thought_chunk" })
  | (ToolCall & { readonly sessionUpdate: "tool_call" })
  | (ToolCall & { readonly sessionUpdate: "tool_call_update" })
  | {
      readonly sessionUpdate: "usage_update";
      /** How many tokens of the context window are used. */
      readonly used: number;
      /** How many tokens the context window holds. */
      readonly size: number;
    }
  | { readonly sessionUpdate: "current_mode_update"; readonly currentModeId: string }
  | {
      readonly sessionUpdate: "config_option_update";
      readonly configOptions: ReadonlyArray<ConfigOption>;
    }
  | { readonly sessionUpdate: "other"; readonly name: string };

export interface SessionUpdateNotification {
  readonly nativeSessionId: string;
  readonly update: SessionUpdate;
  /** The `params` of the notification exactly as the harness sent them, with the fields this client does not know. */
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
  /** The JSON-RPC id of the request. */
  readonly requestId: string | number;
  readonly nativeSessionId: string;
  readonly toolCall: ToolCall;
  readonly options: ReadonlyArray<ApprovalOption>;
  /** The `params` of the request exactly as the harness sent them. */
  readonly raw: unknown;
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
  /** The JSON-RPC id of the request. */
  readonly requestId: string | number;
  readonly nativeSessionId?: string;
  readonly toolCallId?: string | null;
  readonly message: string;
  readonly requestedSchema: {
    readonly properties?: Readonly<Record<string, ElicitationField>>;
    readonly required?: ReadonlyArray<string> | null;
  };
  /** The `params` of the request exactly as the harness sent them. */
  readonly raw: unknown;
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
  readonly name?: string;
  readonly version?: string;
  /** Whether a prompt may contain images. */
  readonly acceptsImages: boolean;
  /** Whether `session/new` may name MCP servers that are reached over HTTP. */
  readonly acceptsHttpMcpServers: boolean;
  readonly canResumeSession: boolean;
  readonly canCloseSession: boolean;
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
  readonly meta?: unknown;
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
 * The connection learns that the process is dead from the end of `stdout`, or
 * from the caller closing the scope. It does not rely on `write` throwing: the
 * `write` of a `FramedChild` never does.
 */
export interface AcpPipes {
  /** Writes `text` to the harness's stdin. It is one whole line. A throw ends the connection. */
  readonly write: (text: string) => void;
  /** The harness's stdout. Each item is one whole line, without its newline. */
  readonly stdout: AsyncIterable<string>;
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
   * differently is refused and reported instead.
   */
  readonly onApprovalRequest: (request: ApprovalRequest) => Effect.Effect<ApprovalOutcome>;
  /** Called when the harness asks the user a question. Works like `onApprovalRequest`. */
  readonly onElicitation: (request: ElicitationRequest) => Effect.Effect<ElicitationReply>;
  /**
   * Called for a message this client does not use or cannot read: a
   * notification or request of a kind it does not know, or a value it cannot
   * read. A request is answered with an error as well.
   */
  readonly onUnhandledMessage: (message: UnhandledMessage) => void;
}

export interface AcpConnection {
  readonly harness: HarnessDescription;
  /** Logs in with the authentication method `methodId`, a method id the caller knows. */
  readonly authenticate: (methodId: string) => Effect.Effect<AuthenticateReply, AcpError>;
  readonly newSession: (request: NewSessionRequest) => Effect.Effect<NewSessionReply, AcpError>;
  readonly resumeSession: (
    request: ResumeSessionRequest,
  ) => Effect.Effect<SessionSettings, AcpError>;
  readonly closeSession: (nativeSessionId: string) => Effect.Effect<void, AcpError>;
  /**
   * Sends a prompt and waits until the turn ends, which may take as long as the
   * agent works. Fails when the connection ends first. Updates the harness sent
   * before its reply are handled before this returns. Updates it sends after
   * its reply may be handled before the caller sees the reply.
   */
  readonly prompt: (
    nativeSessionId: string,
    content: ReadonlyArray<PromptContent>,
  ) => Effect.Effect<PromptReply, AcpError>;
  /**
   * Asks the harness to stop the turn. Returns when the request is queued for
   * writing. It does not answer an approval request that is still open: the
   * caller answers it with `cancelled`.
   */
  readonly cancel: (nativeSessionId: string) => Effect.Effect<void, AcpError>;
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
   * writes a line that is not a JSON-RPC message (or ended in the middle of one),
   * a JSON array, or a request whose id is still open, when `initialize` fails,
   * and when the scope closes. Calls then fail, nothing more reaches a handler,
   * and parked handlers are interrupted.
   */
  readonly awaitClosed: Effect.Effect<AcpError>;
}

/** A message the connection could not give to any handler, and why. */
export interface UnhandledMessage {
  /** A sentence for a person: what was wrong and what to do about it. Secrets of the session are hidden in it. */
  readonly reason: string;
  /**
   * The parsed message, or the line itself when it was not JSON, exactly as
   * the harness sent it. It may hold secrets, such as a bearer token the
   * harness echoes, so a caller must not show or store it as it is.
   */
  readonly payload: unknown;
}

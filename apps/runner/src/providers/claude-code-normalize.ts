/**
 * Converts the Claude Agent SDK's message stream into the normalized event
 * taxonomy (spec 06 section 6). `normalize` takes one message and a small
 * mutable state, and returns events. It does not call the SDK or read the clock
 * itself.
 *
 * The state is needed because the taxonomy groups what the SDK reports as a
 * flat sequence of messages:
 *
 * - a turn spans many messages and ends at the `result` message;
 * - a text item runs from `content_block_start` to `content_block_stop`;
 * - a tool item is closed by the `tool_result` that arrives one message later.
 *
 * Nothing throws. A message this build does not recognise becomes an `unknown`
 * item that carries the raw payload (spec 06 section 6.7).
 */
import type * as Schema from "effect/Schema";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  MAX_MESSAGE_LENGTH,
  type ItemKind,
  type OutputSchema,
  type ProviderEvent,
  type StreamKind,
  type StructuredResult,
  type TurnState,
  type Usage,
} from "@hercule/protocol";
import { judgeAnswer, type HarnessAnswer } from "./structured-result";

/** The `source` name on every raw payload from this adapter. */
export const CLAUDE_SDK_MESSAGE = "claude.sdk.message";

/** An open text or reasoning block whose deltas are still arriving. */
interface Block {
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly streamKind: StreamKind;
}

/** The assistant message an agent is streaming: the main loop's or a subagent's. */
interface Streaming {
  messageId: string;
  readonly blocks: Map<number, Block>;
}

/** The state `normalize` keeps for one session between messages. */
export interface Normalizing {
  readonly sessionId: string;
  /** Creates a new id: for events, and for turns and items the SDK gives no id. */
  readonly mint: () => string;
  /** The runner's own clock, as an ISO-8601 instant. */
  readonly now: () => string;
  /** The schema every turn's output must match. `undefined` means free text. */
  readonly outputSchema: OutputSchema | undefined;
  /** The open turn, or `undefined` between turns. The adapter opens the first. */
  turnId: string | undefined;
  /**
   * The message each agent is streaming right now, keyed by
   * `parent_tool_use_id`. Subagents stream at the same time as the main loop,
   * and each numbers its content blocks on its own, so a single block map would
   * let them overwrite each other.
   */
  readonly streams: Map<string, Streaming>;
  /**
   * The ids of assistant messages whose blocks arrived as stream events. With
   * `includePartialMessages`, the complete message that follows repeats what
   * was already streamed, so only a message that never streamed still needs
   * its text reported. Messages are matched by id, not by block index, because
   * a block's position in the message is not its position in the stream.
   */
  readonly streamed: Set<string>;
  /**
   * The kind of each open tool item, by `tool_use` id, so its `tool_result`
   * completes it with the same kind.
   */
  readonly tools: Map<string, ItemKind>;
}

export const buildNormalizingState = (
  sessionId: string,
  mint: () => string,
  now: () => string,
  outputSchema: OutputSchema | undefined,
): Normalizing => ({
  sessionId,
  mint,
  now,
  outputSchema,
  turnId: undefined,
  streams: new Map(),
  streamed: new Set(),
  tools: new Map(),
});

/**
 * The item kind for each Claude tool name. Only the families that spec 06
 * section 6.3 defines are mapped; every other tool is a plain `tool_call`.
 */
const TOOL_KINDS: Readonly<Record<string, ItemKind>> = {
  Bash: "command_execution",
  BashOutput: "command_execution",
  KillShell: "command_execution",
  Shell: "command_execution",
  Edit: "file_change",
  Write: "file_change",
  NotebookEdit: "file_change",
  Patch: "file_change",
  WebSearch: "web_search",
  Task: "subagent",
  Agent: "subagent",
  ExitPlanMode: "plan",
};

/**
 * Returns the item kind for a Claude tool name, or `tool_call` for a tool with
 * no specific kind. The adapter also uses it to pick the approval request kind,
 * so one table decides both and the two cannot disagree.
 */
export const classifyTool = (name: string): ItemKind => TOOL_KINDS[name] ?? "tool_call";

/** Checks whether a tool is an MCP tool. The name prefix is the only way to tell. */
const isMcp = (name: string): boolean => name.startsWith("mcp__");

/**
 * Informational messages from Claude that are dropped on purpose (spec 06
 * section 6.7). Rate-limit and auth updates belong in the snapshot, not in
 * session events, and progress messages hold nothing a transcript reader
 * wants. A message type that is neither in this list nor handled below still
 * becomes an `unknown` item rather than disappearing.
 */
const TRIMMED: ReadonlySet<string> = new Set([
  // Top-level message types.
  "rate_limit_event",
  "auth_status",
  "tool_use_summary",
  "prompt_suggestion",
  "tool_progress",
  // `system` subtypes, with the `system:` prefix that `onSystem` looks them up with.
  "system:status",
  "system:session_state_changed",
  "system:thinking_tokens",
  "system:background_tasks_changed",
  "system:commands_changed",
  "system:hook_started",
  "system:hook_progress",
  "system:hook_response",
  "system:files_persisted",
]);

/** Truncates text to the longest message the protocol accepts. */
const cutToMessageLength = (value: string): string => value.slice(0, MAX_MESSAGE_LENGTH);

/**
 * Converts a value to JSON by serializing and parsing it, not by a cast. A
 * single `undefined` property anywhere in a vendor payload would make a frame
 * the protocol cannot encode, and that costs the runner its connection and
 * every session on it.
 */
const toJson = (value: unknown): Schema.Json =>
  JSON.parse(JSON.stringify(value ?? null)) as Schema.Json;

/**
 * Converts a count to a whole number that is never negative, as the protocol
 * requires. Anything else becomes 0.
 */
const clampCount = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

type Emit = Array<ProviderEvent>;

/**
 * Opens a turn if none is open. Returns the turn id and the events to emit:
 * one `turn.started`, or none when a turn was already open.
 *
 * Besides turns for user input, this also covers output the harness sends
 * outside any turn Hercule opened, because every item must belong to a turn
 * (spec 06 section 6.2).
 */
export const openTurn = (
  state: Normalizing,
): { readonly turnId: string; readonly events: ReadonlyArray<ProviderEvent> } => {
  const open = state.turnId;
  if (open !== undefined) return { turnId: open, events: [] };
  const turnId = state.mint();
  state.turnId = turnId;
  return {
    turnId,
    events: [
      {
        _tag: "turn.started",
        eventId: state.mint(),
        sessionId: state.sessionId,
        at: state.now(),
        turnId,
      },
    ],
  };
};

const ensureOpenTurn = (state: Normalizing, out: Emit): string => {
  const { turnId, events } = openTurn(state);
  out.push(...events);
  return turnId;
};

/**
 * Emits `turn.completed` and clears the turn's streaming state. Open tool items
 * are kept, because an interrupted turn's `tool_result` still arrives later and
 * needs the kind its item started with.
 */
const closeTurn = (
  state: Normalizing,
  out: Emit,
  turnId: string,
  turnState: TurnState,
  extra: {
    readonly usage?: Usage;
    readonly error?: string;
    readonly structuredResult?: StructuredResult;
  } = {},
): void => {
  out.push({
    _tag: "turn.completed",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    turnId,
    state: turnState,
    ...(extra.usage === undefined ? {} : { usage: extra.usage }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
    ...(extra.structuredResult === undefined ? {} : { structuredResult: extra.structuredResult }),
  });
  state.turnId = undefined;
  state.streams.clear();
  state.streamed.clear();
};

const buildItemStarted = (
  state: Normalizing,
  turnId: string,
  itemId: string,
  kind: ItemKind,
  detail?: unknown,
): ProviderEvent => {
  return {
    _tag: "item.started",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    turnId,
    itemId,
    kind,
    ...(detail === undefined ? {} : { detail: toJson(detail) }),
  };
};

const buildItemCompleted = (
  state: Normalizing,
  turnId: string,
  itemId: string,
  kind: ItemKind,
  status: "completed" | "failed",
  detail?: unknown,
): ProviderEvent => ({
  _tag: "item.completed",
  eventId: state.mint(),
  sessionId: state.sessionId,
  at: state.now(),
  turnId,
  itemId,
  kind,
  status,
  ...(detail === undefined ? {} : { detail: toJson(detail) }),
});

const buildContentDelta = (
  state: Normalizing,
  turnId: string,
  itemId: string,
  streamKind: StreamKind,
  text: string,
): ProviderEvent => ({
  _tag: "content.delta",
  eventId: state.mint(),
  sessionId: state.sessionId,
  at: state.now(),
  turnId,
  itemId,
  streamKind,
  delta: text,
});

/** Returns the events for a whole item at once, for a complete message that never streamed. */
const buildWholeItem = (
  state: Normalizing,
  turnId: string,
  itemId: string,
  kind: ItemKind,
  streamKind: StreamKind,
  text: string,
): Emit => [
  buildItemStarted(state, turnId, itemId, kind),
  buildContentDelta(state, turnId, itemId, streamKind, text),
  buildItemCompleted(state, turnId, itemId, kind, "completed"),
];

/**
 * Emits an `unknown` item for a vendor message this adapter does not map.
 * `normalize` attaches the raw payload.
 */
const emitUnknownItem = (state: Normalizing, out: Emit): void => {
  const turnId = ensureOpenTurn(state, out);
  const itemId = state.mint();
  out.push(buildItemStarted(state, turnId, itemId, "unknown"));
  out.push(buildItemCompleted(state, turnId, itemId, "unknown", "completed"));
};

type Streamed = Extract<SDKMessage, { type: "stream_event" }>["event"];

const onStreamEvent = (state: Normalizing, event: Streamed, agent: string, out: Emit): void => {
  const open = state.streams.get(agent);
  switch (event.type) {
    case "message_start": {
      state.streamed.add(event.message.id);
      state.streams.set(agent, { messageId: event.message.id, blocks: new Map() });
      return;
    }
    case "content_block_start": {
      const block = event.content_block;
      // A `tool_use` block streams only partial JSON arguments, which the
      // taxonomy has no kind for. The complete assistant message carries the
      // whole call later (spec 06 section 6.3).
      const kind: ItemKind | undefined =
        block.type === "text"
          ? "assistant_message"
          : block.type === "thinking"
            ? "reasoning"
            : undefined;
      if (kind === undefined || open === undefined) return;
      const turnId = ensureOpenTurn(state, out);
      const itemId = `${open.messageId}#${event.index}`;
      open.blocks.set(event.index, {
        itemId,
        kind,
        streamKind: kind === "reasoning" ? "reasoning_text" : "assistant_text",
      });
      out.push(buildItemStarted(state, turnId, itemId, kind));
      return;
    }
    case "content_block_delta": {
      const block = open?.blocks.get(event.index);
      if (block === undefined) return;
      // Signature and partial-JSON deltas are not text, so they produce no event.
      const text =
        event.delta.type === "text_delta"
          ? event.delta.text
          : event.delta.type === "thinking_delta"
            ? event.delta.thinking
            : undefined;
      if (text === undefined || text === "") return;
      out.push(
        buildContentDelta(state, ensureOpenTurn(state, out), block.itemId, block.streamKind, text),
      );
      return;
    }
    case "content_block_stop": {
      const block = open?.blocks.get(event.index);
      if (block === undefined || open === undefined) return;
      open.blocks.delete(event.index);
      out.push(
        buildItemCompleted(
          state,
          ensureOpenTurn(state, out),
          block.itemId,
          block.kind,
          "completed",
        ),
      );
      return;
    }
    default:
      // `message_delta`, `message_stop` and pings hold nothing the taxonomy
      // needs; the content deltas already carried the text.
      return;
  }
};

const onAssistant = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "assistant" }>,
  out: Emit,
): void => {
  const turnId = ensureOpenTurn(state, out);
  // Text and reasoning that streamed were already emitted, and this message
  // repeats them. Only a message that never streamed still needs them reported.
  const echo = state.streamed.has(sdk.message.id);
  for (const block of sdk.message.content) {
    if (block.type === "tool_use") {
      const kind = classifyTool(block.name);
      const itemId = block.id === "" ? state.mint() : block.id;
      state.tools.set(itemId, kind);
      out.push(
        buildItemStarted(state, turnId, itemId, kind, {
          name: block.name,
          input: block.input,
          ...(kind === "tool_call" ? { kind: isMcp(block.name) ? "mcp" : "native" } : {}),
        }),
      );
      continue;
    }
    if (echo) continue;
    if (block.type === "text") {
      out.push(
        ...buildWholeItem(
          state,
          turnId,
          state.mint(),
          "assistant_message",
          "assistant_text",
          block.text,
        ),
      );
    } else if (block.type === "thinking") {
      out.push(
        ...buildWholeItem(
          state,
          turnId,
          state.mint(),
          "reasoning",
          "reasoning_text",
          block.thinking,
        ),
      );
    }
  }
  if (sdk.error !== undefined) {
    const itemId = state.mint();
    out.push(buildItemStarted(state, turnId, itemId, "error", { class: sdk.error }));
    out.push(buildItemCompleted(state, turnId, itemId, "error", "failed", { class: sdk.error }));
  }
};

/**
 * Handles a user message from the harness. The harness repeats back the input
 * Hercule sent, but the repeated message does not show whether that input was
 * steered into a running turn, which `user_message` must report as `steered`
 * (spec 06 section 6.3). So the adapter reports user messages itself, and this
 * function ignores their text. It only handles `tool_result` blocks, each of
 * which closes a tool item.
 */
const onUser = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "user" }>,
  out: Emit,
): void => {
  const content = sdk.message.content;
  if (typeof content === "string") return;
  const turnId = ensureOpenTurn(state, out);
  for (const block of content) {
    if (block.type === "tool_result") {
      const itemId = block.tool_use_id === "" ? state.mint() : block.tool_use_id;
      const kind = state.tools.get(itemId) ?? "tool_call";
      state.tools.delete(itemId);
      out.push(
        buildItemCompleted(
          state,
          turnId,
          itemId,
          kind,
          block.is_error === true ? "failed" : "completed",
          {
            // Truncated because a `Read` of a big file returns it whole; `raw` keeps all of it.
            ...(block.content === undefined
              ? {}
              : {
                  content:
                    typeof block.content === "string"
                      ? cutToMessageLength(block.content)
                      : block.content,
                }),
          },
        ),
      );
    }
  }
};

/**
 * Returns the state a turn ended in. An abort is `interrupted`, which is
 * neither success nor failure.
 */
const readTurnState = (sdk: Extract<SDKMessage, { type: "result" }>): TurnState => {
  if (sdk.terminal_reason?.startsWith("aborted") === true) return "interrupted";
  return sdk.subtype === "success" && !sdk.is_error ? "completed" : "failed";
};

/**
 * Returns the session's usage so far, summed over every model. It reads
 * `modelUsage`, not `usage`: the SDK documents `usage` as covering only the
 * main agent loop, and only the current turn in a streaming-input session,
 * which every Hercule session is. `modelUsage` and `total_cost_usd` add up
 * across turns, which is what the usage snapshot must hold (spec 06 section
 * 6.6).
 */
const readUsage = (sdk: Extract<SDKMessage, { type: "result" }>): Usage => {
  const models = Object.values(sdk.modelUsage);
  const sumTokens = (read: (used: (typeof models)[number]) => number): number =>
    models.reduce((sum, used) => sum + clampCount(read(used)), 0);
  return {
    inputTokens: sumTokens((used) => used.inputTokens),
    outputTokens: sumTokens((used) => used.outputTokens),
    cacheReadTokens: sumTokens((used) => used.cacheReadInputTokens),
    cacheWriteTokens: sumTokens((used) => used.cacheCreationInputTokens),
    ...(Number.isFinite(sdk.total_cost_usd) && sdk.total_cost_usd >= 0
      ? { costUsd: sdk.total_cost_usd }
      : {}),
  };
};

/**
 * Returns the error message for a failed turn: the SDK's errors, else the
 * result text, else the subtype. Call it only for a failed turn: an interrupted
 * turn ends with `subtype: "success"` and the text the model had written so
 * far, which is not the reason the turn stopped.
 */
const describeFailure = (sdk: Extract<SDKMessage, { type: "result" }>): string => {
  if (sdk.subtype !== "success" && sdk.errors.length > 0)
    return cutToMessageLength(sdk.errors.join("; "));
  if (sdk.subtype === "success" && sdk.result !== "") return cutToMessageLength(sdk.result);
  return sdk.subtype;
};

/**
 * The SDK's result subtype for a turn where it re-prompted the model as many
 * times as allowed and still got no value that matches the schema.
 */
const RETRIES_EXHAUSTED = "error_max_structured_output_retries";

/**
 * Reads the structured output the harness produced for the schema. Returns
 * `undefined` when the result has nothing to do with the schema. Only two
 * results do:
 *
 * - a turn that ran to its end;
 * - a turn the harness gave up on because no output matched the schema.
 *
 * An interrupt or any other failure is about the turn itself. Checking the
 * schema for such a turn would report on an output that was never produced.
 */
const readHarnessAnswer = (
  sdk: Extract<SDKMessage, { type: "result" }>,
  turnState: TurnState,
): HarnessAnswer | undefined => {
  // Check for an interrupt first, whatever the subtype is. The user ended this
  // turn, so there is no output to check, even if the retries ran out.
  if (turnState === "interrupted") return undefined;
  if (sdk.subtype === RETRIES_EXHAUSTED) {
    return { missing: `the harness gave up on the schema: ${RETRIES_EXHAUSTED}` };
  }
  if (turnState !== "completed" || sdk.subtype !== "success") return undefined;
  return sdk.structured_output === undefined
    ? { missing: "the harness ended the turn without producing a structured output" }
    : { value: sdk.structured_output };
};

/**
 * Checks the turn's output against the session's schema. Returns `undefined`
 * when there is no schema or nothing to check.
 */
const judgeTurn = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "result" }>,
  turnState: TurnState,
): StructuredResult | undefined => {
  const schema = state.outputSchema;
  if (schema === undefined) return undefined;
  const answer = readHarnessAnswer(sdk, turnState);
  return answer === undefined ? undefined : judgeAnswer(schema, answer);
};

const onResult = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "result" }>,
  out: Emit,
): void => {
  const turnId = ensureOpenTurn(state, out);
  const usage = readUsage(sdk);
  const turnState = readTurnState(sdk);
  const structuredResult = judgeTurn(state, sdk, turnState);
  out.push({
    _tag: "session.usage.updated",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    usage,
  });
  closeTurn(state, out, turnId, turnState, {
    usage,
    ...(turnState === "failed" ? { error: describeFailure(sdk) } : {}),
    ...(structuredResult === undefined ? {} : { structuredResult }),
  });
};

const onSystem = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "system" }>,
  out: Emit,
): void => {
  switch (sdk.subtype) {
    case "init":
      // The adapter emits `session.started` itself when it starts the session,
      // so `init` adds nothing.
      return;
    case "compact_boundary": {
      const turnId = ensureOpenTurn(state, out);
      const itemId = state.mint();
      const detail = {
        trigger: sdk.compact_metadata.trigger,
        preTokens: sdk.compact_metadata.pre_tokens,
        postTokens: sdk.compact_metadata.post_tokens,
      };
      out.push(buildItemStarted(state, turnId, itemId, "context_compaction", detail));
      out.push(
        buildItemCompleted(state, turnId, itemId, "context_compaction", "completed", detail),
      );
      return;
    }
    case "api_retry":
      out.push({
        _tag: "runtime.warning",
        eventId: state.mint(),
        sessionId: state.sessionId,
        at: state.now(),
        ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
        message: cutToMessageLength(
          `retrying after ${sdk.error}: attempt ${sdk.attempt} of ${sdk.max_retries}`,
        ),
      });
      return;
    default:
      if (!TRIMMED.has(`system:${sdk.subtype}`)) emitUnknownItem(state, out);
      return;
  }
};

/**
 * The message types that can arrive between turns. Claude sends informational
 * messages after the `result` that closed the last turn. A turn opened for one
 * of them would wait for a `result` that never comes, and the session would
 * look busy for good. So a turn opened for one of these messages is closed
 * after that same message (spec 06 section 6.2, synthetic turns). `assistant`
 * and `stream_event` messages are model output, and a `result` ends their turn.
 */
const SELF_CONTAINED: ReadonlySet<string> = new Set(["user", "system"]);

/**
 * Converts one SDK message into normalized events and returns them. The raw
 * payload is attached to the first event that is not a `turn.started`, so the
 * vendor message is always available without every delta carrying a copy.
 *
 * Never throws. A message with a known type but changed fields becomes an
 * `unknown` item, because the CLI ships weekly and a `TypeError` here would
 * take a live session down.
 */
export const normalize = (state: Normalizing, sdk: SDKMessage): ReadonlyArray<ProviderEvent> => {
  const out: Emit = [];
  const unsolicited = state.turnId === undefined;
  try {
    dispatch(state, sdk, out);
  } catch {
    out.length = 0;
    emitUnknownItem(state, out);
  }
  if (unsolicited && state.turnId !== undefined) {
    if (out.every((event) => event._tag === "turn.started")) {
      // The message produced no events apart from the turn it opened, so drop
      // that turn.
      out.length = 0;
      state.turnId = undefined;
    } else if (SELF_CONTAINED.has(sdk.type)) {
      closeTurn(state, out, state.turnId, "completed");
    }
  }
  // There are thousands of deltas. A copy of the message on each one would
  // double the stream, and each delta already carries its text.
  if (sdk.type === "stream_event") return out;
  const at = out.findIndex((event) => event._tag !== "turn.started");
  const found = out[at];
  if (found !== undefined) {
    out[at] = { ...found, raw: { source: CLAUDE_SDK_MESSAGE, payload: toJson(sdk) } };
  }
  return out;
};

const dispatch = (state: Normalizing, sdk: SDKMessage, out: Emit): void => {
  switch (sdk.type) {
    case "system":
      onSystem(state, sdk, out);
      return;
    case "stream_event":
      onStreamEvent(state, sdk.event, sdk.parent_tool_use_id ?? "", out);
      return;
    case "assistant":
      onAssistant(state, sdk, out);
      return;
    case "user":
      onUser(state, sdk, out);
      return;
    case "result":
      onResult(state, sdk, out);
      return;
    default:
      if (!TRIMMED.has(sdk.type)) emitUnknownItem(state, out);
      return;
  }
};

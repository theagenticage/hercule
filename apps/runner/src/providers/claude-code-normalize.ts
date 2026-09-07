/**
 * The Claude Agent SDK's message stream turned into the one normalized
 * taxonomy (spec 06 section 6). Nothing here talks to the SDK or the clock: it
 * takes a message and a small mutable state, and answers with events.
 *
 * The state exists because the taxonomy brackets what the SDK reports flat. A
 * turn spans many messages and ends on the one `result`; a text item is opened
 * by a `content_block_start`, fed by deltas and closed by a
 * `content_block_stop`; a tool item is opened by an assistant `tool_use` block
 * and closed by the `tool_result` that comes back one message later.
 *
 * Nothing throws. A message shape this build has not heard of becomes an
 * `unknown` item carrying its raw payload, which is what keeps a trimmed
 * taxonomy honest against a harness that ships weekly (spec 06 section 6.7).
 */
import type * as Schema from "effect/Schema";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  MAX_MESSAGE_LENGTH,
  type ItemKind,
  type ProviderEvent,
  type StreamKind,
  type TurnState,
  type Usage,
} from "@hydra/protocol";

/** The channel name every raw payload from this adapter is filed under. */
export const CLAUDE_SDK_MESSAGE = "claude.sdk.message";

/** One open text or reasoning block, while its deltas are arriving. */
interface Block {
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly streamKind: StreamKind;
}

/**
 * What one session's normalization remembers between messages. Mutable on
 * purpose: this is a running position in a stream, not a value, and threading
 * it through immutably would buy nothing.
 */
export interface Normalizing {
  readonly sessionId: string;
  /** Minted ids: event ids, and the turn and item ids the SDK does not name. */
  readonly mint: () => string;
  /** The runner's own clock, as an ISO-8601 instant. */
  readonly now: () => string;
  /** The open turn, or `undefined` between turns. The adapter opens the first. */
  turnId: string | undefined;
  /** The assistant message currently streaming; item ids are derived from it. */
  messageId: string | undefined;
  /** Open text and reasoning blocks by their content-block index. */
  readonly blocks: Map<number, Block>;
  /**
   * Assistant messages whose blocks arrived as stream events. The CLI emits one
   * complete assistant message per finished content block, and the block's
   * position in that message is not its position in the stream, so the two
   * cannot be matched by index. They do not have to be: with
   * `includePartialMessages` the complete message is an echo, and only a
   * message that never streamed has anything left to say.
   */
  readonly streamed: Set<string>;
  /** Open tool items by `tool_use` id, so the `tool_result` completes the kind. */
  readonly tools: Map<string, ItemKind>;
}

export const normalizing = (
  sessionId: string,
  mint: () => string,
  now: () => string,
): Normalizing => ({
  sessionId,
  mint,
  now,
  turnId: undefined,
  messageId: undefined,
  blocks: new Map(),
  streamed: new Set(),
  tools: new Map(),
});

/**
 * Claude names tools; the taxonomy names kinds. Only the families the spec pins
 * are inferred, and everything else is an honest `tool_call` rather than a
 * guess (spec 06 section 6.3).
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

const toolKind = (name: string): ItemKind => TOOL_KINDS[name] ?? "tool_call";

/** The naming the SDK gives an MCP tool, and the only way to tell one apart. */
const isMcp = (name: string): boolean => name.startsWith("mcp__");

/**
 * Claude's informational tail, trimmed on purpose (spec 06 section 6.7).
 * Rate-limit and auth pushes are snapshot material, not session events, and
 * progress chatter says nothing a transcript reader wants. Everything outside
 * this list still becomes an `unknown` item rather than disappearing.
 */
const TRIMMED: ReadonlySet<string> = new Set([
  // Top-level message types. Auth is snapshot material; the other two are the
  // informational tail section 6.7 names by hand.
  "rate_limit_event",
  "auth_status",
  "tool_use_summary",
  "prompt_suggestion",
  "files_persisted",
  // `system` subtypes, under the prefix the switch below asks with. Hooks are
  // dropped by name in section 6.7; the rest is progress chatter.
  "system:status",
  "system:session_state_changed",
  "system:thinking_tokens",
  "system:background_tasks_changed",
  "system:commands_changed",
  "system:hook_started",
  "system:hook_progress",
  "system:hook_response",
]);

const said = (value: string): string => value.slice(0, MAX_MESSAGE_LENGTH);

const json = (value: unknown): Schema.Json => value as Schema.Json;

/** A count the protocol will carry: a whole number, never negative. */
const count = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

type Emit = Array<ProviderEvent>;

/**
 * Unsolicited output arrives outside any turn Hydra opened - a task
 * notification trailing a result, most often. The taxonomy has no home for an
 * item without a turn, so one is opened for it (spec 06 section 6.2).
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

const inTurn = (state: Normalizing, out: Emit): string => {
  const { turnId, events } = openTurn(state);
  out.push(...events);
  return turnId;
};

/** Ends the turn and everything the taxonomy was tracking inside it. */
const closeTurn = (
  state: Normalizing,
  out: Emit,
  turnId: string,
  turnState: TurnState,
  error?: string,
): void => {
  out.push({
    _tag: "turn.completed",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    turnId,
    state: turnState,
    ...(error === undefined ? {} : { error }),
  });
  state.turnId = undefined;
  state.messageId = undefined;
  state.blocks.clear();
  state.streamed.clear();
  state.tools.clear();
};

const started = (
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
    ...(detail === undefined ? {} : { detail: json(detail) }),
  };
};

const completed = (
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
  ...(detail === undefined ? {} : { detail: json(detail) }),
});

const delta = (
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

/** A whole item in one go: what a complete message reports that never streamed. */
const wholeItem = (
  state: Normalizing,
  turnId: string,
  itemId: string,
  kind: ItemKind,
  streamKind: StreamKind,
  text: string,
): Emit => [
  started(state, turnId, itemId, kind),
  delta(state, turnId, itemId, streamKind, text),
  completed(state, turnId, itemId, kind, "completed"),
];

/** A user message has no stream kind of its own, so its text rides `detail`. */
const userMessage = (state: Normalizing, turnId: string, text: string): Emit => {
  const itemId = state.mint();
  return [
    started(state, turnId, itemId, "user_message", { text }),
    completed(state, turnId, itemId, "user_message", "completed", { text }),
  ];
};

/**
 * The forward-compatible catch-all. It brackets its own turn when there is
 * none, because the messages that land here are the harness's informational
 * tail, which the SDK sends *after* the `result` that closed the last turn: a
 * turn opened for one would wait for a `result` that is never coming and pin
 * the session at busy.
 */
const unknownItem = (state: Normalizing, out: Emit): void => {
  const unsolicited = state.turnId === undefined;
  const turnId = inTurn(state, out);
  const itemId = state.mint();
  out.push(started(state, turnId, itemId, "unknown"));
  out.push(completed(state, turnId, itemId, "unknown", "completed"));
  if (unsolicited) closeTurn(state, out, turnId, "completed");
};

type Streamed = Extract<SDKMessage, { type: "stream_event" }>["event"];

const onStreamEvent = (state: Normalizing, event: Streamed, out: Emit): void => {
  switch (event.type) {
    case "message_start": {
      state.messageId = event.message.id;
      state.streamed.add(event.message.id);
      state.blocks.clear();
      return;
    }
    case "content_block_start": {
      const block = event.content_block;
      // A `tool_use` block streams only its partial JSON arguments, and the
      // taxonomy has no argument-streaming kind: the assistant message that
      // follows carries the call complete (spec 06 section 6.3).
      const kind: ItemKind | undefined =
        block.type === "text"
          ? "assistant_message"
          : block.type === "thinking"
            ? "reasoning"
            : undefined;
      if (kind === undefined) return;
      const turnId = inTurn(state, out);
      const itemId = `${state.messageId ?? "message"}#${event.index}`;
      state.blocks.set(event.index, {
        itemId,
        kind,
        streamKind: kind === "reasoning" ? "reasoning_text" : "assistant_text",
      });
      out.push(started(state, turnId, itemId, kind));
      return;
    }
    case "content_block_delta": {
      const block = state.blocks.get(event.index);
      if (block === undefined) return;
      // Signature and partial-JSON deltas are not text and carry no output.
      const text =
        event.delta.type === "text_delta"
          ? event.delta.text
          : event.delta.type === "thinking_delta"
            ? event.delta.thinking
            : undefined;
      if (text === undefined || text === "") return;
      out.push(delta(state, inTurn(state, out), block.itemId, block.streamKind, text));
      return;
    }
    case "content_block_stop": {
      const block = state.blocks.get(event.index);
      if (block === undefined) return;
      state.blocks.delete(event.index);
      out.push(completed(state, inTurn(state, out), block.itemId, block.kind, "completed"));
      return;
    }
    default:
      // `message_delta`, `message_stop` and pings say nothing the taxonomy
      // carries; the deltas already did.
      return;
  }
};

const onAssistant = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "assistant" }>,
  out: Emit,
): void => {
  const turnId = inTurn(state, out);
  // Text and reasoning that streamed are already on the wire, block by block;
  // this message is their echo. Only a message that never streamed still has
  // them to report, and then its item ids are the adapter's to mint.
  const echo = state.streamed.has(sdk.message.id);
  for (const block of sdk.message.content) {
    if (block.type === "tool_use") {
      const kind = toolKind(block.name);
      const itemId = block.id === "" ? state.mint() : block.id;
      state.tools.set(itemId, kind);
      out.push(
        started(state, turnId, itemId, kind, {
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
        ...wholeItem(
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
        ...wholeItem(state, turnId, state.mint(), "reasoning", "reasoning_text", block.thinking),
      );
    }
  }
  if (sdk.error !== undefined) {
    const itemId = state.mint();
    out.push(started(state, turnId, itemId, "error", { class: sdk.error }));
    out.push(completed(state, turnId, itemId, "error", "failed", { class: sdk.error }));
  }
};

const onUser = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "user" }>,
  out: Emit,
): void => {
  const turnId = inTurn(state, out);
  const content = sdk.message.content;
  if (typeof content === "string") {
    if (sdk.isSynthetic !== true) out.push(...userMessage(state, turnId, content));
    return;
  }
  for (const block of content) {
    if (block.type === "tool_result") {
      const itemId = block.tool_use_id === "" ? state.mint() : block.tool_use_id;
      const kind = state.tools.get(itemId) ?? "tool_call";
      state.tools.delete(itemId);
      out.push(
        completed(state, turnId, itemId, kind, block.is_error === true ? "failed" : "completed", {
          // A `Read` of a big file comes back here whole, and this event has to
          // fit in one frame.
          content: typeof block.content === "string" ? said(block.content) : block.content,
        }),
      );
      continue;
    }
    if (block.type === "text" && sdk.isSynthetic !== true) {
      out.push(...userMessage(state, turnId, block.text));
    }
  }
};

/** Aborts are the one terminal reason that is neither success nor failure. */
const stateOf = (sdk: Extract<SDKMessage, { type: "result" }>): TurnState => {
  if (sdk.terminal_reason?.startsWith("aborted") === true) return "interrupted";
  return sdk.subtype === "success" && !sdk.is_error ? "completed" : "failed";
};

/**
 * `modelUsage`, not `usage`: the SDK documents `usage` as the main agent loop
 * only and per-turn in a streaming-input session, which every Hydra session is,
 * while `modelUsage` totals every model call the session made and is cumulative
 * across turns - which is what the snapshot is pinned to be (spec 06 section
 * 6.6). `total_cost_usd` is cumulative on the same footing.
 */
const usageOf = (sdk: Extract<SDKMessage, { type: "result" }>): Usage => {
  const models = Object.values(sdk.modelUsage);
  const total = (read: (used: (typeof models)[number]) => number): number =>
    models.reduce((sum, used) => sum + count(read(used)), 0);
  return {
    inputTokens: total((used) => used.inputTokens),
    outputTokens: total((used) => used.outputTokens),
    cacheReadTokens: total((used) => used.cacheReadInputTokens),
    cacheWriteTokens: total((used) => used.cacheCreationInputTokens),
    ...(Number.isFinite(sdk.total_cost_usd) && sdk.total_cost_usd >= 0
      ? { costUsd: sdk.total_cost_usd }
      : {}),
  };
};

/**
 * Only a failure has an error. An interrupted turn ends on `subtype: "success"`
 * carrying whatever the model had written, and reporting that as the reason the
 * turn stopped would put the assistant's own words in the error field.
 */
const wentWrong = (sdk: Extract<SDKMessage, { type: "result" }>): string => {
  if (sdk.subtype !== "success" && sdk.errors.length > 0) return said(sdk.errors.join("; "));
  if (sdk.subtype === "success" && sdk.result !== "") return said(sdk.result);
  return sdk.subtype;
};

const onResult = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "result" }>,
  out: Emit,
): void => {
  const turnId = inTurn(state, out);
  const usage = usageOf(sdk);
  const turnState = stateOf(sdk);
  out.push({
    _tag: "session.usage.updated",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    usage,
  });
  out.push({
    _tag: "turn.completed",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    turnId,
    state: turnState,
    usage,
    ...(turnState === "failed" ? { error: wentWrong(sdk) } : {}),
  });
  state.turnId = undefined;
  state.messageId = undefined;
  state.blocks.clear();
  state.streamed.clear();
  state.tools.clear();
};

const onSystem = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "system" }>,
  out: Emit,
): void => {
  switch (sdk.subtype) {
    case "init":
      // The adapter reads the native session id off it and emits
      // `session.started` itself; the taxonomy has nothing else to say.
      return;
    case "compact_boundary": {
      const turnId = inTurn(state, out);
      const itemId = state.mint();
      const detail = {
        trigger: sdk.compact_metadata.trigger,
        preTokens: sdk.compact_metadata.pre_tokens,
        postTokens: sdk.compact_metadata.post_tokens,
      };
      out.push(started(state, turnId, itemId, "context_compaction", detail));
      out.push(completed(state, turnId, itemId, "context_compaction", "completed", detail));
      return;
    }
    case "api_retry":
      out.push({
        _tag: "runtime.warning",
        eventId: state.mint(),
        sessionId: state.sessionId,
        at: state.now(),
        ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
        message: said(`retrying after ${sdk.error}: attempt ${sdk.attempt} of ${sdk.max_retries}`),
      });
      return;
    default:
      if (!TRIMMED.has(`system:${sdk.subtype}`)) unknownItem(state, out);
      return;
  }
};

/**
 * One SDK message in, the events it means out. Raw rides the first event of
 * each complete message, so a consumer can always reach the vendor payload
 * without every delta carrying a copy of the message it came from.
 */
export const normalize = (state: Normalizing, sdk: SDKMessage): ReadonlyArray<ProviderEvent> => {
  const out: Emit = [];
  switch (sdk.type) {
    case "system":
      onSystem(state, sdk, out);
      break;
    case "stream_event":
      // Deltas are the volume on this stream, and they already carry their
      // text: attaching the message they came from to each one would double it.
      onStreamEvent(state, sdk.event, out);
      return out;
    case "assistant":
      onAssistant(state, sdk, out);
      break;
    case "user":
      onUser(state, sdk, out);
      break;
    case "result":
      onResult(state, sdk, out);
      break;
    default:
      if (TRIMMED.has(sdk.type)) return out;
      unknownItem(state, out);
      break;
  }
  // Never on the `turn.started` a message may have had to open first: the raw
  // payload belongs to the item or the outcome the message actually reported.
  const first = out.findIndex((event) => event._tag !== "turn.started");
  const found = out[first];
  if (found !== undefined) {
    out[first] = { ...found, raw: { source: CLAUDE_SDK_MESSAGE, payload: json(sdk) } };
  }
  return out;
};

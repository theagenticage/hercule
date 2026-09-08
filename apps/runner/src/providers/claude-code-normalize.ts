/**
 * The Claude Agent SDK's message stream turned into the one normalized taxonomy
 * (spec 06 section 6). It takes a message and a small mutable state, and
 * answers with events; it talks to neither the SDK nor the clock.
 *
 * The state exists because the taxonomy brackets what the SDK reports flat: a
 * turn spans many messages and ends on the one `result`, a text item runs from
 * `content_block_start` to `content_block_stop`, and a tool item is closed by
 * the `tool_result` that comes back one message later.
 *
 * Nothing throws. A message shape this build has not heard of becomes an
 * `unknown` item carrying its raw payload (spec 06 section 6.7).
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

/** One agent's assistant message in flight: the main loop's, or a subagent's. */
interface Streaming {
  messageId: string;
  readonly blocks: Map<number, Block>;
}

/** What one session's normalization remembers between messages: a running position, not a value. */
export interface Normalizing {
  readonly sessionId: string;
  /** Minted ids: event ids, and the turn and item ids the SDK does not name. */
  readonly mint: () => string;
  /** The runner's own clock, as an ISO-8601 instant. */
  readonly now: () => string;
  /** The open turn, or `undefined` between turns. The adapter opens the first. */
  turnId: string | undefined;
  /**
   * What is streaming right now, per agent. Keyed by `parent_tool_use_id`:
   * subagents stream alongside the main loop and their content-block indexes
   * are their own, so one map would have them overwriting each other.
   */
  readonly streams: Map<string, Streaming>;
  /**
   * Assistant messages whose blocks arrived as stream events. With
   * `includePartialMessages` the complete message that follows is an echo, so
   * only a message that never streamed has anything left to say. Matching by
   * index is not on: a block's position in the message is not its position in
   * the stream.
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
  streams: new Map(),
  streamed: new Set(),
  tools: new Map(),
});

/**
 * Claude names tools; the taxonomy names kinds. Only the families spec 06
 * section 6.3 pins are inferred; the rest is an honest `tool_call`.
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
  // Top-level message types.
  "rate_limit_event",
  "auth_status",
  "tool_use_summary",
  "prompt_suggestion",
  "tool_progress",
  // `system` subtypes, under the prefix the switch below asks with.
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

const said = (value: string): string => value.slice(0, MAX_MESSAGE_LENGTH);

/**
 * A real round-trip, not a cast: one `undefined` property anywhere in a vendor
 * payload would be a frame the protocol refuses to encode, which costs the
 * runner its socket and every session on it.
 */
const json = (value: unknown): Schema.Json =>
  JSON.parse(JSON.stringify(value ?? null)) as Schema.Json;

/** A count the protocol will carry: a whole number, never negative. */
const count = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

type Emit = Array<ProviderEvent>;

/**
 * Unsolicited output arrives outside any turn Hydra opened. The taxonomy has no
 * home for an item without a turn, so one is opened (spec 06 section 6.2).
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

/**
 * Ends the turn and the streaming it was tracking. Open tool calls are kept: an
 * interrupted turn's `tool_result` still arrives, needing the kind it was given.
 */
const closeTurn = (
  state: Normalizing,
  out: Emit,
  turnId: string,
  turnState: TurnState,
  extra: { readonly usage?: Usage; readonly error?: string } = {},
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
  });
  state.turnId = undefined;
  state.streams.clear();
  state.streamed.clear();
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

/** The forward-compatible catch-all: an unmapped vendor message, with its raw. */
const unknownItem = (state: Normalizing, out: Emit): void => {
  const turnId = inTurn(state, out);
  const itemId = state.mint();
  out.push(started(state, turnId, itemId, "unknown"));
  out.push(completed(state, turnId, itemId, "unknown", "completed"));
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
      // taxonomy has no kind for; the assistant message carries the call
      // complete (spec 06 section 6.3).
      const kind: ItemKind | undefined =
        block.type === "text"
          ? "assistant_message"
          : block.type === "thinking"
            ? "reasoning"
            : undefined;
      if (kind === undefined || open === undefined) return;
      const turnId = inTurn(state, out);
      const itemId = `${open.messageId}#${event.index}`;
      open.blocks.set(event.index, {
        itemId,
        kind,
        streamKind: kind === "reasoning" ? "reasoning_text" : "assistant_text",
      });
      out.push(started(state, turnId, itemId, kind));
      return;
    }
    case "content_block_delta": {
      const block = open?.blocks.get(event.index);
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
      const block = open?.blocks.get(event.index);
      if (block === undefined || open === undefined) return;
      open.blocks.delete(event.index);
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
  // Text and reasoning that streamed are already on the wire; this message is
  // their echo. Only one that never streamed has them left to report.
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

/**
 * A user message the harness sends back is its echo of what Hydra pushed, and
 * an echo cannot say which input it echoes - which is what `user_message`
 * carries as `steered` (spec 06 section 6.3). The adapter holds both, so it
 * reports the user's own messages and nothing is read out of the echo. What is
 * left here is the `tool_result` that closes the tool item one message later.
 */
const onUser = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "user" }>,
  out: Emit,
): void => {
  const content = sdk.message.content;
  if (typeof content === "string") return;
  const turnId = inTurn(state, out);
  for (const block of content) {
    if (block.type === "tool_result") {
      const itemId = block.tool_use_id === "" ? state.mint() : block.tool_use_id;
      const kind = state.tools.get(itemId) ?? "tool_call";
      state.tools.delete(itemId);
      out.push(
        completed(state, turnId, itemId, kind, block.is_error === true ? "failed" : "completed", {
          // Cut because a `Read` of a big file comes back whole; `raw` keeps it.
          ...(block.content === undefined
            ? {}
            : { content: typeof block.content === "string" ? said(block.content) : block.content }),
        }),
      );
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
 * only and per-turn in a streaming-input session, which every Hydra session is.
 * `modelUsage` and `total_cost_usd` are cumulative across turns, which is what
 * the snapshot is pinned to be (spec 06 section 6.6).
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
 * Only a failure has an error: an interrupted turn ends on `subtype: "success"`
 * carrying what the model had written, which is not why the turn stopped.
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
  closeTurn(state, out, turnId, turnState, {
    usage,
    ...(turnState === "failed" ? { error: wentWrong(sdk) } : {}),
  });
};

const onSystem = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "system" }>,
  out: Emit,
): void => {
  switch (sdk.subtype) {
    case "init":
      // The adapter emits `session.started` off it; nothing else to say.
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
 * The message classes that arrive between turns. Claude's informational tail
 * follows the `result` that closed the last turn, so a turn opened for one
 * would wait for a `result` that is never coming and the session would read
 * busy for the rest of its life. A turn opened for one of these is therefore
 * closed by the same message (spec 06 section 6.2, synthetic turns).
 * `assistant` and `stream_event` are model output: their `result` ends them.
 */
const SELF_CONTAINED: ReadonlySet<string> = new Set(["user", "system"]);

/**
 * One SDK message in, the events it means out. Raw rides the first event that
 * is not the turn the message had to open, so the vendor payload is always
 * reachable without every delta carrying a copy of it.
 *
 * Nothing here throws: the guard covers a message whose tag is known but whose
 * fields have moved, because the CLI ships weekly and a `TypeError` in here
 * would take a live session down with it.
 */
export const normalize = (state: Normalizing, sdk: SDKMessage): ReadonlyArray<ProviderEvent> => {
  const out: Emit = [];
  const unsolicited = state.turnId === undefined;
  try {
    dispatch(state, sdk, out);
  } catch {
    out.length = 0;
    unknownItem(state, out);
  }
  if (unsolicited && state.turnId !== undefined) {
    if (out.every((event) => event._tag === "turn.started")) {
      // The message said nothing the taxonomy carries, so the turn it opened on
      // the way in is not a turn at all.
      out.length = 0;
      state.turnId = undefined;
    } else if (SELF_CONTAINED.has(sdk.type)) {
      closeTurn(state, out, state.turnId, "completed");
    }
  }
  // There are thousands of deltas; a copy of the message on each would double
  // the stream, and the delta already carries its text.
  if (sdk.type === "stream_event") return out;
  const at = out.findIndex((event) => event._tag !== "turn.started");
  const found = out[at];
  if (found !== undefined) {
    out[at] = { ...found, raw: { source: CLAUDE_SDK_MESSAGE, payload: json(sdk) } };
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
      if (!TRIMMED.has(sdk.type)) unknownItem(state, out);
      return;
  }
};

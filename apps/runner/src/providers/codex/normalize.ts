/**
 * The app-server's notifications turned into the one normalized taxonomy (spec
 * 06 section 6): one decoded frame plus a small mutable per-session state in,
 * events out. It reads no process, no clock but the wall one, and no socket.
 *
 * The state is a running position rather than a value. `turn/started` carries
 * no model at this release, so the model the adapter opened the turn under is
 * held here; and one reasoning item arrives on two channels, of which only one
 * may be streamed (spec 06 section 6.4).
 *
 * A notification this build has no mapping for produces nothing: the app-server
 * grows methods between releases and a live session must survive one it has not
 * heard of (spec 06 section 10.2). An item type it has no kind for is reported
 * as `unknown`, with the frame on `raw`, so nothing is lost.
 */
import type * as Schema from "effect/Schema";
import {
  type ItemKind,
  type ItemStatus,
  type ProviderEvent,
  type StreamKind,
  type TurnState,
  type Usage,
} from "@hydra/protocol";
import { now } from "../../report";
import { fact, text } from "../text";
import type { NotificationFrame } from "./rpc";
import type {
  AgentMessageDeltaNotification,
  CodexErrorInfo,
  ErrorNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadItem,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartedNotification,
} from "./types";

/** The one channel every raw payload from this adapter is filed under. */
export const CODEX_NOTIFICATION = "codex.app-server.notification";

/** Which of an item's two reasoning streams this session settled on. */
type Channel = "summary" | "raw";

export interface Normalizing {
  readonly sessionId: string;
  /** The native thread, named on every event so a surface can join the two. */
  readonly threadId: string;
  /**
   * The model the adapter last opened a turn under. `turn/started` carries
   * none, and the adapter is the only party that knows which one it asked for.
   */
  model: string | undefined;
  readonly reasoning: Map<string, Channel>;
}

export const normalizing = (sessionId: string, threadId: string): Normalizing => ({
  sessionId,
  threadId,
  model: undefined,
  reasoning: new Map(),
});

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

/** What every event off this module carries, whatever else it says. */
const envelope = (
  state: Normalizing,
  payload: unknown,
): {
  readonly eventId: string;
  readonly sessionId: string;
  readonly at: string;
  readonly providerRefs: Readonly<Record<string, string>>;
  readonly raw: { readonly source: string; readonly payload: Schema.Json };
} => ({
  eventId: crypto.randomUUID(),
  sessionId: state.sessionId,
  at: now(),
  providerRefs: { threadId: state.threadId },
  raw: { source: CODEX_NOTIFICATION, payload: json(payload) },
});

/**
 * Codex's item vocabulary in the taxonomy's; everything else is `unknown`.
 * `userMessage` is `null` rather than `user_message`: it is Codex echoing back
 * what Hydra sent, and the adapter already reported that input itself, with
 * what it did to the turn. Two items for one message would read as the user
 * having said it twice.
 */
const ITEM_KINDS: Readonly<Record<ThreadItem["type"], ItemKind | null>> = {
  userMessage: null,
  agentMessage: "assistant_message",
  reasoning: "reasoning",
  commandExecution: "command_execution",
  fileChange: "file_change",
  mcpToolCall: "tool_call",
  dynamicToolCall: "tool_call",
  functionCallOutput: "tool_call",
  webSearch: "web_search",
  collabAgentToolCall: "subagent",
  subAgentActivity: "subagent",
  plan: "plan",
  contextCompaction: "context_compaction",
  hookPrompt: "unknown",
  imageView: "unknown",
  sleep: "unknown",
  imageGeneration: "unknown",
  enteredReviewMode: "unknown",
  exitedReviewMode: "unknown",
};

const kindOf = (item: ThreadItem): ItemKind | null => {
  const known: ItemKind | null | undefined = ITEM_KINDS[item.type];
  // An item type this release did not have is still an item.
  return known === undefined ? "unknown" : known;
};

/**
 * The one field of an item a reader wants in a row: what the command ran, what
 * the patch touched, what the tool was called. Kept to that - `raw` holds the
 * rest, and a vendor-shaped detail would make what the user reads a function of
 * which harness answered.
 */
const detail = (item: ThreadItem): { readonly detail?: Schema.Json } => {
  switch (item.type) {
    case "commandExecution":
      return { detail: { command: text(item.command) } };
    case "fileChange": {
      const paths = item.changes.map((change) => fact(change.path));
      const path = paths[0];
      if (path === undefined) return {};
      // The first path is what a one-line row shows; the rest are there for a
      // reader that opens the item.
      return { detail: paths.length === 1 ? { path } : { path, paths } };
    }
    case "mcpToolCall":
      return { detail: { name: fact(`${item.server}/${item.tool}`), kind: "mcp" } };
    case "dynamicToolCall":
      return { detail: { name: fact(item.tool), kind: "native" } };
    case "functionCallOutput":
      return { detail: { name: fact(item.name), kind: "native" } };
    case "webSearch":
      return { detail: { description: text(item.query) } };
    case "collabAgentToolCall":
      return { detail: { name: fact(item.tool) } };
    default:
      // A plan, a reasoning block, an assistant message, a compaction and an
      // unmapped item are all read off their own text or their raw payload.
      return {};
  }
};

/**
 * Only a command and a patch carry a status, and only they can be refused. A
 * refusal reported as a failure would show the agent as broken rather than as
 * told no.
 */
const statusOf = (item: ThreadItem): ItemStatus => {
  const status = "status" in item ? item.status : undefined;
  if (status === "declined") return "declined";
  return status === "failed" ? "failed" : "completed";
};

/** A turn that has not ended is not a boundary: reporting one would close it. */
const TURN_STATES: Readonly<Record<string, TurnState>> = {
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
};

const DELTA_STREAMS: Readonly<Record<string, StreamKind>> = {
  "item/agentMessage/delta": "assistant_text",
  "item/commandExecution/outputDelta": "command_output",
};

const REASONING_CHANNELS: Readonly<Record<string, Channel>> = {
  "item/reasoning/textDelta": "raw",
  "item/reasoning/summaryTextDelta": "summary",
};

const delta = (
  state: Normalizing,
  params: AgentMessageDeltaNotification,
  streamKind: StreamKind,
): ReadonlyArray<ProviderEvent> => [
  {
    _tag: "content.delta",
    ...envelope(state, params),
    turnId: fact(params.turnId),
    itemId: fact(params.itemId),
    streamKind,
    delta: params.delta,
  },
];

/**
 * Raw reasoning wins, and it wins once: the summary is the same thinking said
 * twice, so streaming both would double the item's text and there is no third
 * stream kind to put the other on (spec 06 section 6.4).
 */
const reasoningDelta = (
  state: Normalizing,
  params: AgentMessageDeltaNotification,
  channel: Channel,
): ReadonlyArray<ProviderEvent> => {
  if (state.reasoning.get(params.itemId) === "raw" && channel === "summary") return [];
  state.reasoning.set(params.itemId, channel);
  return delta(state, params, "reasoning_text");
};

const usageOf = (usage: ThreadTokenUsageUpdatedNotification["tokenUsage"]): Usage => ({
  inputTokens: count(usage.total.inputTokens),
  outputTokens: count(usage.total.outputTokens),
  cacheReadTokens: count(usage.total.cachedInputTokens),
  cacheWriteTokens: count(usage.total.cacheWriteInputTokens),
});

/**
 * The class Codex named, in the shape it named it in: a bare string for the
 * plain variants, and the variant's own key where it carries detail. An error
 * with no class is still an error, so it is reported as `unknown` rather than
 * dropped.
 */
const classOf = (info: CodexErrorInfo | null | undefined): string => {
  if (typeof info === "string") return fact(info);
  if (typeof info !== "object" || info === null) return "unknown";
  return fact(Object.keys(info)[0] ?? "unknown");
};

const onError = (state: Normalizing, params: ErrorNotification): ReadonlyArray<ProviderEvent> => {
  const turn = params.turnId === "" ? {} : { turnId: fact(params.turnId) };
  const failure = classOf(params.error.codexErrorInfo);
  // Codex is already retrying it, so a failure here would be a turn reported as
  // over while it is still running.
  if (params.willRetry) {
    return [
      {
        _tag: "runtime.warning",
        ...envelope(state, params),
        ...turn,
        message: text(`${failure}: ${params.error.message}, which Codex is retrying itself`),
      },
    ];
  }
  return [
    {
      _tag: "runtime.error",
      ...envelope(state, params),
      ...turn,
      class: failure,
      message: text(params.error.message),
    },
  ];
};

export const normalize = (
  state: Normalizing,
  frame: NotificationFrame,
): ReadonlyArray<ProviderEvent> => {
  const reasoning = REASONING_CHANNELS[frame.method];
  if (reasoning !== undefined) {
    return reasoningDelta(state, frame.params as AgentMessageDeltaNotification, reasoning);
  }
  const streamKind = DELTA_STREAMS[frame.method];
  if (streamKind !== undefined) {
    return delta(state, frame.params as AgentMessageDeltaNotification, streamKind);
  }
  switch (frame.method) {
    case "turn/started": {
      const params = frame.params as TurnStartedNotification;
      return [
        {
          _tag: "turn.started",
          ...envelope(state, params),
          turnId: fact(params.turn.id),
          ...(state.model === undefined ? {} : { model: fact(state.model) }),
        },
      ];
    }
    case "turn/completed": {
      const params = frame.params as TurnCompletedNotification;
      const ended = TURN_STATES[params.turn.status];
      if (ended === undefined) return [];
      // The items of a turn that is over cannot stream any more, and their
      // channels are what the map holds.
      state.reasoning.clear();
      return [
        {
          _tag: "turn.completed",
          ...envelope(state, params),
          turnId: fact(params.turn.id),
          state: ended,
        },
      ];
    }
    case "item/started": {
      const params = frame.params as ItemStartedNotification;
      const kind = kindOf(params.item);
      if (kind === null) return [];
      return [
        {
          _tag: "item.started",
          ...envelope(state, params),
          turnId: fact(params.turnId),
          itemId: fact(params.item.id),
          kind,
          ...detail(params.item),
        },
      ];
    }
    case "item/completed": {
      const params = frame.params as ItemCompletedNotification;
      const kind = kindOf(params.item);
      if (kind === null) return [];
      return [
        {
          _tag: "item.completed",
          ...envelope(state, params),
          turnId: fact(params.turnId),
          itemId: fact(params.item.id),
          kind,
          status: statusOf(params.item),
          ...detail(params.item),
        },
      ];
    }
    case "thread/tokenUsage/updated": {
      const params = frame.params as ThreadTokenUsageUpdatedNotification;
      return [
        {
          _tag: "session.usage.updated",
          ...envelope(state, params),
          // The cumulative breakdown, not the last turn's: a snapshot taken
          // from `last` would make the session look like it never grew.
          usage: usageOf(params.tokenUsage),
        },
      ];
    }
    case "error":
      return onError(state, frame.params as ErrorNotification);
    default:
      return [];
  }
};

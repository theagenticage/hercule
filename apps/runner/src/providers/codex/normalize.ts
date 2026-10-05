/**
 * Converts the app-server's notifications into normalized provider events.
 * It takes one decoded frame and a small mutable per-session state, and
 * returns events. It uses no process, no socket, and no clock other than the
 * wall clock. Spec 06 section 6 owns the event taxonomy.
 *
 * The state is mutable because it tracks progress through the session:
 *
 * - `turn/started` has no model at this release, so the state holds the model
 *   the adapter opened the turn with.
 * - One reasoning item arrives on two channels, raw and summary, and only one
 *   of them is streamed, so the text is not doubled.
 * - Codex reports the thread's usage over its whole history, but a usage
 *   snapshot counts only what this process spent, so the state holds the
 *   thread's usage from before this process started.
 *
 * A notification this build does not handle produces no events: the
 * app-server adds methods between releases, and a live session must survive
 * one it does not know (spec 06 section 10.2). An item type with no mapping is
 * reported as `unknown`, with the frame in `raw`, so nothing is lost.
 */
import type * as Schema from "effect/Schema";
import type {
  ItemKind,
  ItemStatus,
  OutputSchema,
  ProviderEvent,
  StreamKind,
  StructuredResult,
  TurnState,
  Usage,
} from "@hercule/protocol";
import { clampCount, buildEnvelope, buildRaw, type Envelope } from "../normalize";
import { judgeAnswer, type HarnessAnswer } from "../structured-result";
import { ensureId } from "../events";
import { truncateFact, truncateMessage } from "../text";
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

/** The channel name every raw payload from this adapter is filed under. */
const CODEX_NOTIFICATION = "codex.app-server.notification";

/** Which of an item's two reasoning streams is being streamed. */
type Channel = "summary" | "raw";

export interface Normalizing {
  readonly sessionId: string;
  /** The native thread id, included on every event so a surface can link the two. */
  readonly threadId: string;
  /**
   * The model the adapter last opened a turn with. `turn/started` does not
   * include it, and only the adapter knows which model it asked for.
   */
  model: string | undefined;
  readonly reasoning: Map<string, Channel>;
  /** The schema every turn of this session must answer with, if there is one. */
  readonly outputSchema: OutputSchema | undefined;
  /**
   * The last item the running turn completed. The structured answer is read
   * from this item: Codex constrains the turn's final assistant message, so
   * the answer is that message, and only if the turn ended on it.
   */
  lastCompletedItem: ThreadItem | undefined;
  /**
   * Whether a turn has started in this process. On a resume or a fork, Codex
   * reports the thread's restored usage before any turn starts. An earlier
   * process already reported those tokens, so reports before the first turn
   * are dropped.
   */
  turnStarted: boolean;
  /**
   * The thread's usage from before this process started, subtracted from
   * every report. It is unknown until the first report after a turn starts.
   */
  usageBaseline: TokenCounts | undefined;
}

export const buildNormalizingState = (
  sessionId: string,
  threadId: string,
  outputSchema: OutputSchema | undefined,
): Normalizing => ({
  sessionId,
  threadId,
  model: undefined,
  reasoning: new Map(),
  outputSchema,
  lastCompletedItem: undefined,
  turnStarted: false,
  usageBaseline: undefined,
});

const buildSessionEnvelope = (state: Normalizing): Envelope =>
  buildEnvelope(state.sessionId, { threadId: state.threadId });

/** Builds the `raw` field: the notification the event came from, under this adapter's channel. */
const buildNotificationRaw = (payload: unknown): ReturnType<typeof buildRaw> =>
  buildRaw(CODEX_NOTIFICATION, payload);

/**
 * Maps each Codex item type to a normalized item kind; unmapped types are
 * `unknown`. `userMessage` maps to `null` (no event) rather than
 * `user_message`: it is Codex echoing back what Hercule sent, and the adapter
 * has already reported that input, along with whether it steered the turn.
 * Two items for one message would look like the user sent it twice.
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

const classifyItem = (item: ThreadItem): ItemKind | null => {
  const known: ItemKind | null | undefined = ITEM_KINDS[item.type];
  // An item type added after this release is still reported, as `unknown`.
  return known === undefined ? "unknown" : known;
};

/**
 * Returns the paths a file change item touches, truncated for the protocol.
 * An empty path is left out, because it shows the reader nothing and the
 * protocol rejects it. The approval card and the item row both use this list.
 */
export const readChangedPaths = (
  item: Extract<ThreadItem, { type: "fileChange" }>,
): ReadonlyArray<string> =>
  item.changes.flatMap((change) => (change.path === "" ? [] : [truncateFact(change.path)]));

/**
 * Builds an item's `detail`: the one thing a reader wants to see in a row,
 * such as the command that ran, the file a patch touched, or the tool that was
 * called. Everything else stays in `raw`. A detail shaped like Codex's own
 * data would make the row look different depending on the harness.
 */
const buildDetail = (item: ThreadItem): { readonly detail?: Schema.Json } => {
  switch (item.type) {
    case "commandExecution":
      return { detail: { command: truncateMessage(item.command) } };
    case "fileChange": {
      const paths = readChangedPaths(item);
      const path = paths[0];
      if (path === undefined) return {};
      // A one-line row shows the first path; the full list is for a reader
      // who opens the item.
      return { detail: paths.length === 1 ? { path } : { path, paths } };
    }
    case "mcpToolCall":
      return { detail: { name: truncateFact(`${item.server}/${item.tool}`), kind: "mcp" } };
    case "dynamicToolCall":
      return { detail: { name: truncateFact(item.tool), kind: "native" } };
    case "functionCallOutput":
      return { detail: { name: truncateFact(item.name), kind: "native" } };
    case "webSearch":
      return { detail: { description: truncateMessage(item.query) } };
    case "collabAgentToolCall":
      return { detail: { name: truncateFact(item.tool) } };
    default:
      // A plan, a reasoning block, an assistant message, a compaction and an
      // unmapped item are shown from their own text or their raw payload.
      return {};
  }
};

/**
 * Returns an item's final status. Only commands and patches have a status, and
 * only they can be declined. A declined item is reported as `declined`, not
 * `failed`: reporting it as a failure would make the agent look broken when
 * the user just said no.
 */
const readItemStatus = (item: ThreadItem): ItemStatus => {
  const status = "status" in item ? item.status : undefined;
  if (status === "declined") return "declined";
  return status === "failed" ? "failed" : "completed";
};

/**
 * The end states a turn can complete in. A turn that is still in progress is
 * not listed, because reporting it would mark the turn as ended.
 */
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

const buildContentDelta = (
  state: Normalizing,
  params: AgentMessageDeltaNotification,
  streamKind: StreamKind,
): ReadonlyArray<ProviderEvent> => [
  {
    _tag: "content.delta",
    ...buildSessionEnvelope(state),
    turnId: ensureId(params.turnId),
    itemId: ensureId(params.itemId),
    streamKind,
    delta: params.delta,
  },
];

/**
 * Builds a reasoning delta, or nothing if the delta is on the channel not
 * being streamed. Raw reasoning is preferred: once an item has sent raw
 * reasoning, its summary deltas are dropped. The summary repeats the same
 * reasoning, so streaming both would double the item's text, and there is no
 * separate stream kind for summaries (spec 06 section 6.4).
 */
const buildReasoningDelta = (
  state: Normalizing,
  params: AgentMessageDeltaNotification,
  channel: Channel,
): ReadonlyArray<ProviderEvent> => {
  if (state.reasoning.get(params.itemId) === "raw" && channel === "summary") return [];
  state.reasoning.set(params.itemId, channel);
  return buildContentDelta(state, params, "reasoning_text");
};

/** Codex's usage report for a thread: its whole total and its last model call. */
type ThreadTokenUsage = ThreadTokenUsageUpdatedNotification["tokenUsage"];

/** Codex's token counts for a thread, as it reports them. */
type TokenCounts = Pick<
  ThreadTokenUsage["total"],
  "inputTokens" | "cachedInputTokens" | "cacheWriteInputTokens" | "outputTokens"
>;

/** Returns `total` minus `earlier`, count by count. */
const subtractTokenCounts = (total: TokenCounts, earlier: TokenCounts): TokenCounts => ({
  inputTokens: total.inputTokens - earlier.inputTokens,
  cachedInputTokens: total.cachedInputTokens - earlier.cachedInputTokens,
  cacheWriteInputTokens: total.cacheWriteInputTokens - earlier.cacheWriteInputTokens,
  outputTokens: total.outputTokens - earlier.outputTokens,
});

/**
 * Builds a usage snapshot from Codex's counts. Codex counts cached reads
 * inside its input, while the four parts of a snapshot never overlap (spec 06
 * section 6.6), so the cached reads are subtracted from the input.
 */
const buildUsage = (counts: TokenCounts): Usage => ({
  inputTokens: clampCount(counts.inputTokens - counts.cachedInputTokens),
  outputTokens: clampCount(counts.outputTokens),
  cacheReadTokens: clampCount(counts.cachedInputTokens),
  cacheWriteTokens: clampCount(counts.cacheWriteInputTokens),
});

/**
 * Returns the tokens the thread used since this process started, or
 * `undefined` for a report that comes before the first turn: that report is
 * the restored history of a resumed or forked thread.
 *
 * The first report after a turn starts sets the baseline to `total - last`,
 * the thread's usage before the model call it reports. That one rule covers a
 * fresh thread (the baseline is zero), a resume, and a fork, which starts
 * from its parent's total (spec 06 section 13.5).
 */
const computeUsageSinceStart = (state: Normalizing, usage: ThreadTokenUsage): Usage | undefined => {
  if (!state.turnStarted) return undefined;
  state.usageBaseline ??= subtractTokenCounts(usage.total, usage.last);
  return buildUsage(subtractTokenCounts(usage.total, state.usageBaseline));
};

/**
 * Returns the error class from Codex's error info. The plain variants are a
 * bare string; a variant with details is an object whose only key is the
 * class. An error with no class is still reported, as `unknown`.
 */
const classifyError = (info: CodexErrorInfo | null | undefined): string => {
  if (typeof info === "string") return truncateFact(info);
  if (typeof info !== "object" || info === null) return "unknown";
  return truncateFact(Object.keys(info)[0] ?? "unknown");
};

const onError = (state: Normalizing, params: ErrorNotification): ReadonlyArray<ProviderEvent> => {
  const turn = params.turnId === "" ? {} : { turnId: truncateFact(params.turnId) };
  const failure = classifyError(params.error.codexErrorInfo);
  // Codex is already retrying, so reporting an error here would mark the turn
  // as failed while it is still running.
  if (params.willRetry) {
    return [
      {
        _tag: "runtime.warning",
        ...buildSessionEnvelope(state),
        ...buildNotificationRaw(params),
        ...turn,
        message: truncateMessage(`${failure}: ${params.error.message} (Codex is retrying)`),
      },
    ];
  }
  return [
    {
      _tag: "runtime.error",
      ...buildSessionEnvelope(state),
      ...buildNotificationRaw(params),
      ...turn,
      class: failure,
      message: truncateMessage(params.error.message),
    },
  ];
};

/**
 * Reads the turn's structured answer. Codex constrains only the final
 * assistant message, so the answer is the text of the item the turn ended on,
 * parsed as JSON exactly as written. Returns `missing` with a reason when the
 * last item is not an agent message or its text is not JSON. A message wrapped
 * in prose or a code fence is not the constrained output, and extracting JSON
 * from it would be guessing at an answer the model never gave.
 */
const readHarnessAnswer = (last: ThreadItem | undefined): HarnessAnswer => {
  if (last?.type !== "agentMessage") {
    return { missing: "the turn ended without a final agent message" };
  }
  try {
    return { value: JSON.parse(last.text) };
  } catch {
    return { missing: "the final agent message is not JSON" };
  }
};

/** The API's error code for a schema it cannot use to constrain the answer. */
const INVALID_SCHEMA = "invalid_json_schema";

/**
 * The name Codex gives the response format that carries the schema. The API's
 * error message includes it. The message is checked for this name only when
 * no error code can be parsed, because the API may reword a message at any
 * time, while an error code is part of its contract.
 */
const OUTPUT_SCHEMA_FORMAT_NAME = "codex_output_schema";

/**
 * Parses `message` as an API error body and returns its `error` object.
 * Codex passes the API's error body through unchanged. Returns an empty object
 * if the message is not such a body.
 */
const parseErrorBody = (
  message: string,
): { readonly code?: unknown; readonly message?: unknown } => {
  try {
    const body = JSON.parse(message) as { readonly error?: unknown };
    const error = body.error;
    return typeof error === "object" && error !== null ? error : {};
  } catch {
    return {};
  }
};

/**
 * Returns the error message if the turn failed because of the schema itself,
 * or `undefined` if it failed for another reason.
 *
 * The API rejects a schema it cannot enforce before it runs the model. Codex
 * then fails the turn and puts the whole API error body in
 * `turn.error.message`. The body holds an error code and a message:
 *
 * - If the code is `invalid_json_schema`, the failure is about the schema, and
 *   the body's message is returned.
 * - If the body is not JSON but mentions the response format
 *   `codex_output_schema`, the failure is still about the schema, and the whole
 *   message is returned.
 */
const readSchemaRefusal = (turn: TurnCompletedNotification["turn"]): string | undefined => {
  const message = turn.error?.message;
  if (message === undefined) return undefined;
  const error = parseErrorBody(message);
  if (error.code === INVALID_SCHEMA) {
    return typeof error.message === "string" ? error.message : message;
  }
  return message.includes(OUTPUT_SCHEMA_FORMAT_NAME) ? message : undefined;
};

/**
 * Returns the turn's structured result, or `undefined` if the session has no
 * schema or the turn has nothing to judge:
 *
 * - A completed turn is judged on its answer.
 * - A turn that failed because of the schema is a schema failure, with
 *   Codex's error message as the reason.
 * - Any other failure, and any interrupt, gets no result. A result there would
 *   claim that an answer was checked and rejected.
 */
const judgeTurn = (
  state: Normalizing,
  turn: TurnCompletedNotification["turn"],
  ended: TurnState,
): StructuredResult | undefined => {
  const schema = state.outputSchema;
  if (schema === undefined) return undefined;
  if (ended === "completed") return judgeAnswer(schema, readHarnessAnswer(state.lastCompletedItem));
  const refused = ended === "failed" ? readSchemaRefusal(turn) : undefined;
  return refused === undefined ? undefined : judgeAnswer(schema, { missing: refused });
};

export const normalize = (
  state: Normalizing,
  frame: NotificationFrame,
): ReadonlyArray<ProviderEvent> => {
  const reasoning = REASONING_CHANNELS[frame.method];
  if (reasoning !== undefined) {
    return buildReasoningDelta(state, frame.params as AgentMessageDeltaNotification, reasoning);
  }
  const streamKind = DELTA_STREAMS[frame.method];
  if (streamKind !== undefined) {
    return buildContentDelta(state, frame.params as AgentMessageDeltaNotification, streamKind);
  }
  switch (frame.method) {
    case "turn/started": {
      const params = frame.params as TurnStartedNotification;
      // Each turn is judged on its own answer. If the previous turn's
      // completion never arrived or could not be read, its last item must not
      // be used as this turn's answer.
      state.lastCompletedItem = undefined;
      state.turnStarted = true;
      return [
        {
          _tag: "turn.started",
          ...buildSessionEnvelope(state),
          ...buildNotificationRaw(params),
          turnId: ensureId(params.turn.id),
          ...(state.model === undefined ? {} : { model: truncateFact(state.model) }),
        },
      ];
    }
    case "turn/completed": {
      const params = frame.params as TurnCompletedNotification;
      const ended = TURN_STATES[params.turn.status];
      if (ended === undefined) return [];
      const structuredResult = judgeTurn(state, params.turn, ended);
      // The items of an ended turn cannot stream any more, so their reasoning
      // channels are no longer needed.
      state.reasoning.clear();
      state.lastCompletedItem = undefined;
      return [
        {
          _tag: "turn.completed",
          ...buildSessionEnvelope(state),
          ...buildNotificationRaw(params),
          turnId: ensureId(params.turn.id),
          state: ended,
          ...(structuredResult === undefined ? {} : { structuredResult }),
        },
      ];
    }
    case "item/started": {
      const params = frame.params as ItemStartedNotification;
      const kind = classifyItem(params.item);
      if (kind === null) return [];
      return [
        {
          _tag: "item.started",
          ...buildSessionEnvelope(state),
          ...buildNotificationRaw(params),
          turnId: ensureId(params.turnId),
          itemId: ensureId(params.item.id),
          kind,
          ...buildDetail(params.item),
        },
      ];
    }
    case "item/completed": {
      const params = frame.params as ItemCompletedNotification;
      // Recorded before the item is classified, because the echo of the user's
      // message also counts: a turn that ends on that echo has no answer.
      state.lastCompletedItem = params.item;
      const kind = classifyItem(params.item);
      if (kind === null) return [];
      return [
        {
          _tag: "item.completed",
          ...buildSessionEnvelope(state),
          ...buildNotificationRaw(params),
          turnId: ensureId(params.turnId),
          itemId: ensureId(params.item.id),
          kind,
          status: readItemStatus(params.item),
          ...buildDetail(params.item),
        },
      ];
    }
    case "thread/tokenUsage/updated": {
      const params = frame.params as ThreadTokenUsageUpdatedNotification;
      const usage = computeUsageSinceStart(state, params.tokenUsage);
      if (usage === undefined) return [];
      return [
        {
          _tag: "session.usage.updated",
          ...buildSessionEnvelope(state),
          ...buildNotificationRaw(params),
          usage,
        },
      ];
    }
    case "error":
      return onError(state, frame.params as ErrorNotification);
    default:
      return [];
  }
};

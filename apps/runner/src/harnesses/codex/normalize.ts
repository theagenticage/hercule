/**
 * Converts the app-server's notifications into normalized harness events.
 * It takes one decoded frame and mutable state for one Codex thread, and
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
 *   last total Codex reported and the tokens counted so far.
 *
 * Every notification method of the pinned release has a decision in
 * `NOTIFICATION_DECISIONS`: events built from it, or a reason it is dropped.
 * Typecheck fails when a Codex upgrade adds a method nobody decided yet. A
 * method or an item type the pinned release does not list, which a newer Codex
 * can send, becomes an `unknown` item with a label and the frame in `raw`, so
 * nothing is lost and a live session survives it (spec 06 sections 6.7 and
 * 10.2).
 */
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  MAX_TODO_STEPS,
  type ImageGenerationDetail,
  type ItemKind,
  type ItemStatus,
  type OutputSchema,
  type HarnessEvent,
  type StreamKind,
  type StructuredResult,
  type SubagentId,
  type TodoListDetail,
  type TodoStep,
  type TodoStepStatus,
  type TurnState,
  type UnknownItemDetail,
  type Usage,
  type WaitDetail,
} from "@hercule/protocol";
import { clampCount, buildEnvelope, buildRaw, toJson, type Envelope } from "../normalize";
import { judgeAnswer, type HarnessAnswer } from "../structured-result";
import { ensureId } from "../events";
import { buildEditedPathFields } from "../edited-paths";
import { requireText, truncateFact, truncateMessage } from "../text";
import { buildUnknownItemLabel } from "../message-reporting";
import type { NotificationFrame } from "./rpc";
import type {
  AgentMessageDeltaNotification,
  CodexErrorInfo,
  ErrorNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  ServerNotification,
  ThreadItem,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartedNotification,
} from "./types";

/** The channel name every raw payload from this adapter is filed under. */
const CODEX_NOTIFICATION = "codex.app-server.notification";

/** Which of an item's two reasoning streams is being streamed. */
type Channel = "summary" | "raw";

/**
 * How the normalizer tells the runner's log about messages it does not show.
 * Both write at most one line per kind of message per session.
 */
export interface MessageReports {
  /**
   * A message with no decision, or one whose fields could not be read, by its
   * label. `error` is what failed when the fields could not be read.
   */
  readonly reportUnknownMessage: (label: string, error?: unknown) => void;
  /**
   * A message the normalizer understood but deliberately did not show, such as
   * a frame for a turn that is over. `key` names the kind of message and `text`
   * is the line.
   */
  readonly reportIgnoredMessage: (key: string, text: string) => void;
}

/**
 * The todo list item an agent shows for its running turn: the item's id, the
 * turn it belongs to, and the steps its last event carried.
 */
interface ShownTodoList {
  readonly itemId: string;
  readonly turnId: string;
  readonly steps: ReadonlyArray<TodoStep>;
}

export interface Normalizing {
  readonly sessionId: string;
  /** The native thread id, included on every event so a surface can link the two. */
  readonly threadId: string;
  /** The session's native root thread, excluded from subagent item links. */
  readonly rootThreadId: string;
  /** The subagent whose events this state normalizes, absent for the root. */
  readonly subagentId: SubagentId | undefined;
  /**
   * The model the adapter last opened a turn with. `turn/started` does not
   * include it, and only the adapter knows which model it asked for.
   */
  model: string | undefined;
  /**
   * The id of the thread's running turn: set by `turn/started` and cleared by
   * the `turn/completed` of that same turn. A frame that names another turn
   * is late, and must not change the running turn's items or state.
   */
  openTurnId: string | undefined;
  /** The todo list item of the running turn, or `undefined` before the plan's first update. */
  todoList: ShownTodoList | undefined;
  /** Tells the runner's log about the messages this state does not show. */
  readonly reports: MessageReports;
  /**
   * Returns whether the thread has a turn that has been asked for but whose
   * `turn/started` has not arrived yet. The thread's owner sets it, because
   * only the owner knows which inputs are on their way. Until then no turn is
   * known, and an item drawn now would open a turn that ends while the real
   * one is about to start.
   */
  isTurnPending: () => boolean;
  /** The turn whose oversized plan was already warned about, so a plan that stays too long warns once. */
  oversizedPlanTurnId: string | undefined;
  readonly reasoning: Map<string, Channel>;
  /**
   * The assistant messages of the running turn whose text has reached the
   * stream, whether as deltas or as the one delta `buildMissingMessageText`
   * adds. A repeated `item/completed` for such a message adds nothing. The set
   * is emptied when the turn ends.
   */
  readonly streamedMessages: Set<string>;
  /** The root's output schema, absent for a subagent whose answer belongs to its parent. */
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
   * process already reported those tokens, so a report before the first turn
   * is not counted.
   */
  turnStarted: boolean;
  /** The thread's total from Codex's last usage report, or `undefined` before the first report. */
  previousTotal: TokenCounts | undefined;
  /** The tokens counted since this process started, in Codex's own counts. */
  counted: TokenCounts;
  /** Whether some calls in this process could not be counted. */
  usageIncomplete: boolean;
  /** Whether the next usable report must establish a baseline without counting history. */
  usageBaselineRequired: boolean;
}

/** Builds independent state for one native thread; only the root keeps an output schema. */
export const buildNormalizingState = (
  sessionId: string,
  threadId: string,
  outputSchema: OutputSchema | undefined,
  reports: MessageReports,
  subagent?: { readonly subagentId: SubagentId; readonly rootThreadId: string },
): Normalizing => ({
  sessionId,
  threadId,
  rootThreadId: subagent?.rootThreadId ?? threadId,
  subagentId: subagent?.subagentId,
  model: undefined,
  openTurnId: undefined,
  todoList: undefined,
  reports,
  isTurnPending: () => false,
  oversizedPlanTurnId: undefined,
  reasoning: new Map(),
  streamedMessages: new Set(),
  outputSchema: subagent === undefined ? outputSchema : undefined,
  lastCompletedItem: undefined,
  turnStarted: false,
  previousTotal: undefined,
  counted: NO_TOKENS,
  usageIncomplete: false,
  usageBaselineRequired: false,
});

const buildCodexThreadEnvelope = (
  state: Normalizing,
): Envelope & { readonly subagentId?: SubagentId } => ({
  ...buildEnvelope(state.sessionId, { threadId: state.threadId }),
  ...(state.subagentId === undefined ? {} : { subagentId: state.subagentId }),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** Builds the `raw` field: the notification the event came from, under this adapter's channel. */
const buildNotificationRaw = (payload: unknown): ReturnType<typeof buildRaw> =>
  buildRaw(CODEX_NOTIFICATION, payload);

/**
 * The decision for every item type of the pinned release: the kind of item it
 * is reported as, or `null` for an item that is not reported as an item. A
 * Codex upgrade that adds a type fails typecheck until it is listed here.
 *
 * - The root's `userMessage` echoes input the adapter already reported, so it
 *   is `null`. `classifyItem` reports a subagent's `userMessage` instead: it
 *   holds the task input its parent gave the subagent.
 * - `hookPrompt` is `null` because hooks are trimmed on purpose (spec 06
 *   section 6.7).
 * - `enteredReviewMode` and `exitedReviewMode` are `null` because they are
 *   shown as a notice, not as an item (`buildReviewNotice`).
 */
const ITEM_KINDS: Readonly<Record<ThreadItem["type"], Exclude<ItemKind, "unknown"> | null>> = {
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
  hookPrompt: null,
  imageView: "file_read",
  sleep: "wait",
  imageGeneration: "image_generation",
  enteredReviewMode: null,
  exitedReviewMode: null,
};

/**
 * Returns the kind an item is reported as, or `null` when it is not reported
 * as an item. A type that `ITEM_KINDS` does not list, such as one a newer
 * Codex added, is `unknown`.
 */
const classifyItem = (state: Normalizing, item: ThreadItem): ItemKind | null => {
  if (item.type === "userMessage" && state.subagentId !== undefined) return "user_message";
  // Only the table's own keys count, so a type named like an object method,
  // such as `constructor`, finds nothing.
  return Object.hasOwn(ITEM_KINDS, item.type) ? ITEM_KINDS[item.type] : "unknown";
};

/**
 * Returns the paths a file change item shows to the user in an approval,
 * truncated for the protocol. An empty path is left out, because it shows the
 * reader nothing and the protocol rejects it.
 */
export const readApprovalPaths = (
  item: Extract<ThreadItem, { type: "fileChange" }>,
): ReadonlyArray<string> =>
  item.changes.flatMap((change) => (change.path === "" ? [] : [truncateFact(change.path)]));

/**
 * Returns every path a file change item edits, written whole as Codex gave
 * it, so Edit Overlaps can compare it with other sessions' paths. A rename
 * lists both its old path and its new one. The paths are not cut to the
 * protocol's limit: `buildEditedPathFields` leaves out one that is too long.
 */
const readEditedPaths = (
  item: Extract<ThreadItem, { type: "fileChange" }>,
): ReadonlyArray<string> =>
  item.changes.flatMap((change) => {
    const moved = change.kind.type === "update" ? change.kind.move_path : null;
    return moved === null || moved === undefined ? [change.path] : [change.path, moved];
  });

/**
 * Builds an item's `detail`: the one thing a reader wants to see in a row,
 * such as the command that ran, the file a patch touched or an image view
 * read, or the tool that was called. Everything else stays in `raw`. A detail
 * shaped like Codex's own data would make the row look different depending on
 * the harness.
 */
const buildDetail = (
  state: Normalizing,
  item: ThreadItem,
  phase: "started" | "completed",
): { readonly detail?: Schema.Json } => {
  switch (item.type) {
    case "userMessage":
      return {
        detail: {
          text: item.content
            .flatMap((input) => (input.type === "text" ? [input.text] : []))
            .join("\n"),
        },
      };
    case "commandExecution":
      return { detail: { command: truncateMessage(item.command) } };
    case "fileChange": {
      const fields = buildEditedPathFields(readEditedPaths(item));
      return fields === undefined ? {} : { detail: fields };
    }
    case "mcpToolCall":
      return { detail: { name: truncateFact(`${item.server}/${item.tool}`), kind: "mcp" } };
    case "dynamicToolCall":
      return { detail: { name: truncateFact(item.tool), kind: "native" } };
    case "functionCallOutput":
      return { detail: { name: truncateFact(item.name), kind: "native" } };
    case "webSearch":
      return { detail: { description: truncateMessage(item.query) } };
    // An empty path is left out for the same reason as in `readApprovalPaths`.
    case "imageView":
      return item.path === "" ? {} : { detail: { path: truncateFact(item.path) } };
    // The plan's text is known only when the item completes: the deltas before
    // that need not add up to it (see `NOTIFICATION_DECISIONS`).
    case "plan":
      return phase === "started" ? {} : { detail: { content: truncateMessage(item.text) } };
    case "sleep": {
      if (typeof item.durationMs !== "number") throw new Error("sleep durationMs is not a number");
      const detail: WaitDetail = { durationMs: clampCount(item.durationMs) };
      return { detail };
    }
    case "imageGeneration": {
      const saved = item.savedPath;
      if (saved === undefined || requireText(saved, "savedPath") === "") return {};
      const detail: ImageGenerationDetail = { path: truncateFact(saved) };
      return { detail };
    }
    case "collabAgentToolCall": {
      const subagentIds = item.receiverThreadIds.filter((id) => id !== state.rootThreadId);
      return {
        detail: {
          name: truncateFact(item.tool),
          ...(subagentIds.length === 0 ? {} : { subagentIds }),
          ...(item.prompt == null ? {} : { description: truncateMessage(item.prompt) }),
        },
      };
    }
    case "subAgentActivity":
      return {
        detail: {
          name: item.kind,
          ...(item.agentThreadId === state.rootThreadId
            ? {}
            : { subagentIds: [item.agentThreadId] }),
        },
      };
    default:
      // A reasoning block, an assistant message and a compaction are shown
      // from their own text or their raw payload.
      return {};
  }
};

/**
 * Returns an item's final status. A declined command or patch stays declined
 * because the user refused it. An interrupted subagent call failed to finish
 * its work, so the call is failed; the subagent's own turn reports its end.
 */
const readItemStatus = (item: ThreadItem): ItemStatus => {
  if (item.type === "subAgentActivity" && item.kind === "interrupted") return "failed";
  const status = "status" in item ? item.status : undefined;
  if (status === "declined") return "declined";
  return status === "failed" || status === "interrupted" ? "failed" : "completed";
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

/**
 * Checks that a delta notification has the text and the ids the protocol needs,
 * and returns them. Throws when one is not text, so a malformed delta is
 * reported as an `unknown` item before it changes any state.
 */
const readDelta = (
  params: AgentMessageDeltaNotification,
): { readonly turnId: string; readonly itemId: string; readonly delta: string } => ({
  turnId: requireText(params.turnId, "turnId"),
  itemId: requireText(params.itemId, "itemId"),
  delta: requireText(params.delta, "delta"),
});

const buildContentDelta = (
  state: Normalizing,
  delta: ReturnType<typeof readDelta>,
  streamKind: StreamKind,
): ReadonlyArray<HarnessEvent> => [
  {
    _tag: "content.delta",
    ...buildCodexThreadEnvelope(state),
    turnId: ensureId(delta.turnId),
    itemId: ensureId(delta.itemId),
    streamKind,
    delta: delta.delta,
  },
];

/**
 * Returns whether a frame names a turn other than the thread's running one.
 * Such a frame is late: its turn is over, and it must not start an item in
 * that turn, stream into it, or change the running turn's state. A thread with
 * no running turn has every turn over. Codex always sends `turn/started` before
 * the first item of a turn, also for a subagent thread, whose queued frames are
 * replayed in order.
 */
const isLateTurn = (state: Normalizing, turnId: string): boolean => state.openTurnId !== turnId;

/** Tells the runner's log that a frame for a finished turn was not shown. */
const reportLateFrame = (state: Normalizing, method: string, turnId: string): void =>
  state.reports.reportIgnoredMessage(
    `late ${method}`,
    `Codex sent ${method} for turn ${truncateFact(turnId)}, which is not the thread's running turn. It was not shown.`,
  );

/**
 * Returns the whole text of a completed assistant message as one delta when
 * no delta carried it, or nothing when the text already streamed or is empty.
 * Codex streams the text of an ordinary message as deltas, but a message
 * written in one piece, such as an async question, arrives only inside its
 * `item/completed` frame, and a client builds a message's text from deltas.
 */
const buildMissingMessageText = (
  state: Normalizing,
  params: ItemCompletedNotification,
): ReadonlyArray<HarnessEvent> => {
  const { item } = params;
  if (item.type !== "agentMessage" || item.text === "" || state.streamedMessages.has(item.id)) {
    return [];
  }
  state.streamedMessages.add(item.id);
  return buildContentDelta(
    state,
    readDelta({
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: item.id,
      delta: item.text,
    }),
    "assistant_text",
  );
};

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
): ReadonlyArray<HarnessEvent> => {
  const delta = readDelta(params);
  if (isLateTurn(state, delta.turnId)) {
    reportLateFrame(state, "a reasoning delta", delta.turnId);
    return [];
  }
  if (state.reasoning.get(delta.itemId) === "raw" && channel === "summary") return [];
  state.reasoning.set(delta.itemId, channel);
  return buildContentDelta(state, delta, "reasoning_text");
};

/** Codex's usage report for a thread: its whole total and its last model call. */
type ThreadTokenUsage = ThreadTokenUsageUpdatedNotification["tokenUsage"];

/** Codex's token counts for a thread, as it reports them. */
type TokenCounts = Pick<
  ThreadTokenUsage["total"],
  "inputTokens" | "cachedInputTokens" | "cacheWriteInputTokens" | "outputTokens"
>;

const TOKEN_COUNT_KEYS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
] as const satisfies ReadonlyArray<keyof TokenCounts>;

const NO_TOKENS: TokenCounts = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
};

const NativeTokenCount = Schema.Number.check(
  Schema.makeFilter((count: number) => Number.isSafeInteger(count) && count >= 0),
);

const NativeTokenCounts = Schema.Struct({
  inputTokens: NativeTokenCount,
  cachedInputTokens: NativeTokenCount,
  cacheWriteInputTokens: NativeTokenCount,
  outputTokens: NativeTokenCount,
}).check(Schema.makeFilter((counts) => counts.cachedInputTokens <= counts.inputTokens));

const SavedUsageReport = Schema.Struct({
  source: Schema.Literal(CODEX_NOTIFICATION),
  payload: Schema.Struct({
    threadId: Schema.String,
    tokenUsage: Schema.Struct({ total: NativeTokenCounts }),
  }),
});

/**
 * Restores the native total without counting historical work. Returns false
 * for another provider, another Codex thread, or invalid counters. The
 * controller keeps the report unchanged; only this adapter interprets it.
 */
export const restoreUsageReport = (state: Normalizing, report: unknown): boolean => {
  const decoded = Schema.decodeUnknownOption(SavedUsageReport)(report);
  if (Option.isNone(decoded) || decoded.value.payload.threadId !== state.threadId) return false;
  state.previousTotal = decoded.value.payload.tokenUsage.total;
  return true;
};

/** Marks the known subtotal incomplete without discarding a usable native baseline. */
export const markUsageIncomplete = (state: Normalizing): void => {
  state.usageIncomplete = true;
};

/** Requires the next usable report to establish a baseline without counting old work. */
export const requireUsageBaseline = (state: Normalizing): void => {
  markUsageIncomplete(state);
  state.previousTotal = undefined;
  state.usageBaselineRequired = true;
};

/**
 * Initializes a zero baseline after native replay finishes without a report.
 * Returns false if a rejected report requires a later usable baseline.
 */
export const initializeUsageBaseline = (state: Normalizing): boolean => {
  if (state.usageBaselineRequired) return false;
  state.previousTotal ??= NO_TOKENS;
  return true;
};

/** Returns `total` minus `earlier`, count by count. A count may come out negative. */
const subtractTokenCounts = (total: TokenCounts, earlier: TokenCounts): TokenCounts => ({
  inputTokens: total.inputTokens - earlier.inputTokens,
  cachedInputTokens: total.cachedInputTokens - earlier.cachedInputTokens,
  cacheWriteInputTokens: total.cacheWriteInputTokens - earlier.cacheWriteInputTokens,
  outputTokens: total.outputTokens - earlier.outputTokens,
});

/**
 * Returns `counted` plus how much each count grew from `previous` to `total`.
 * A count that went down adds nothing: Codex resets its total when the
 * context window overflows, and a usage snapshot never goes down (spec 06
 * section 6.6).
 */
const addTotalGrowth = (
  counted: TokenCounts,
  previous: TokenCounts,
  total: TokenCounts,
): TokenCounts => {
  const growth = subtractTokenCounts(total, previous);
  const sum = { ...counted };
  for (const key of TOKEN_COUNT_KEYS) sum[key] += Math.max(0, growth[key]);
  return sum;
};

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
 * Returns everything a thread has used so far, from one of Codex's usage
 * reports, or `undefined` when the report's counts are not valid. A thread
 * that started empty, such as a text generation's, has used exactly its
 * total, so no baseline is needed.
 */
export const readTotalUsage = (usage: ThreadTokenUsage): Usage | undefined => {
  const decoded = Schema.decodeUnknownOption(NativeTokenCounts)(usage.total);
  return Option.isNone(decoded) ? undefined : buildUsage(decoded.value);
};

/**
 * Counts how much the thread's total grew since Codex's previous report, and
 * returns the tokens counted since this process started. Returns `undefined`
 * for a report that comes before the first turn: that report is the restored
 * history of a resumed or forked thread, and it only sets where counting
 * starts.
 *
 * Counting the growth of the total, rather than the total itself, covers
 * every report Codex sends (spec 06 section 13.5):
 *
 * - With no earlier report, counting starts from `total - last`, the thread's
 *   usage before the model call reported. That is zero on a fresh thread and
 *   the inherited total on a public fork. Native spawned subagents start at zero.
 * - Codex repeats an unchanged total after a cancelled call, a stream error
 *   or a compaction. A repeated total adds nothing.
 * - A total that went down adds nothing, and counting continues from it.
 */
const countUsageSinceStart = (state: Normalizing, usage: ThreadTokenUsage): Usage | undefined => {
  const total = Schema.decodeUnknownSync(NativeTokenCounts)(usage.total);
  if (state.usageBaselineRequired) {
    state.previousTotal = total;
    state.usageBaselineRequired = false;
    return state.turnStarted ? buildUsage(state.counted) : undefined;
  }
  const previous =
    state.previousTotal ??
    subtractTokenCounts(total, Schema.decodeUnknownSync(NativeTokenCounts)(usage.last));
  state.previousTotal = total;
  if (!state.turnStarted) return undefined;
  state.counted = addTotalGrowth(state.counted, previous, total);
  return buildUsage(state.counted);
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

const onError = (state: Normalizing, params: ErrorNotification): ReadonlyArray<HarnessEvent> => {
  const turn = params.turnId === "" ? {} : { turnId: truncateFact(params.turnId) };
  const failure = classifyError(params.error.codexErrorInfo);
  // Codex is already retrying, so reporting an error here would mark the turn
  // as failed while it is still running.
  if (params.willRetry) {
    return [
      {
        _tag: "runtime.warning",
        ...buildCodexThreadEnvelope(state),
        ...buildNotificationRaw(params),
        ...turn,
        message: truncateMessage(`${failure}: ${params.error.message} (Codex is retrying)`),
      },
    ];
  }
  return [
    {
      _tag: "runtime.error",
      ...buildCodexThreadEnvelope(state),
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
export const readHarnessAnswer = (last: ThreadItem | undefined): HarnessAnswer => {
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

/** The method names of every notification the pinned Codex release sends. */
type NotificationMethod = ServerNotification["method"];

/** The params of the notification a method names. */
type NotificationParams<Method extends NotificationMethod> = Extract<
  ServerNotification,
  { method: Method }
>["params"];

/**
 * What the adapter does with one notification method: a function that returns
 * its events, or a string with the reason nothing is shown (the notification is
 * dropped). The function receives the params already typed for its method.
 */
type NotificationDecision<Method extends NotificationMethod> =
  | ((state: Normalizing, params: NotificationParams<Method>) => ReadonlyArray<HarnessEvent>)
  | string;

/** The params of a `turn/plan/updated` notification. */
type PlanUpdate = NotificationParams<"turn/plan/updated">;

/** Maps the status Codex gives a plan step to the status of a todo step. */
const TODO_STEP_STATUSES: Readonly<Record<PlanUpdate["plan"][number]["status"], TodoStepStatus>> = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed",
};

/** The two events that tell the user something without being an item. */
type RuntimeMessageTag = "runtime.warning" | "runtime.notice";

/**
 * Builds a `runtime.notice` (neutral information) or a `runtime.warning`
 * (something went wrong, but the session goes on) from a notification.
 * `payload` is what goes into `raw`. With a `turnId` the event names that turn.
 * Without one it names no turn, and so opens none: a notice or a warning
 * between turns is drawn without a turn around it (spec 06 section 6.2).
 */
const buildRuntimeMessage = (
  state: Normalizing,
  tag: RuntimeMessageTag,
  message: string,
  payload: unknown,
  turnId?: string,
): HarnessEvent => ({
  _tag: tag,
  ...buildCodexThreadEnvelope(state),
  ...buildNotificationRaw(payload),
  ...(turnId === undefined ? {} : { turnId: ensureId(turnId) }),
  message: truncateMessage(message),
});

/**
 * Returns `turnId` when it is the thread's running turn, and `undefined`
 * otherwise. A notice or a warning names a turn only while that turn runs: one
 * that names a finished turn would be drawn inside it, long after it ended.
 */
const readRunningTurnId = (state: Normalizing, turnId: string): string | undefined =>
  turnId === state.openTurnId ? turnId : undefined;

/** What an item frame reports: the kind of the item, and its detail when it has one. */
interface ItemFields {
  readonly kind: ItemKind;
  readonly detail?: Schema.Json;
}

/**
 * Returns the kind and the detail an item frame is reported with, or `null`
 * for an item that is not reported as an item. An item type with no entry in
 * `ITEM_KINDS` is reported as `unknown` with a label, and the runner's log
 * hears of it.
 */
const describeItem = (
  state: Normalizing,
  item: ThreadItem,
  phase: "started" | "completed",
): ItemFields | null => {
  // Every item needs an id the protocol accepts, also the ones not reported.
  requireText(item.id, "item id");
  const kind = classifyItem(state, item);
  if (kind === null) return null;
  if (kind !== "unknown") return { kind, ...buildDetail(state, item, phase) };
  const label = buildUnknownItemLabel("codex", `item/${String(item.type)}`);
  state.reports.reportUnknownMessage(label);
  return { kind, detail: { label } satisfies UnknownItemDetail };
};

const onItemStarted = (
  state: Normalizing,
  params: ItemStartedNotification,
): ReadonlyArray<HarnessEvent> => {
  // An item that starts in a turn other than the running one would show as
  // work that never ends, because that turn's end has already been reported.
  const turnId = requireText(params.turnId, "turnId");
  if (isLateTurn(state, turnId)) {
    reportLateFrame(state, "item/started", turnId);
    return [];
  }
  const fields = describeItem(state, params.item, "started");
  if (fields === null) return [];
  return [
    {
      _tag: "item.started",
      ...buildCodexThreadEnvelope(state),
      ...buildNotificationRaw(params),
      turnId: ensureId(params.turnId),
      itemId: ensureId(params.item.id),
      ...fields,
    },
  ];
};

/**
 * Returns the notice for a review mode item: "Codex started a review: <what
 * is reviewed>" when it is entered, and "Codex finished the review" when it is
 * left. Returns nothing for any other item.
 *
 * `review` holds a short description of what is reviewed, such as "current
 * changes", on entry, and the whole rendered review on exit. The entry notice
 * quotes the description, cut to a fact. The exit notice leaves the review out:
 * it can be long, and the agent's own answer repeats it. The item stays in
 * `raw`. Throws when `review` is not text.
 */
const buildReviewNotice = (
  state: Normalizing,
  params: ItemCompletedNotification,
): ReadonlyArray<HarnessEvent> => {
  const { item } = params;
  const turnId = readRunningTurnId(state, params.turnId);
  if (item.type === "enteredReviewMode") {
    const review = truncateFact(requireText(item.review, "review"));
    const message = review === "" ? "Codex started a review" : `Codex started a review: ${review}`;
    return [buildRuntimeMessage(state, "runtime.notice", message, params, turnId)];
  }
  if (item.type === "exitedReviewMode") {
    return [
      buildRuntimeMessage(state, "runtime.notice", "Codex finished the review", params, turnId),
    ];
  }
  return [];
};

const onItemCompleted = (
  state: Normalizing,
  params: ItemCompletedNotification,
): ReadonlyArray<HarnessEvent> => {
  // A completion for a turn other than the running one still completes its
  // item, which started earlier. It changes nothing else: its turn is over, so
  // it is not the running turn's answer, and its text cannot stream any more.
  const late = isLateTurn(state, requireText(params.turnId, "turnId"));
  // Everything the frame must hold is checked before any state changes, so a
  // malformed completion leaves nothing behind that would hide a good repeat.
  requireText(params.item.id, "item id");
  if (params.item.type === "agentMessage") requireText(params.item.text, "message text");
  if (!late) {
    // Recorded before the item is classified, because the echo of the user's
    // message also counts: a turn that ends on that echo has no answer.
    state.lastCompletedItem = params.item;
  }
  const fields = describeItem(state, params.item, "completed");
  if (fields === null) return buildReviewNotice(state, params);
  const turnId = ensureId(params.turnId);
  const itemId = ensureId(params.item.id);
  return [
    ...(late ? [] : buildMissingMessageText(state, params)),
    // Codex saves a generated image when the item completes, so its path is not
    // known when the item starts. A client reads an item's detail from the
    // events that update it, so the path goes out as an update first.
    ...(fields.kind === "image_generation" && fields.detail !== undefined
      ? [
          {
            _tag: "item.updated" as const,
            ...buildCodexThreadEnvelope(state),
            turnId,
            itemId,
            kind: fields.kind,
            detail: fields.detail,
          },
        ]
      : []),
    {
      _tag: "item.completed",
      ...buildCodexThreadEnvelope(state),
      ...buildNotificationRaw(params),
      turnId,
      itemId,
      status: readItemStatus(params.item),
      ...fields,
    },
  ];
};

/**
 * Completes the todo list item of the thread, with the steps it last showed,
 * and forgets the item. With `endedTurnId` it completes the item only when it
 * belongs to that turn. Without one it completes whatever item is open.
 * Returns nothing when there is no such item.
 */
const completeTodoList = (
  state: Normalizing,
  endedTurnId?: string,
): ReadonlyArray<HarnessEvent> => {
  const shown = state.todoList;
  if (shown === undefined || (endedTurnId !== undefined && shown.turnId !== endedTurnId)) return [];
  state.todoList = undefined;
  const detail: TodoListDetail = { steps: shown.steps };
  return [
    {
      _tag: "item.completed",
      ...buildCodexThreadEnvelope(state),
      turnId: ensureId(shown.turnId),
      itemId: shown.itemId,
      kind: "todo_list",
      status: "completed",
      detail: toJson(detail),
    },
  ];
};

const onTurnStarted = (
  state: Normalizing,
  params: TurnStartedNotification,
): ReadonlyArray<HarnessEvent> => {
  const turnId = ensureId(params.turn.id);
  // A todo list left open by a turn whose completion never arrived would show
  // as work that never ends.
  const unfinished = completeTodoList(state);
  // Each turn is judged on its own answer. If the previous turn's completion
  // never arrived or could not be read, its last item must not be used as this
  // turn's answer.
  state.lastCompletedItem = undefined;
  state.turnStarted = true;
  state.openTurnId = params.turn.id;
  return [
    ...unfinished,
    {
      _tag: "turn.started",
      ...buildCodexThreadEnvelope(state),
      ...buildNotificationRaw(params),
      turnId,
      ...(state.model === undefined ? {} : { model: truncateFact(state.model) }),
    },
  ];
};

const onTurnCompleted = (
  state: Normalizing,
  params: TurnCompletedNotification,
): ReadonlyArray<HarnessEvent> => {
  const ended = Object.hasOwn(TURN_STATES, params.turn.status)
    ? TURN_STATES[params.turn.status]
    : undefined;
  if (ended === undefined) return [];
  // The completion of another turn than the running one comes late. It ends
  // its own turn, but it must not judge, or clear the state of, the turn that
  // is running now.
  const late = state.openTurnId !== undefined && state.openTurnId !== params.turn.id;
  const todoCompletion = completeTodoList(state, params.turn.id);
  let structuredResult: StructuredResult | undefined;
  if (!late) {
    structuredResult = judgeTurn(state, params.turn, ended);
    // The items of an ended turn cannot stream any more, so their reasoning
    // channels and message records are no longer needed.
    state.reasoning.clear();
    state.streamedMessages.clear();
    state.lastCompletedItem = undefined;
    state.openTurnId = undefined;
  }
  return [
    ...todoCompletion,
    {
      _tag: "turn.completed",
      ...buildCodexThreadEnvelope(state),
      ...buildNotificationRaw(params),
      turnId: ensureId(params.turn.id),
      state: ended,
      ...(structuredResult === undefined ? {} : { structuredResult }),
    },
  ];
};

/**
 * Builds the steps of a todo list from Codex's plan. Throws when a step has no
 * text or a status this build does not know, so the update is reported as an
 * `unknown` item and the user does not see a list that is wrong.
 */
const buildTodoSteps = (plan: PlanUpdate["plan"]): ReadonlyArray<TodoStep> =>
  plan.map(({ step, status }) => {
    if (requireText(step, "plan step text") === "") throw new Error("a plan step has no text");
    if (!Object.hasOwn(TODO_STEP_STATUSES, status)) {
      throw new Error(`a plan step has the status ${String(status)}, which is not known`);
    }
    return { text: truncateFact(step), status: TODO_STEP_STATUSES[status] };
  });

/**
 * Shows Codex's plan of the running turn as the todo list item of that turn:
 * the first update starts the item, a later one updates it with the whole list,
 * and an update that changes nothing is dropped. A plan update for any other
 * turn is dropped: the turn is over, and its list is no longer live. A plan
 * with more than `MAX_TODO_STEPS` steps leaves the item as it is and returns a
 * warning, because a cut list would show a count that is wrong.
 */
const onPlanUpdated = (state: Normalizing, params: PlanUpdate): ReadonlyArray<HarnessEvent> => {
  if (!Array.isArray(params.plan)) throw new Error("plan is not a list");
  if (params.turnId !== state.openTurnId) return [];
  if (params.plan.length > MAX_TODO_STEPS) {
    // Codex sends the whole plan with every update, so a plan that stays too
    // long would repeat the warning on each one.
    if (state.oversizedPlanTurnId === params.turnId) return [];
    state.oversizedPlanTurnId = params.turnId;
    return [
      buildRuntimeMessage(
        state,
        "runtime.warning",
        `Codex's plan has ${params.plan.length} steps, more than the ${MAX_TODO_STEPS} a todo list can show`,
        params,
        params.turnId,
      ),
    ];
  }
  const steps = buildTodoSteps(params.plan);
  const shown = state.todoList;
  if (shown !== undefined && JSON.stringify(shown.steps) === JSON.stringify(steps)) return [];
  // The id is made from the turn's id, because Codex gives the plan update no
  // item id. A thread has one list per turn, and turn ids are unique, so the id
  // is unique too and the same on every update.
  const itemId = shown?.itemId ?? ensureId(`${params.turnId}:todo`);
  state.todoList = { itemId, turnId: params.turnId, steps };
  const detail: TodoListDetail = { steps };
  const fields = {
    ...buildCodexThreadEnvelope(state),
    ...buildNotificationRaw(params),
    turnId: ensureId(params.turnId),
    itemId,
    kind: "todo_list",
    detail: toJson(detail),
  } as const;
  return [
    shown === undefined ? { _tag: "item.started", ...fields } : { _tag: "item.updated", ...fields },
  ];
};

/**
 * Returns the text of a warning that has a summary and optional details,
 * with the details on the line after the summary and the path of the config
 * file, when there is one, on the line after that. Throws when a field is not
 * text, so the notification is reported as `unknown` and not drawn wrongly.
 */
const buildSummaryText = (params: {
  readonly summary: string;
  readonly details: string | null;
  readonly path?: string;
}): string => {
  const details = params.details == null ? "" : requireText(params.details, "details");
  const path = params.path === undefined ? "" : requireText(params.path, "path");
  return [
    requireText(params.summary, "summary"),
    ...(details === "" ? [] : [details]),
    ...(path === "" ? [] : [`Config file: ${path}`]),
  ].join("\n");
};

/**
 * Builds the warning for a `warning` or `guardianWarning` notification. A
 * warning for one thread names the thread's running turn, so it is drawn inside
 * that turn. A warning with no thread concerns the whole session and names no
 * turn.
 */
const buildThreadWarning = (
  state: Normalizing,
  params: { readonly threadId: string | null; readonly message: string },
): ReadonlyArray<HarnessEvent> => [
  buildRuntimeMessage(
    state,
    "runtime.warning",
    requireText(params.message, "warning message"),
    params,
    params.threadId === null ? undefined : state.openTurnId,
  ),
];

/**
 * Returns a drop decision with the same `reason` for each of `methods`, to be
 * spread into `NOTIFICATION_DECISIONS`. The result's keys are exactly the
 * listed methods, so a method the release does not list is still a type error,
 * and a method left out of the table is still reported as missing.
 */
const dropAll = <const Methods extends ReadonlyArray<NotificationMethod>>(
  reason: string,
  methods: Methods,
): Record<Methods[number], string> =>
  Object.fromEntries(methods.map((method) => [method, reason])) as Record<Methods[number], string>;

/**
 * The decision for every notification method of the pinned Codex release (spec
 * 06 section 6.7). Each entry is checked against the params of its method: a
 * handler takes that method's params type, and a method the release does not
 * list is an error. A Codex upgrade that adds a method fails typecheck until it
 * is listed here. A method that is not here, which a newer Codex can send,
 * becomes a labelled `unknown` item in `normalize`.
 */
const NOTIFICATION_DECISIONS = {
  "turn/started": onTurnStarted,
  "turn/completed": onTurnCompleted,
  "item/started": onItemStarted,
  "item/completed": onItemCompleted,
  "thread/tokenUsage/updated": (state, params) => {
    const usage = countUsageSinceStart(state, params.tokenUsage);
    if (usage === undefined) return [];
    return [
      {
        _tag: "session.usage.updated",
        ...buildCodexThreadEnvelope(state),
        ...buildNotificationRaw(params),
        ...(state.usageIncomplete
          ? { usageReport: { status: "incomplete" as const, counts: usage } }
          : { usage }),
      },
    ];
  },
  error: onError,
  "item/agentMessage/delta": (state, params) => {
    const delta = readDelta(params);
    if (isLateTurn(state, delta.turnId)) {
      reportLateFrame(state, "item/agentMessage/delta", delta.turnId);
      return [];
    }
    if (delta.delta !== "") state.streamedMessages.add(delta.itemId);
    return buildContentDelta(state, delta, "assistant_text");
  },
  "item/commandExecution/outputDelta": (state, params) => {
    const delta = readDelta(params);
    if (isLateTurn(state, delta.turnId)) {
      reportLateFrame(state, "item/commandExecution/outputDelta", delta.turnId);
      return [];
    }
    return buildContentDelta(state, delta, "command_output");
  },
  "item/reasoning/textDelta": (state, params) => buildReasoningDelta(state, params, "raw"),
  "item/reasoning/summaryTextDelta": (state, params) =>
    buildReasoningDelta(state, params, "summary"),
  "turn/plan/updated": onPlanUpdated,
  "model/rerouted": (state, params) => [
    buildRuntimeMessage(
      state,
      "runtime.notice",
      `Codex switched model from ${requireText(params.fromModel, "fromModel")} to ${requireText(params.toModel, "toModel")}`,
      params,
      readRunningTurnId(state, params.turnId),
    ),
  ],
  warning: buildThreadWarning,
  guardianWarning: buildThreadWarning,
  configWarning: (state, params) => [
    buildRuntimeMessage(state, "runtime.warning", buildSummaryText(params), params),
  ],
  deprecationNotice: (state, params) => [
    buildRuntimeMessage(
      state,
      "runtime.warning",
      buildSummaryText({ summary: params.summary, details: params.details }),
      params,
    ),
  ],
  "item/plan/delta":
    "Codex documents that the deltas need not add up to the final plan, and the completed plan item carries the whole text",
  "account/rateLimits/updated":
    "rate limits are not shown yet; a separate piece of work (#625) decides how",
  "account/updated": "account state belongs in the capability snapshot, not in a session",
  "account/login/completed":
    "signing in is done by the runner's login flow, never during a session",
  "thread/started":
    "a thread is introduced by the first frame that names it, which the runner then reads with thread/read",
  "thread/status/changed": "the session's status comes from its turns",
  "thread/deleted": "Hercule never deletes a Codex thread",
  "thread/closed": "the adapter ends the session on it before frames reach this table",
  "thread/reverted": "Hercule never rolls a Codex thread back",
  "thread/name/updated": "Hercule names its threads itself",
  "thread/queue/changed": "Hercule queues a session's input itself, not in Codex",
  "thread/settings/updated": "the settings are the ones Hercule set when it opened the thread",
  "thread/compacted": "deprecated; the contextCompaction item already shows the compaction",
  "skills/changed": "an invalidation signal for a skill list this adapter does not cache",
  "turn/diff/updated": "diffs come from the workspace's checkpoints, not from the harness",
  "turn/moderationMetadata": "moderation metadata is for Codex's own interface, not session output",
  "rawResponseItem/completed": "internal model API data; the items arrive as item/completed",
  "rawResponse/completed": "internal model API data; usage arrives as thread/tokenUsage/updated",
  "item/commandExecution/terminalInteraction":
    "the stdin sent to a running command; the command item shows the command and its output",
  "item/fileChange/outputDelta": "deprecated; Codex no longer sends it",
  "item/fileChange/patchUpdated":
    "the completed fileChange item carries the final patch and its paths",
  "serverRequest/resolved": "confirms a request the adapter has already answered itself",
  "item/mcpToolCall/progress":
    "progress text of a running MCP call; the item shows the call and its result",
  "mcpServer/oauthLogin/completed": "Hercule starts no MCP sign-ins",
  "mcpServer/startupStatus/updated": "the start-up state of an MCP server is not session output",
  "mcpServer/event/stream/notification": "belongs to an MCP subscription Hercule never opens",
  "app/list/updated": "the list of apps is not session output",
  "remoteControl/status/changed": "Hercule does not use Codex remote control",
  "fs/changed": "answers an fs/watch subscription, which Hercule never makes",
  "item/reasoning/summaryPartAdded":
    "only marks where a new summary part starts; its text arrives as summary deltas",
  "model/verification": "tells Codex's own interface about a verification it asks of the user",
  "model/safetyBuffering/updated": "state for Codex's own interface, not session output",
  ...dropAll("Hercule never archives a Codex thread", ["thread/archived", "thread/unarchived"]),
  ...dropAll("Hercule does not use Codex thread goals", [
    "thread/goal/updated",
    "thread/goal/cleared",
  ]),
  ...dropAll("Hercule does not use Codex remote environments", [
    "thread/environment/connected",
    "thread/environment/disconnected",
  ]),
  ...dropAll("Hercule does not use Codex projects", ["project/changed", "thread/project/updated"]),
  ...dropAll("hooks are not shown (spec 06 section 6.7)", ["hook/started", "hook/completed"]),
  ...dropAll(
    "Codex marks the auto-review payload unstable; the reviewed item ends with its own status",
    [
      "item/autoApprovalReview/started",
      "item/autoApprovalReview/completed",
      "autoApprovalReview/strictReviewRequired",
    ],
  ),
  ...dropAll("answers a command/exec or process/spawn request, which Hercule never makes", [
    "command/exec/outputDelta",
    "process/outputDelta",
    "process/exited",
  ]),
  ...dropAll("Hercule never imports another agent's configuration", [
    "externalAgentConfig/import/progress",
    "externalAgentConfig/import/completed",
  ]),
  ...dropAll("a failed recovery arrives as an error notification, which is shown", [
    "modelProvider/authRecoveryStarted",
    "modelProvider/authRecoveryCompleted",
  ]),
  ...dropAll("answers a fuzzy file search, which Hercule never starts", [
    "fuzzyFileSearch/sessionUpdated",
    "fuzzyFileSearch/sessionCompleted",
  ]),
  ...dropAll("Hercule does not use Codex realtime voice", [
    "thread/realtime/started",
    "thread/realtime/itemAdded",
    "thread/realtime/item/started",
    "thread/realtime/item/transcript/delta",
    "thread/realtime/item/completed",
    "thread/realtime/transcript/delta",
    "thread/realtime/transcript/done",
    "thread/realtime/outputAudio/delta",
    "thread/realtime/sdp",
    "thread/realtime/error",
    "thread/realtime/closed",
  ]),
  ...dropAll("a Windows-only message; runners run on macOS and Linux", [
    "windows/worldWritableWarning",
    "windowsSandbox/setupCompleted",
  ]),
} satisfies { readonly [Method in NotificationMethod]: NotificationDecision<Method> };

/**
 * `NOTIFICATION_DECISIONS` read by a method from a frame, which can be anything
 * at runtime. The one cast in the table: TypeScript cannot relate a method read
 * at runtime to the handler type of that method, so every entry is read as a
 * handler of the params of any method. `satisfies` has already checked each
 * entry against its own method.
 */
const DECISIONS_BY_METHOD = NOTIFICATION_DECISIONS as Readonly<
  Record<string, NotificationDecision<NotificationMethod>>
>;

/**
 * Returns the label of the fallback item for a frame. An `item/started` or
 * `item/completed` whose item could not be read is labelled by the item's
 * type, such as `codex: item/sleep`, whenever the type can be read, and any
 * other frame by its method. The params come from the wire and can be anything.
 */
const buildFrameLabel = (frame: NotificationFrame): string => {
  const methodLabel = buildUnknownItemLabel("codex", frame.method);
  if (frame.method !== "item/started" && frame.method !== "item/completed") return methodLabel;
  const params = frame.params;
  if (!isRecord(params) || !isRecord(params.item)) return methodLabel;
  const type = params.item.type;
  return typeof type === "string" && type !== ""
    ? buildUnknownItemLabel("codex", `item/${type}`)
    : methodLabel;
};

/**
 * Returns the events of a fallback `unknown` item for a notification this
 * adapter cannot show: its method has no entry in `NOTIFICATION_DECISIONS`, or
 * its params could not be read (`error` is what failed). The item carries the
 * frame's label, and the whole frame goes in `raw` of its `item.started`. The
 * runner's log hears of it once. An item that is unreadable at its start and
 * again at its completion shows as two rows.
 *
 * One agent never has two turns at once, so where the item goes depends on the
 * thread alone, and never on the turn the frame names:
 *
 * - With a running turn, the item goes in that turn, also when the frame
 *   names another one.
 * - With no running turn, and none asked for whose `turn/started` has not
 *   arrived, the item opens a turn that holds only this item and ends
 *   `completed` right after it (spec 06 section 6.2).
 * - With a turn asked for but not started, the item is not drawn: a turn
 *   opened now would end while the real one is about to start, and the
 *   controller would take the session for idle. The runner's log has the label.
 */
const buildUnknownFrameEvents = (
  state: Normalizing,
  frame: NotificationFrame,
  error?: unknown,
): ReadonlyArray<HarnessEvent> => {
  const label = buildFrameLabel(frame);
  state.reports.reportUnknownMessage(label, error);
  const running = state.openTurnId;
  if (running === undefined && state.isTurnPending()) return [];
  const turnId = running === undefined ? crypto.randomUUID() : ensureId(running);
  const common = {
    ...buildCodexThreadEnvelope(state),
    turnId,
    itemId: crypto.randomUUID(),
    kind: "unknown",
    detail: { label } satisfies UnknownItemDetail,
  } as const;
  const items: ReadonlyArray<HarnessEvent> = [
    { _tag: "item.started", ...common, ...buildNotificationRaw(frame) },
    { _tag: "item.completed", ...common, status: "completed" },
  ];
  if (running !== undefined) return items;
  return [
    { _tag: "turn.started", ...buildCodexThreadEnvelope(state), turnId },
    ...items,
    { _tag: "turn.completed", ...buildCodexThreadEnvelope(state), turnId, state: "completed" },
  ];
};

/**
 * Returns the events that close the row of an item whose `item/completed`
 * could not be read, as a failed item of its kind. Without them the row of an
 * item that started fine would stay running for ever, because the fallback item
 * has an id of its own. Returns nothing when the item's id, type or turn cannot
 * be read, or when its type is not reported as an item.
 */
const failUnreadableCompletion = (
  state: Normalizing,
  frame: NotificationFrame,
): ReadonlyArray<HarnessEvent> => {
  const params = frame.params;
  if (!isRecord(params) || !isRecord(params.item)) return [];
  const { id, type } = params.item;
  const turnId = params.turnId;
  if (typeof id !== "string" || id === "" || typeof turnId !== "string" || turnId === "") return [];
  if (typeof type !== "string" || !Object.hasOwn(ITEM_KINDS, type)) return [];
  const kind = ITEM_KINDS[type as ThreadItem["type"]];
  if (kind === null) return [];
  return [
    {
      _tag: "item.completed",
      ...buildCodexThreadEnvelope(state),
      turnId: ensureId(turnId),
      itemId: ensureId(id),
      kind,
      status: "failed",
    },
  ];
};

/**
 * Converts one decoded notification to normalized events by its entry in
 * `NOTIFICATION_DECISIONS`. A method with no entry, such as one a newer Codex
 * added, becomes a labelled `unknown` item. So does a known method whose params
 * are not what the pinned release promises, because the app-server ships often
 * and a live session must survive a changed field. The one exception is
 * `thread/tokenUsage/updated`: its failure is thrown, because the adapter
 * recovers the usage counters from it.
 */
export const normalize = (
  state: Normalizing,
  frame: NotificationFrame,
): ReadonlyArray<HarnessEvent> => {
  // Only the table's own keys count, so a method named like an object method,
  // such as `constructor`, finds nothing.
  const decision = Object.hasOwn(DECISIONS_BY_METHOD, frame.method)
    ? DECISIONS_BY_METHOD[frame.method]
    : undefined;
  if (decision === undefined) return buildUnknownFrameEvents(state, frame);
  if (typeof decision === "string") return [];
  try {
    return decision(state, frame.params as NotificationParams<NotificationMethod>);
  } catch (error) {
    if (frame.method === "thread/tokenUsage/updated") throw error;
    return [
      ...(frame.method === "item/completed" ? failUnreadableCompletion(state, frame) : []),
      ...buildUnknownFrameEvents(state, frame, error),
    ];
  }
};

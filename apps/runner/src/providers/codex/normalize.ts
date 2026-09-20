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
  type OutputSchema,
  type ProviderEvent,
  type StreamKind,
  type StructuredResult,
  type TurnState,
  type Usage,
} from "@hydra/protocol";
import { count, buildEnvelope, rawOf, type Envelope } from "../normalize";
import { judgeAnswer, type HarnessAnswer } from "../structured-result";
import { idOf } from "../events";
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
const CODEX_NOTIFICATION = "codex.app-server.notification";

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
  /** The schema every turn of this session answers under, if there is one. */
  readonly outputSchema: OutputSchema | undefined;
  /**
   * The last item the running turn completed. The answer is read from this
   * item: Codex constrains the turn's final assistant message, so the answer
   * is that message, and only if the turn ended on it.
   */
  lastCompletedItem: ThreadItem | undefined;
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
});

const envelope = (state: Normalizing): Envelope =>
  buildEnvelope(state.sessionId, { threadId: state.threadId });

/** The notification the event was read off, under this adapter's channel. */
const raw = (payload: unknown): ReturnType<typeof rawOf> => rawOf(CODEX_NOTIFICATION, payload);

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
 * What a file change is about, as the protocol carries it. A change the harness
 * named no file in has nothing for a reader to see, and an empty path is a
 * frame nobody can decode, so it is left out: the adapter's approval card and
 * the item row read the same list.
 */
export const pathsOf = (item: Extract<ThreadItem, { type: "fileChange" }>): ReadonlyArray<string> =>
  item.changes.flatMap((change) => (change.path === "" ? [] : [fact(change.path)]));

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
      const paths = pathsOf(item);
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
    ...envelope(state),
    turnId: idOf(params.turnId),
    itemId: idOf(params.itemId),
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
        ...envelope(state),
        ...raw(params),
        ...turn,
        message: text(`${failure}: ${params.error.message}, which Codex is retrying itself`),
      },
    ];
  }
  return [
    {
      _tag: "runtime.error",
      ...envelope(state),
      ...raw(params),
      ...turn,
      class: failure,
      message: text(params.error.message),
    },
  ];
};

/**
 * Reads what the turn answered under the schema. Codex constrains the final
 * assistant message and nothing else, so the answer is the text of the item
 * the turn ended on, parsed exactly as it was written. A message wrapped in
 * prose or in a code fence is not the constrained output the schema asked for.
 * If this adapter read an answer out of such a message, it would guess at an
 * answer nobody gave.
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

/** The API's own code for a schema it will not constrain the answer on. */
const INVALID_SCHEMA = "invalid_json_schema";

/**
 * The name Codex gives the response format that carries the schema. The
 * refusal's sentence names it. This name is read only where the code cannot be
 * read: a sentence is prose the API may reword, and a code is a contract.
 */
const OUTPUT_SCHEMA_FORMAT_NAME = "codex_output_schema";

/** Parses the error body Codex passes through whole, if the message is one. */
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
 * Reads what the harness said, where the harness failed on the schema itself.
 *
 * The API refuses a schema it cannot enforce before it samples the model.
 * Codex then fails the turn and puts the whole API error body in
 * `turn.error.message`. The body holds an error code and a sentence. The error
 * code `invalid_json_schema` tells this function that the failure is about the
 * schema. The sentence is what this function reports. If the body is not JSON
 * but names the response format `codex_output_schema`, the failure is still
 * about the schema, and the whole message is reported.
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
 * Judges the turn: the verdict it carries about the schema, if it carries one.
 * A turn that ran to its end is judged on what it answered. A turn the harness
 * failed over the schema is a schema failure, in the harness's own words.
 * Every other failure and every interrupt is about the turn itself, and a
 * schema verdict there would claim that an answer was judged and rejected.
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
    return reasoningDelta(state, frame.params as AgentMessageDeltaNotification, reasoning);
  }
  const streamKind = DELTA_STREAMS[frame.method];
  if (streamKind !== undefined) {
    return delta(state, frame.params as AgentMessageDeltaNotification, streamKind);
  }
  switch (frame.method) {
    case "turn/started": {
      const params = frame.params as TurnStartedNotification;
      // Every turn answers for itself. A completion this build could not read,
      // or a completion that never arrived, must not leave the previous turn's
      // item in place as the answer this turn is judged on.
      state.lastCompletedItem = undefined;
      return [
        {
          _tag: "turn.started",
          ...envelope(state),
          ...raw(params),
          turnId: idOf(params.turn.id),
          ...(state.model === undefined ? {} : { model: fact(state.model) }),
        },
      ];
    }
    case "turn/completed": {
      const params = frame.params as TurnCompletedNotification;
      const ended = TURN_STATES[params.turn.status];
      if (ended === undefined) return [];
      const structuredResult = judgeTurn(state, params.turn, ended);
      // The items of a turn that is over cannot stream any more, and their
      // channels are what the map holds.
      state.reasoning.clear();
      state.lastCompletedItem = undefined;
      return [
        {
          _tag: "turn.completed",
          ...envelope(state),
          ...raw(params),
          turnId: idOf(params.turn.id),
          state: ended,
          ...(structuredResult === undefined ? {} : { structuredResult }),
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
          ...envelope(state),
          ...raw(params),
          turnId: idOf(params.turnId),
          itemId: idOf(params.item.id),
          kind,
          ...detail(params.item),
        },
      ];
    }
    case "item/completed": {
      const params = frame.params as ItemCompletedNotification;
      // How far the turn has come, recorded before anything is decided about
      // the item. The echo of the user's own message is also an item the turn
      // completed, and a turn that ends on that echo ended with no answer.
      state.lastCompletedItem = params.item;
      const kind = kindOf(params.item);
      if (kind === null) return [];
      return [
        {
          _tag: "item.completed",
          ...envelope(state),
          ...raw(params),
          turnId: idOf(params.turnId),
          itemId: idOf(params.item.id),
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
          ...envelope(state),
          ...raw(params),
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

/**
 * Converts pi's event lines into normalized provider events. The input is one
 * raw line from pi's stdout and a small mutable state per session; the output
 * is a list of events. Nothing here touches a process or a socket, and the
 * only clock read is the wall clock. Spec 06 section 6 owns the event taxonomy.
 *
 * The line arrives raw, not parsed, because a line that is not JSON must be
 * reported too: pi writes its own error output to the same pipe as its events,
 * and that output must not be silently dropped.
 *
 * The state tracks the session's progress. pi gives no ids to its turns or its
 * content blocks, so the ids that surfaces group a turn's events by are
 * created here. A tool's progress arrives as the whole output so far, so the
 * state keeps what was already sent and reports only the new part.
 */
import type * as Schema from "effect/Schema";
import type {
  ContextCompactionDetail,
  ItemKind,
  OutputSchema,
  ProviderEvent,
  StreamKind,
  StructuredResult,
  SubagentId,
  TurnState,
  UnknownItemDetail,
  Usage,
} from "@hercule/protocol";
import { clampCount, buildEnvelope, buildRaw, type Envelope } from "../normalize";
import { ensureId } from "../events";
import { judgeAnswer } from "../structured-result";
import { buildEditedPathFields } from "../edited-paths";
import { requireText, truncateFact, truncateMessage } from "../text";
import { buildUnknownItemLabel } from "../unknown-items";
import { resolvePiPath } from "./edited-path";
import { SUBAGENT_TOOL, SUBMIT_RESULT_TOOL } from "./extension";

/** The channel name every raw payload from this adapter is reported under. */
const PI_EVENT = "pi.rpc.event";

/** The token counts and cost pi reports on a message. */
interface PiUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: { readonly total?: number };
}

/** The fields of an assistant message that this module reads. */
interface PiMessage {
  readonly role?: unknown;
  readonly content?: ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }>;
  readonly usage?: PiUsage;
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
}

/** A tool call's output so far, in the shape pi's tools return it. */
interface PiToolResult {
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
}

interface PiEvent {
  readonly type?: unknown;
  readonly willRetry?: unknown;
  readonly message?: PiMessage;
  readonly messages?: ReadonlyArray<PiMessage>;
  readonly assistantMessageEvent?: {
    readonly type?: unknown;
    readonly contentIndex?: unknown;
    readonly delta?: unknown;
  };
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly args?: Record<string, unknown>;
  readonly partialResult?: PiToolResult;
  readonly isError?: unknown;
  /** How pi's automatic retry ended, and which extension threw which error. */
  readonly success?: unknown;
  readonly finalError?: unknown;
  readonly error?: unknown;
  readonly extensionPath?: unknown;
  /** Why a compaction ran, how it ended, and what it produced. */
  readonly reason?: unknown;
  readonly result?: unknown;
  readonly aborted?: unknown;
  readonly errorMessage?: unknown;
  /** The numbers of an automatic retry. */
  readonly attempt?: unknown;
  readonly maxAttempts?: unknown;
  readonly delayMs?: unknown;
  /** What an extension asked the UI for: the method, and for a notification its level. */
  readonly method?: unknown;
  readonly notifyType?: unknown;
}

/** An item of the turn that has started and not yet completed. */
interface Running {
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly detail?: Schema.Json;
}

/**
 * A `context_compaction` item that has started and not yet completed. Its
 * detail holds what is known at the start: the trigger.
 */
interface RunningCompaction extends Running {
  readonly kind: "context_compaction";
  readonly detail: ContextCompactionDetail;
  /** The turn the item started in, which the item completes in. */
  readonly turnId: string;
}

/**
 * A running tool item, with the output already reported for it. It keeps pi's
 * tool name, because the approval hook asks about a call after the call has
 * started and the adapter reads the name and kind from this item. It keeps the
 * arguments the call started with for `submit_result`, whose arguments are
 * the turn's answer. An approval request never reads them: pi converts the
 * arguments before the hook runs, so the request is built from the converted
 * command and path in the hook's dialog.
 */
export interface RunningTool extends Running {
  readonly toolName: string;
  readonly args: Record<string, unknown> | undefined;
  seen: string;
  /**
   * The subagent a `subagent` call started, once the adapter started it. The
   * call's `item.completed` lists it in `detail.subagentIds`.
   */
  subagentId?: SubagentId;
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface Normalizing {
  readonly sessionId: string;
  /**
   * The subagent this state normalizes the pi process of, or undefined for the
   * session's own agent. Every event the state produces is attributed to it.
   */
  readonly subagentId: SubagentId | undefined;
  /**
   * The home directory of the environment pi runs in. A file path that starts
   * with `~` is read against it.
   */
  readonly home: string;
  /**
   * Tells the runner's log about a message that became an `unknown` item. Its
   * arguments are the item's label and, when the message's fields could not be
   * read, what failed. The session's subagents share the session's function.
   */
  readonly reportUnknownEvent: (label: string, error?: unknown) => void;
  /** The native session id, put on every event so a surface can link the two sessions. */
  readonly nativeSessionId: string;
  /**
   * The model the session is running on. pi's events include no model until a
   * message ends, so the adapter, which chose the model, sets this.
   */
  model: string | undefined;
  /**
   * The id of the turn in flight. The adapter creates it when it sends an
   * input, so the user's message and every event pi emits for it share one id.
   */
  turnId: string | undefined;
  /** The assistant's open content blocks, by the index pi streams them under. */
  readonly blocks: Map<number, Running>;
  /** The tool calls in flight, by pi's own call id. */
  readonly tools: Map<string, RunningTool>;
  /**
   * The calls the user declined, by pi's own call id. pi reports a blocked call
   * as an ordinary error, and without this set the user's own decision would
   * be shown back to them as a failure.
   */
  readonly declined: Set<string>;
  /**
   * Usage summed three ways: over the pi runs of the current turn, over this
   * agent's whole process, and over the whole session. Every agent of a
   * session shares one `sessionTotals` object, so the session's total counts
   * each subagent too, also after the subagent has ended.
   */
  readonly turnTotals: Totals;
  readonly agentTotals: Totals;
  readonly sessionTotals: Totals;
  /**
   * The text of the last assistant message of the current turn, or "" when it
   * has written none yet. A subagent's reply to its parent is this text.
   */
  lastAssistantText: string;
  /**
   * How the last assistant message stopped, which decides how the turn ends:
   * pi reports an abort or a failure on the message, not on the settle.
   */
  stopped: { readonly state: TurnState; readonly error?: string };
  /**
   * Why the runner ended this turn, if it did. The runner, not pi, is "the
   * system" here.
   *
   * pi reports an abort during a tool call as an error on the message in
   * flight ("The operation was aborted"), which does not say why the turn
   * ended. So the reason is recorded here:
   *
   * - `interrupt`: the user stopped the turn;
   * - `schema`: the runner ended the turn after too many rejected answers.
   *   The turn counts as completed, and its result reports the schema failure.
   */
  endedBySystem: "interrupt" | "schema" | undefined;
  /**
   * Whether `turn.started` has been emitted for this turn. pi starts a new run
   * for a retry, a compaction or a queued message, all inside one turn, so
   * later runs do not start a new turn and their cost adds to the same total.
   */
  announced: boolean;
  /**
   * Whether the turn in flight was opened by the normalizer for output that
   * belongs to no input, such as a compaction that runs between turns, and not
   * by an input. pi's `agent_start` clears it: the turn is then the user's.
   * A synthetic turn is not judged against the output schema, because nobody
   * asked it for an answer.
   */
  synthetic: boolean;
  /**
   * Whether Hercule's extension cancels this agent's automatic compactions
   * (the session's own pi with auto-compaction off, never a subagent's). The
   * cancellation is Hercule's own policy, not a failure, so pi's start and end
   * events of such a compaction show nothing. The adapter sets it.
   */
  automaticCompactionCancelled: boolean;
  /** The compaction in flight, if any. pi runs at most one at a time. */
  compaction: RunningCompaction | undefined;
  /** The error already reported for this run, so it is not reported twice. */
  reported: string | undefined;
  /** The output schema every turn of this session must answer with, if any. */
  readonly outputSchema: OutputSchema | undefined;
  /**
   * The turn's answer: the arguments of its `submit_result` call, if it made
   * one. A turn that settles with no answer is re-prompted.
   */
  answer: Record<string, unknown> | undefined;
  /** How many times this turn has been re-prompted to call `submit_result`. */
  reprompts: number;
  /**
   * How many of this turn's answers pi rejected because the arguments do not
   * match the schema. A model that cannot satisfy the schema keeps retrying
   * for as long as it is allowed to, so the adapter limits the retries.
   */
  refusedAnswers: number;
}

const createZeroTotals = (): Totals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

export const buildNormalizingState = (
  sessionId: string,
  nativeSessionId: string,
  outputSchema: OutputSchema | undefined,
  home: string,
  reportUnknownEvent: Normalizing["reportUnknownEvent"],
): Normalizing => ({
  sessionId,
  subagentId: undefined,
  home,
  reportUnknownEvent,
  nativeSessionId,
  model: undefined,
  turnId: undefined,
  blocks: new Map(),
  tools: new Map(),
  declined: new Set(),
  turnTotals: createZeroTotals(),
  agentTotals: createZeroTotals(),
  sessionTotals: createZeroTotals(),
  lastAssistantText: "",
  stopped: { state: "completed" },
  endedBySystem: undefined,
  announced: false,
  synthetic: false,
  automaticCompactionCancelled: false,
  compaction: undefined,
  reported: undefined,
  outputSchema,
  answer: undefined,
  reprompts: 0,
  refusedAnswers: 0,
});

/**
 * Returns the state for a subagent's pi process in the session `session`
 * normalizes. The subagent runs on the session's current model and adds its
 * usage to the session's total. It has no output schema: only the session's
 * own agent answers with one.
 */
export const buildSubagentState = (session: Normalizing, subagentId: SubagentId): Normalizing => ({
  ...buildNormalizingState(
    session.sessionId,
    session.nativeSessionId,
    undefined,
    session.home,
    session.reportUnknownEvent,
  ),
  subagentId,
  model: session.model,
  sessionTotals: session.sessionTotals,
});

/** Returns the fields every event of this agent starts with: the session's envelope and the agent's attribution. */
const buildAgentEnvelope = (
  state: Normalizing,
): Envelope & { readonly subagentId?: SubagentId } => ({
  ...buildSessionEnvelope(state),
  ...(state.subagentId === undefined ? {} : { subagentId: state.subagentId }),
});

/** Returns the session's envelope with no attribution, for an event about the whole session. */
const buildSessionEnvelope = (state: Normalizing): Envelope =>
  buildEnvelope(state.sessionId, { nativeSessionId: state.nativeSessionId });

/** Returns the `raw` field for an event: the pi payload it came from, under this adapter's channel. */
const buildLineRaw = (payload: unknown): ReturnType<typeof buildRaw> => buildRaw(PI_EVENT, payload);

/**
 * Returns the id of the turn in flight, creating one if there is none. pi
 * starts runs without an id, and an event that arrives before the adapter sent
 * an input still has to belong to a turn.
 */
const ensureTurnId = (state: Normalizing): string => (state.turnId ??= crypto.randomUUID());

const addUsage = (totals: Totals, usage: PiUsage | undefined): void => {
  if (usage === undefined) return;
  totals.input += clampCount(usage.input);
  totals.output += clampCount(usage.output);
  totals.cacheRead += clampCount(usage.cacheRead);
  totals.cacheWrite += clampCount(usage.cacheWrite);
  const cost = usage.cost?.total;
  totals.cost += typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : 0;
};

const buildUsage = (totals: Totals): Usage => ({
  inputTokens: totals.input,
  outputTokens: totals.output,
  cacheReadTokens: totals.cacheRead,
  cacheWriteTokens: totals.cacheWrite,
  costUsd: totals.cost,
});

const resetTotals = (totals: Totals): void => {
  totals.input = 0;
  totals.output = 0;
  totals.cacheRead = 0;
  totals.cacheWrite = 0;
  totals.cost = 0;
};

/** Returns the message that ended the run: the last assistant message in the event. */
const findLastAssistant = (event: PiEvent): PiMessage | undefined => {
  const messages = event.messages ?? [];
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message?.role === "assistant") return message;
  }
  return event.message;
};

/** Returns the text parts of an assistant message joined into one string, or "" when it has none. */
const readMessageText = (message: PiMessage | undefined): string =>
  (message?.content ?? [])
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");

/**
 * Returns how a turn ends, based on the stop reason of its last message:
 * interrupted for an abort, failed with pi's error message for an error, and
 * completed for anything else (a normal stop, a tool call, a length limit).
 */
const classifyStop = (message: PiMessage | undefined): Normalizing["stopped"] => {
  const reason = message?.stopReason;
  if (reason === "aborted") return { state: "interrupted" };
  if (reason !== "error") return { state: "completed" };
  const complaint = message?.errorMessage;
  return {
    state: "failed",
    ...(typeof complaint === "string" && complaint !== "" ? { error: complaint } : {}),
  };
};

/**
 * Builds a `runtime.error` event for a failure that does not end the turn. It
 * uses pi's own error message and a class name for what failed, so an error
 * type this build does not know still reaches the user.
 */
const buildRuntimeError = (state: Normalizing, name: string, message: string): ProviderEvent => ({
  _tag: "runtime.error",
  ...buildAgentEnvelope(state),
  ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
  class: truncateFact(name),
  ...(message === "" ? {} : { message: truncateMessage(message) }),
});

const readText = (value: unknown): string => (typeof value === "string" ? value : "");

/** How a turn the runner ended is reported, whatever pi says about the message. */
const SYSTEM_ENDINGS: Readonly<
  Record<NonNullable<Normalizing["endedBySystem"]>, Normalizing["stopped"]>
> = {
  interrupt: { state: "interrupted" },
  // The turn ran to its end and answered. The answer is what failed, and the
  // turn's result reports that.
  schema: { state: "completed" },
};

/**
 * Records how the run stopped, keeping the worst outcome seen so far. pi
 * reports an abort or an error only on the message it happened to. Without
 * this, a later message that stopped normally would make the turn look
 * completed.
 */
const recordStop = (state: Normalizing, message: PiMessage | undefined): void => {
  const ended =
    state.endedBySystem === undefined ? classifyStop(message) : SYSTEM_ENDINGS[state.endedBySystem];
  if (ended.state !== "completed" || state.stopped.state === "completed") state.stopped = ended;
};

/**
 * Returns a warning when the model's message was cut off at its output limit.
 * This is not a failure, so the turn still completes.
 */
const warnIfCutOff = (
  state: Normalizing,
  message: PiMessage | undefined,
): ReadonlyArray<ProviderEvent> =>
  message?.stopReason === "length"
    ? [
        buildRuntimeWarning(
          state,
          "the model stopped at its output limit, so its answer is cut short",
        ),
      ]
    : [];

/**
 * Builds a `runtime.warning` (something went wrong, but the session goes on) or
 * a `runtime.notice` (neutral information). Both name the turn in flight, if
 * there is one, and never open a turn.
 */
const buildRuntimeMessage = (
  state: Normalizing,
  tag: "runtime.warning" | "runtime.notice",
  message: string,
): ProviderEvent => ({
  _tag: tag,
  ...buildAgentEnvelope(state),
  ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
  message: truncateMessage(message),
});

const buildRuntimeWarning = (state: Normalizing, message: string): ProviderEvent =>
  buildRuntimeMessage(state, "runtime.warning", message);

/** The two kinds of streamed assistant content, and the item kind and stream kind of each. */
const BLOCKS: Readonly<
  Record<string, { readonly kind: ItemKind; readonly streamKind: StreamKind }>
> = {
  text: { kind: "assistant_message", streamKind: "assistant_text" },
  thinking: { kind: "reasoning", streamKind: "reasoning_text" },
};

/**
 * The item kinds of pi's built-in tools and of the runner's `subagent` tool.
 * Any other tool is a `tool_call`. Only the table's own keys count, so a tool
 * named like an object method, such as `constructor`, is still a `tool_call`.
 */
const TOOL_KINDS: Readonly<Record<string, ItemKind>> = {
  [SUBAGENT_TOOL]: "subagent",
  bash: "command_execution",
  powershell: "command_execution",
  edit: "file_change",
  write: "file_change",
  read: "file_read",
  grep: "file_search",
  find: "file_search",
  ls: "file_search",
};

/**
 * Returns a tool call's string argument cut to the fact bound, or `undefined`
 * when the argument is missing, not a string, or empty.
 */
export const readFactArg = (
  args: Record<string, unknown> | undefined,
  name: string,
): string | undefined => {
  const value = args?.[name];
  return typeof value === "string" && value !== "" ? truncateFact(value) : undefined;
};

/**
 * Builds the detail a row shows for a tool item. The full arguments are in
 * `raw`.
 *
 * - A subagent shows the task it was given.
 * - A file read shows the fixed field `path`, and a file search the fixed
 *   fields `pattern` and `path`, each left out when the call did not give it.
 *   `ls` has no pattern, and a search with no path covers the workspace. The
 *   tool's name is kept beside them, so a row still has a label when both are
 *   missing.
 * - A file change shows the edited path in the fixed field `path`, whole and
 *   as pi reads it (see `resolvePiPath`). When the path is missing or
 *   longer than the fact bound, it shows the tool's name instead.
 * - Any other tool shows its command, else its file path, else its name.
 */
const buildToolDetail = (
  kind: ItemKind,
  toolName: string,
  args: Record<string, unknown> | undefined,
  home: string,
): Schema.Json => {
  const description = args?.["description"];
  if (kind === "subagent" && typeof description === "string") {
    return { name: truncateFact(toolName), description: truncateMessage(description) };
  }
  if (kind === "file_read" || kind === "file_search") {
    // `ls` takes no pattern. pi accepts one anyway and ignores it, so showing
    // it would claim a filter that never ran.
    const pattern =
      kind === "file_search" && toolName !== "ls" ? readFactArg(args, "pattern") : undefined;
    const path = readFactArg(args, "path");
    return {
      name: truncateFact(toolName),
      ...(pattern === undefined ? {} : { pattern }),
      ...(path === undefined ? {} : { path }),
    };
  }
  if (kind === "file_change") {
    const edited = args?.["path"];
    const fields =
      typeof edited === "string" ? buildEditedPathFields([resolvePiPath(edited, home)]) : undefined;
    return fields ?? { name: truncateFact(toolName) };
  }
  const command = args?.["command"];
  if (typeof command === "string") return { command: truncateMessage(command) };
  const path = readFactArg(args, "path");
  return path === undefined ? { name: truncateFact(toolName) } : { path };
};

/** Returns a tool's output so far as one string. */
const readToolOutput = (result: PiToolResult | undefined): string =>
  (result?.content ?? []).map((part) => part.text ?? "").join("");

const onBlockEvent = (state: Normalizing, event: PiEvent): ReadonlyArray<ProviderEvent> => {
  const delta = event.assistantMessageEvent;
  const type = typeof delta?.type === "string" ? delta.type : "";
  const index = typeof delta?.contentIndex === "number" ? delta.contentIndex : -1;
  const [channel, phase] = [
    type.slice(0, type.lastIndexOf("_")),
    type.slice(type.lastIndexOf("_") + 1),
  ];
  // Only the table's own keys count: a block type such as `constructor_start`
  // would otherwise find an object method and start an item with no kind.
  const block = Object.hasOwn(BLOCKS, channel) ? BLOCKS[channel] : undefined;
  if (block === undefined) return [];
  const turnId = ensureTurnId(state);
  if (phase === "start") {
    const itemId = crypto.randomUUID();
    state.blocks.set(index, { itemId, kind: block.kind });
    return [
      { _tag: "item.started", ...buildAgentEnvelope(state), turnId, itemId, kind: block.kind },
    ];
  }
  const running = state.blocks.get(index);
  if (running === undefined) return [];
  if (phase === "end") {
    state.blocks.delete(index);
    return [
      {
        _tag: "item.completed",
        ...buildAgentEnvelope(state),
        turnId,
        itemId: running.itemId,
        kind: running.kind,
        status: "completed",
      },
    ];
  }
  return typeof delta?.delta === "string" && delta.delta !== ""
    ? [
        {
          _tag: "content.delta",
          ...buildAgentEnvelope(state),
          turnId,
          itemId: running.itemId,
          streamKind: block.streamKind,
          delta: delta.delta,
        },
      ]
    : [];
};

const onToolStart = (state: Normalizing, event: PiEvent): ReadonlyArray<ProviderEvent> => {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  const kind = Object.hasOwn(TOOL_KINDS, toolName) ? TOOL_KINDS[toolName]! : "tool_call";
  const item: RunningTool = {
    // A call with no id from pi gets a new one. Giving two such calls the same
    // id would put the second call's output on the first call's row.
    itemId: callId === "" ? crypto.randomUUID() : ensureId(callId),
    kind,
    detail: buildToolDetail(kind, toolName, event.args, state.home),
    toolName,
    args: event.args,
    seen: "",
  };
  // Store the item under pi's call id, or under the new id when pi gave none.
  // Otherwise every call without an id would share the "" key.
  state.tools.set(callId === "" ? item.itemId : callId, item);
  return [
    {
      _tag: "item.started",
      ...buildAgentEnvelope(state),
      ...buildLineRaw(event),
      turnId: ensureTurnId(state),
      itemId: item.itemId,
      kind: item.kind,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
    },
  ];
};

const onToolUpdate = (state: Normalizing, event: PiEvent): ReadonlyArray<ProviderEvent> => {
  const item = state.tools.get(typeof event.toolCallId === "string" ? event.toolCallId : "");
  if (item === undefined) return [];
  const output = readToolOutput(event.partialResult);
  // pi sends the whole output so far, so only the part after what was already
  // reported is new; sending the whole snapshot would repeat it. A snapshot
  // that does not continue the previous one is sent whole, because there is
  // nothing to append it to.
  const delta = output.startsWith(item.seen) ? output.slice(item.seen.length) : output;
  item.seen = output;
  return delta === ""
    ? []
    : [
        {
          _tag: "content.delta",
          ...buildAgentEnvelope(state),
          turnId: ensureTurnId(state),
          itemId: item.itemId,
          streamKind: "command_output",
          delta,
        },
      ];
};

const onToolEnd = (state: Normalizing, event: PiEvent): ReadonlyArray<ProviderEvent> => {
  const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  const item = state.tools.get(callId);
  if (item === undefined) return [];
  state.tools.delete(callId);
  // This is the `submit_result` call, and its arguments are the turn's
  // answer. The extension registered the tool with this same schema. The
  // arguments come from the call's start event, not this end event, because
  // pi only includes a call's arguments when the call starts.
  if (state.outputSchema !== undefined && item.toolName === SUBMIT_RESULT_TOOL) {
    state.answer = item.args ?? {};
    // pi validates the call against the tool's schema, and returns a
    // validation error to the model as the call's result.
    if (event.isError === true) state.refusedAnswers += 1;
  }
  const refused = state.declined.delete(callId);
  return [
    {
      _tag: "item.completed",
      ...buildAgentEnvelope(state),
      ...buildLineRaw(event),
      turnId: ensureTurnId(state),
      itemId: item.itemId,
      kind: item.kind,
      status: refused ? "declined" : event.isError === true ? "failed" : "completed",
      ...buildCompletedDetail(item),
    },
  ];
};

/**
 * Returns the detail an item's `item.completed` carries: its own detail, plus
 * the subagent it started when it is a `subagent` call that started one.
 */
const buildCompletedDetail = (item: Running & { readonly subagentId?: SubagentId }) => {
  if (item.subagentId === undefined)
    return item.detail === undefined ? {} : { detail: item.detail };
  const detail = typeof item.detail === "object" && item.detail !== null ? item.detail : {};
  return { detail: { ...detail, subagentIds: [item.subagentId] } };
};

/**
 * Completes, as failed, every item still running when the turn ends: a block
 * pi stopped mid-stream, a tool whose result never came, or a compaction that
 * never ended. Returns the
 * `item.completed` events. An item nobody completes would show a spinner for
 * the rest of the session.
 */
const failOpenItems = (state: Normalizing, turnId: string): ReadonlyArray<ProviderEvent> => {
  const open = [
    ...state.blocks.values(),
    ...state.tools.values(),
    ...(state.compaction === undefined ? [] : [state.compaction]),
  ];
  state.blocks.clear();
  state.tools.clear();
  state.compaction = undefined;
  // These calls will never report an end, so their declined marks are dropped too.
  state.declined.clear();
  return open.map((item) => ({
    _tag: "item.completed",
    ...buildAgentEnvelope(state),
    turnId,
    itemId: item.itemId,
    kind: item.kind,
    status: "failed",
    ...buildCompletedDetail(item),
  }));
};

/**
 * Returns the turn's structured result, or undefined when there is none. Only
 * a completed turn of a session with an output schema has one: its answer, or
 * the lack of one, is validated against the schema. An interrupted or failed
 * turn gets no result, because a schema failure there would wrongly suggest
 * that an answer was checked and rejected. A synthetic turn gets none either:
 * no input asked it for an answer.
 */
const judgeTurn = (state: Normalizing, ended: TurnState): StructuredResult | undefined => {
  const schema = state.outputSchema;
  if (schema === undefined || ended !== "completed" || state.synthetic) return undefined;
  return judgeAnswer(
    schema,
    state.answer === undefined
      ? { missing: `the agent finished without calling ${SUBMIT_RESULT_TOOL}` }
      : { value: state.answer },
  );
};

/**
 * Builds the usage events an agent's state reports: the session's total, and
 * before it, for a subagent, the subagent's own count. The session total
 * includes every agent of the session, so it is reported whichever agent
 * changed it. Exported because the adapter also reports a subagent's count
 * when the session ends while the subagent runs.
 */
export const buildUsageEvents = (state: Normalizing): ReadonlyArray<ProviderEvent> => [
  ...(state.subagentId === undefined
    ? []
    : [
        {
          _tag: "session.usage.updated" as const,
          ...buildAgentEnvelope(state),
          usage: buildUsage(state.agentTotals),
        },
      ]),
  {
    _tag: "session.usage.updated",
    ...buildSessionEnvelope(state),
    usage: buildUsage(state.sessionTotals),
  },
];

/**
 * Ends the turn in flight and every item still running in it, and resets the
 * turn state. `ended` overrides how the turn ended. Returns the closing
 * events, or none when no turn is in flight. Exported because the adapter
 * also ends the turn when pi exits mid-turn, and only the adapter sees the
 * process exit.
 */
export const endTurn = (
  state: Normalizing,
  ended?: Normalizing["stopped"],
): ReadonlyArray<ProviderEvent> => {
  const turnId = state.turnId;
  if (turnId === undefined) return [];
  const stopped = ended ?? state.stopped;
  const cost = state.turnTotals.cost;
  const closing = failOpenItems(state, turnId);
  const structuredResult = judgeTurn(state, stopped.state);
  state.turnId = undefined;
  state.announced = false;
  state.synthetic = false;
  state.reported = undefined;
  state.stopped = { state: "completed" };
  state.endedBySystem = undefined;
  // The answer and the retry counts belong to this turn. The next turn starts
  // from zero.
  state.answer = undefined;
  state.reprompts = 0;
  state.refusedAnswers = 0;
  return [
    ...closing,
    ...buildUsageEvents(state),
    {
      _tag: "turn.completed",
      ...buildAgentEnvelope(state),
      turnId,
      state: stopped.state,
      usage: buildUsage(state.agentTotals),
      costUsd: cost,
      ...(stopped.error === undefined ? {} : { error: truncateMessage(stopped.error) }),
      ...(structuredResult === undefined ? {} : { structuredResult }),
    },
  ];
};

/** Returns a field pi sent as a finite number. Throws when it is anything else. */
const requireNumber = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${what} is not a number`);
  return value;
};

/** Returns the count when pi sent a number, and `undefined` otherwise. */
const readTokenCount = (value: unknown): number | undefined =>
  typeof value === "number" ? clampCount(value) : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Announces the turn in flight: emits its `turn.started` and starts its totals
 * from zero. Called once per turn, by whichever event needs the turn announced
 * first.
 */
const announceTurn = (state: Normalizing): ProviderEvent => {
  state.announced = true;
  resetTotals(state.turnTotals);
  state.lastAssistantText = "";
  return {
    _tag: "turn.started",
    ...buildAgentEnvelope(state),
    turnId: ensureTurnId(state),
    ...(state.model === undefined ? {} : { model: truncateFact(state.model) }),
  };
};

/**
 * Returns a turn an item can go in, with the events that announce it, which is
 * none when the turn is already announced. There are three cases:
 *
 * - pi announced the turn: it is used as it is, and its totals stay.
 * - The adapter created the turn for an input, and pi has not announced it
 *   yet. This happens when pi compacts the conversation before it starts the
 *   run. The turn is announced here, and pi's `agent_start` later finds it
 *   announced and adds nothing. The input's turn stays one turn.
 * - No turn exists. The normalizer opens a synthetic turn. `synthetic` tells
 *   the caller that it opened this turn, and so is the one to close it.
 */
const ensureAnnouncedTurn = (
  state: Normalizing,
): {
  readonly turnId: string;
  readonly opening: ReadonlyArray<ProviderEvent>;
  readonly synthetic: boolean;
} => {
  if (state.announced) return { turnId: ensureTurnId(state), opening: [], synthetic: false };
  const synthetic = state.turnId === undefined;
  if (synthetic) state.synthetic = true;
  const started = announceTurn(state);
  return { turnId: ensureTurnId(state), opening: [started], synthetic };
};

/**
 * Builds the events of a message nobody decided how to show, or whose fields
 * could not be read (`error` is what failed): an `unknown` item with a label,
 * holding the raw message. The item goes in the open turn. When no turn is
 * open, it goes in a synthetic turn that closes right after it, because
 * nothing else would close that turn (spec 06 section 6.2). The runner's log
 * hears of the label once.
 */
const buildUnknownItem = (
  state: Normalizing,
  event: unknown,
  label: string,
  error?: unknown,
): ReadonlyArray<ProviderEvent> => {
  state.reportUnknownEvent(label, error);
  const turn = ensureAnnouncedTurn(state);
  const itemId = crypto.randomUUID();
  const detail: UnknownItemDetail = { label };
  return [
    ...turn.opening,
    {
      _tag: "item.started",
      ...buildAgentEnvelope(state),
      ...buildLineRaw(event),
      turnId: turn.turnId,
      itemId,
      kind: "unknown",
      detail,
    },
    {
      _tag: "item.completed",
      ...buildAgentEnvelope(state),
      turnId: turn.turnId,
      itemId,
      kind: "unknown",
      status: "completed",
      detail,
    },
    ...(turn.synthetic ? endTurn(state, { state: "completed" }) : []),
  ];
};

/** How pi's reason for a compaction maps to the trigger a client shows. */
const COMPACTION_TRIGGERS: Readonly<Record<string, "auto" | "manual">> = {
  manual: "manual",
  threshold: "auto",
  overflow: "auto",
};

/**
 * Returns the compaction in flight, starting one when there is none. The
 * second value is the events that started it: no events when one was already
 * running, so a repeated `compaction_start` adds nothing. The item goes in the
 * turn `ensureAnnouncedTurn` returns, and leaves that turn's totals alone.
 * `reason` is pi's reason for the compaction; one this build does not know
 * leaves the trigger out.
 */
const ensureCompaction = (
  state: Normalizing,
  reason: unknown,
): { readonly running: RunningCompaction; readonly events: Array<ProviderEvent> } => {
  if (state.compaction !== undefined) return { running: state.compaction, events: [] };
  const turn = ensureAnnouncedTurn(state);
  const trigger =
    typeof reason === "string" && Object.hasOwn(COMPACTION_TRIGGERS, reason)
      ? COMPACTION_TRIGGERS[reason]
      : undefined;
  const detail: ContextCompactionDetail = trigger === undefined ? {} : { trigger };
  const running: RunningCompaction = {
    itemId: crypto.randomUUID(),
    kind: "context_compaction",
    detail,
    turnId: turn.turnId,
  };
  state.compaction = running;
  return {
    running,
    events: [
      ...turn.opening,
      {
        _tag: "item.started",
        ...buildAgentEnvelope(state),
        turnId: turn.turnId,
        itemId: running.itemId,
        kind: running.kind,
        detail,
      },
    ],
  };
};

/**
 * Checks whether a compaction event is one Hercule's extension cancels: an
 * automatic compaction (any reason but `manual`) of an agent whose automatic
 * compactions are cancelled. pi sends the start and the end of a cancelled
 * compaction as usual, and neither is shown.
 */
const isCancelledByPolicy = (state: Normalizing, event: PiEvent): boolean =>
  state.automaticCompactionCancelled && event.reason !== "manual";

/** Handles `compaction_start`: shows a running `context_compaction` item. */
const onCompactionStart: PiEventHandler = (state, event) =>
  isCancelledByPolicy(state, event) ? [] : ensureCompaction(state, event.reason).events;

/**
 * Handles `compaction_end`: completes the running item. The item completes as
 * `completed` only when pi reports a result and the compaction was not
 * aborted, and then carries pi's token counts and summary. Any other end
 * completes it as `failed`, and when pi gives an error message, a warning
 * repeats it, because the item has no field for an error. An end with no
 * start before it, which pi sends when overflow recovery fails, shows a
 * failed item that starts and ends here. A synthetic turn that held the
 * compaction closes right after it.
 */
const onCompactionEnd: PiEventHandler = (state, event) => {
  if (isCancelledByPolicy(state, event)) return [];
  const { running, events } = ensureCompaction(state, event.reason);
  state.compaction = undefined;
  const result = isRecord(event.result) ? event.result : undefined;
  const succeeded = result !== undefined && event.aborted !== true;
  const summary = result?.["summary"];
  const tokensBefore = readTokenCount(result?.["tokensBefore"]);
  const tokensAfter = readTokenCount(result?.["estimatedTokensAfter"]);
  const detail: ContextCompactionDetail = succeeded
    ? {
        ...running.detail,
        ...(tokensBefore === undefined ? {} : { tokensBefore }),
        ...(tokensAfter === undefined ? {} : { tokensAfter }),
        ...(typeof summary === "string" && summary !== ""
          ? { summary: truncateMessage(summary) }
          : {}),
      }
    : running.detail;
  events.push({
    _tag: "item.completed",
    ...buildAgentEnvelope(state),
    turnId: running.turnId,
    itemId: running.itemId,
    kind: running.kind,
    status: succeeded ? "completed" : "failed",
    detail,
  });
  const complaint = readText(event.errorMessage);
  if (!succeeded && complaint !== "") events.push(buildRuntimeWarning(state, complaint));
  if (state.synthetic) events.push(...endTurn(state, { state: "completed" }));
  return events;
};

/**
 * Handles `auto_retry_start`: warns that pi retries after an error. pi sends it
 * once per retry, right before the wait. The `willRetry` flag on `agent_end`
 * predicts the same retry, so only this event warns. Throws when the numbers
 * or the error message are missing.
 */
const onAutoRetryStart: PiEventHandler = (state, event) => {
  const attempt = requireNumber(event.attempt, "auto_retry_start attempt");
  const maxAttempts = requireNumber(event.maxAttempts, "auto_retry_start maxAttempts");
  const delayMs = requireNumber(event.delayMs, "auto_retry_start delayMs");
  const error = requireText(event.errorMessage, "auto_retry_start errorMessage");
  return [
    buildRuntimeWarning(
      state,
      `pi is retrying after an error (attempt ${attempt} of ${maxAttempts}, in ${Math.round(delayMs / 100) / 10}s): ${error}`,
    ),
  ];
};

/**
 * Handles an extension's `notify` request. A notification of level `warning` or
 * `error` becomes a `runtime.warning`, because the extension says something is
 * wrong. Any other level, or none, becomes a `runtime.notice`. An empty message
 * shows nothing. Throws when the message is not text.
 */
const onNotify: PiEventHandler = (state, event) => {
  const fields: { readonly message?: unknown } = event;
  const message = requireText(fields.message, "notify message");
  if (message === "") return [];
  const level = event.notifyType === "warning" || event.notifyType === "error";
  return [buildRuntimeMessage(state, level ? "runtime.warning" : "runtime.notice", message)];
};

/**
 * Every `method` of pi's `extension_ui_request` in pi 1.3, as the RPC mode
 * writes it (`rpc-mode.js`, `createExtensionUIContext`).
 */
type PiUiMethod =
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "set_editor_text"
  | "select"
  | "confirm"
  | "input"
  | "editor";

/** What the adapter does with one UI request method: a handler, or the reason it shows nothing. */
const PI_UI_METHOD_DECISIONS = {
  notify: onNotify,
  setStatus: "a status line in pi's terminal footer is not session output",
  setWidget: "a widget in pi's terminal UI is not session output",
  setTitle: "the terminal window title is not session output",
  set_editor_text: "it fills pi's terminal editor, which Hercule does not have",
  select: "dialogs are not shown yet (#900)",
  editor: "dialogs are not shown yet (#900)",
  confirm:
    "the approval dialog of Hercule's extension; the adapter answers it before the normalizer sees it",
  input:
    "an input dialog; the adapter handles the one Hercule's subagent tool opens, and other dialogs are not shown yet (#900)",
} satisfies Record<PiUiMethod, PiEventDecision>;

const UI_DECISIONS_BY_METHOD: Readonly<Record<string, PiEventDecision>> = PI_UI_METHOD_DECISIONS;

/**
 * Handles `extension_ui_request`: looks up the request's method in
 * `PI_UI_METHOD_DECISIONS`. A method this build does not know becomes an
 * `unknown` item labelled `pi: extension_ui_request/<method>`. Throws when the
 * method is not text.
 */
const onExtensionUiRequest: PiEventHandler = (state, event) => {
  const method = requireText(event.method, "extension_ui_request method");
  const decision = Object.hasOwn(UI_DECISIONS_BY_METHOD, method)
    ? UI_DECISIONS_BY_METHOD[method]
    : undefined;
  if (decision === undefined) {
    return buildUnknownItem(
      state,
      event,
      buildUnknownItemLabel("pi", `extension_ui_request/${method}`),
    );
  }
  return typeof decision === "string" ? [] : decision(state, event);
};

const onAgentStart: PiEventHandler = (state) => {
  // A synthetic turn that is still open (a compaction runs) is now the user's:
  // the compaction must not close it.
  state.synthetic = false;
  // pi starts a new run for a retry, a compaction or a queued message, all
  // within the current turn. Emitting `turn.started` again would split one
  // turn in two, and resetting the totals would lose what the earlier
  // runs already cost.
  return state.announced ? [] : [announceTurn(state)];
};

const onTurnEnd: PiEventHandler = (state, event) => {
  // pi reports usage per assistant message and its tool calls, so both the
  // turn's cost and the session's are summed here.
  addUsage(state.turnTotals, event.message?.usage);
  addUsage(state.agentTotals, event.message?.usage);
  addUsage(state.sessionTotals, event.message?.usage);
  // A message that only calls tools has no text, and the reply is the
  // last message that says something.
  const text = readMessageText(event.message);
  if (text !== "") state.lastAssistantText = text;
  recordStop(state, event.message);
  return warnIfCutOff(state, event.message);
};

const onAgentEnd: PiEventHandler = (state, event) => {
  // pi is about to run again in the same turn, so ending the turn here would
  // report it as over while it is still going. The retry itself is shown by
  // the `auto_retry_start` that follows.
  if (event.willRetry === true) return [];
  recordStop(state, findLastAssistant(event));
  // pi will not retry this run. If it ended on an error, the turn records
  // the failed state, and this event reports the error itself.
  if (state.stopped.state !== "failed") return warnIfCutOff(state, findLastAssistant(event));
  state.reported = state.stopped.error ?? "";
  return [buildRuntimeError(state, "agent_error", state.reported)];
};

const onAutoRetryEnd: PiEventHandler = (state, event) => {
  // pi gave up retrying. That ends the attempts, not the turn: the settle
  // that follows ends the turn. pi emits this after the `agent_end` with the
  // same error, so an error already reported there is not reported again.
  if (event.success !== false) return [];
  return readText(event.finalError) === state.reported
    ? []
    : [buildRuntimeError(state, "auto_retry_failed", readText(event.finalError))];
};

// Hercule's extension is the only one a session loads, so this means the
// approval hook threw. Report it, so the user does not mistake it for a
// silent allow.
const onExtensionError: PiEventHandler = (state, event) => [
  buildRuntimeError(state, "extension_error", readText(event.error)),
];

/**
 * Every `type` of event that pi 1.3 writes to its RPC stdout and that can
 * reach `normalize`: the `AgentSessionEvent` union (`core/agent-session.d.ts`)
 * and the two frames the RPC mode adds (`modes/rpc/rpc-mode.js`). The `response`
 * frames are not here: `makeRpc` answers them and never passes them on.
 */
type PiEventType =
  | "agent_start"
  | "agent_end"
  | "agent_settled"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "queue_update"
  | "entry_appended"
  | "session_info_changed"
  | "thinking_level_changed"
  | "compaction_start"
  | "compaction_end"
  | "auto_retry_start"
  | "auto_retry_end"
  | "summarization_retry_scheduled"
  | "summarization_retry_attempt_start"
  | "summarization_retry_finished"
  | "bash_execution_update"
  | "extension_ui_request"
  | "extension_error";

/** What the adapter does with one kind of pi event: a handler that returns its events, or the reason nothing is shown. */
type PiEventHandler = (state: Normalizing, event: PiEvent) => ReadonlyArray<ProviderEvent>;
type PiEventDecision = PiEventHandler | string;

/**
 * The decision for every pi event (spec 06 section 6.7). Checked when the code
 * is compiled: an entry missing for a `PiEventType` is an error. pi has no
 * type package this build depends on, so adding a type to `PiEventType` after
 * reading a new pi release is what makes the compiler ask for its decision. A
 * type that is not here, which a newer pi can send, becomes a labelled
 * `unknown` item in `normalize`.
 */
const PI_EVENT_DECISIONS = {
  agent_start: onAgentStart,
  agent_end: onAgentEnd,
  agent_settled: (state) => endTurn(state),
  turn_end: onTurnEnd,
  message_update: onBlockEvent,
  tool_execution_start: onToolStart,
  tool_execution_update: onToolUpdate,
  tool_execution_end: onToolEnd,
  compaction_start: onCompactionStart,
  compaction_end: onCompactionEnd,
  auto_retry_start: onAutoRetryStart,
  auto_retry_end: onAutoRetryEnd,
  extension_ui_request: onExtensionUiRequest,
  extension_error: onExtensionError,
  turn_start:
    "pi's turn is one model call; the Hercule turn runs from agent_start to agent_settled",
  message_start: "message_update opens each block; a user message is shown from the input",
  message_end: "message_update closes each block, and turn_end carries the usage",
  queue_update: "the lists of queued steering and follow-up messages are not session output",
  entry_appended: "it only reports a write to pi's session file",
  session_info_changed: "Hercule names its sessions itself",
  thinking_level_changed: "the thinking level is a setting, not session output",
  summarization_retry_scheduled:
    "it is a retry inside the summary call of a compaction or a branch summary; the compaction item shows how it ended",
  summarization_retry_attempt_start:
    "it is a retry inside the summary call of a compaction or a branch summary; the compaction item shows how it ended",
  summarization_retry_finished:
    "it is a retry inside the summary call of a compaction or a branch summary; the compaction item shows how it ended",
  bash_execution_update: "it streams a `bash` RPC command, which the adapter never sends",
} satisfies Record<PiEventType, PiEventDecision>;

/**
 * `PI_EVENT_DECISIONS` read by a type from an event, which can be anything at
 * runtime. `satisfies` has already checked each entry against its own key.
 */
const DECISIONS_BY_TYPE: Readonly<Record<string, PiEventDecision>> = PI_EVENT_DECISIONS;

export const normalize = (
  state: Normalizing,
  line: string,
  /**
   * The line already parsed as JSON, when the caller has parsed it. When it
   * is left out, the line is parsed here; a line that is not JSON also
   * arrives without it.
   */
  decoded?: unknown,
): ReadonlyArray<ProviderEvent> => {
  let event: PiEvent;
  if (decoded === undefined) {
    try {
      event = JSON.parse(line) as PiEvent;
    } catch {
      // One unreadable line must not end the session, and skipping it silently
      // would hide pi's own error output, which goes to this pipe too. The
      // warning gives only the line's length, not its content, because the
      // line could just as well contain a credential in a stack trace.
      return [
        buildRuntimeWarning(
          state,
          `pi wrote a line of ${line.length} characters that is not a valid event`,
        ),
      ];
    }
  } else {
    event = decoded as PiEvent;
  }
  // Only the table's own keys count: a type named like an object method, such
  // as `constructor`, must not find one.
  const type = typeof event?.type === "string" ? event.type : undefined;
  const label = buildUnknownItemLabel("pi", type ?? "event with no type");
  const decision =
    type !== undefined && Object.hasOwn(DECISIONS_BY_TYPE, type)
      ? DECISIONS_BY_TYPE[type]
      : undefined;
  // New pi releases add event types, and a live session must survive one
  // this build does not know.
  if (decision === undefined) return buildUnknownItem(state, event, label);
  if (typeof decision === "string") return [];
  try {
    return decision(state, event);
  } catch (error) {
    // A known type whose fields are not what pi 1.3 sends. The handlers that
    // check their fields do so before they change the state.
    return buildUnknownItem(state, event, label, error);
  }
};

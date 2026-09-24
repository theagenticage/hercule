/**
 * Converts pi's event lines into normalized provider events (spec 06 section
 * 6). The input is one raw line from pi's stdout and a small mutable state per
 * session; the output is a list of events. Nothing here touches a process or a
 * socket, and the only clock read is the wall clock.
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
  ItemKind,
  OutputSchema,
  ProviderEvent,
  StreamKind,
  StructuredResult,
  TurnState,
  Usage,
} from "@hercule/protocol";
import { clampCount, buildEnvelope, buildRaw, type Envelope } from "../normalize";
import { ensureId } from "../events";
import { judgeAnswer } from "../structured-result";
import { truncateFact, truncateMessage } from "../text";
import { SUBMIT_RESULT_TOOL } from "./extension";

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
}

/** An item of the turn that has started and not yet completed. */
interface Running {
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly detail?: Schema.Json;
}

/**
 * A running tool item, with the output already reported for it. It keeps pi's
 * tool name and the call's arguments, because the approval hook asks about a
 * call after the call has started: the adapter builds the approval request
 * from the waiting call's name and arguments.
 */
export interface RunningTool extends Running {
  readonly toolName: string;
  readonly args: Record<string, unknown> | undefined;
  seen: string;
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
  /** Usage summed over the pi turns of the current Hercule turn, and of the whole session. */
  readonly turnTotals: Totals;
  readonly sessionTotals: Totals;
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
): Normalizing => ({
  sessionId,
  nativeSessionId,
  model: undefined,
  turnId: undefined,
  blocks: new Map(),
  tools: new Map(),
  declined: new Set(),
  turnTotals: createZeroTotals(),
  sessionTotals: createZeroTotals(),
  stopped: { state: "completed" },
  endedBySystem: undefined,
  announced: false,
  reported: undefined,
  outputSchema,
  answer: undefined,
  reprompts: 0,
  refusedAnswers: 0,
});

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

const toUsage = (totals: Totals): Usage => ({
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
  ...buildSessionEnvelope(state),
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

const buildRuntimeWarning = (state: Normalizing, message: string): ProviderEvent => ({
  _tag: "runtime.warning",
  ...buildSessionEnvelope(state),
  ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
  message: truncateMessage(message),
});

/** The two kinds of streamed assistant content, and the item kind and stream kind of each. */
const BLOCKS: Readonly<
  Record<string, { readonly kind: ItemKind; readonly streamKind: StreamKind }>
> = {
  text: { kind: "assistant_message", streamKind: "assistant_text" },
  thinking: { kind: "reasoning", streamKind: "reasoning_text" },
};

/** The item kinds of pi's built-in tools. Any other tool is a `tool_call`. */
const TOOL_KINDS: Readonly<Record<string, ItemKind>> = {
  bash: "command_execution",
  powershell: "command_execution",
  edit: "file_change",
  write: "file_change",
};

/**
 * Builds the one detail field a row shows for a tool item: the command, the
 * file path, or else the tool name. The full arguments are in `raw`.
 */
const buildToolDetail = (
  toolName: string,
  args: Record<string, unknown> | undefined,
): Schema.Json => {
  const command = args?.["command"];
  if (typeof command === "string") return { command: truncateMessage(command) };
  const path = args?.["path"];
  if (typeof path === "string") return { path: truncateFact(path) };
  return { name: truncateFact(toolName) };
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
  const block = BLOCKS[channel];
  if (block === undefined) return [];
  const turnId = ensureTurnId(state);
  if (phase === "start") {
    const itemId = crypto.randomUUID();
    state.blocks.set(index, { itemId, kind: block.kind });
    return [
      { _tag: "item.started", ...buildSessionEnvelope(state), turnId, itemId, kind: block.kind },
    ];
  }
  const running = state.blocks.get(index);
  if (running === undefined) return [];
  if (phase === "end") {
    state.blocks.delete(index);
    return [
      {
        _tag: "item.completed",
        ...buildSessionEnvelope(state),
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
          ...buildSessionEnvelope(state),
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
  const kind = TOOL_KINDS[toolName] ?? "tool_call";
  const item: RunningTool = {
    // A call with no id from pi gets a new one. Giving two such calls the same
    // id would put the second call's output on the first call's row.
    itemId: callId === "" ? crypto.randomUUID() : ensureId(callId),
    kind,
    detail: buildToolDetail(toolName, event.args),
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
      ...buildSessionEnvelope(state),
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
          ...buildSessionEnvelope(state),
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
      ...buildSessionEnvelope(state),
      ...buildLineRaw(event),
      turnId: ensureTurnId(state),
      itemId: item.itemId,
      kind: item.kind,
      status: refused ? "declined" : event.isError === true ? "failed" : "completed",
      ...(item.detail === undefined ? {} : { detail: item.detail }),
    },
  ];
};

/**
 * Completes, as failed, every item still running when the turn ends: a block
 * pi stopped mid-stream, or a tool whose result never came. Returns the
 * `item.completed` events. An item nobody completes would show a spinner for
 * the rest of the session.
 */
const failOpenItems = (state: Normalizing, turnId: string): ReadonlyArray<ProviderEvent> => {
  const open = [...state.blocks.values(), ...state.tools.values()];
  state.blocks.clear();
  state.tools.clear();
  // These calls will never report an end, so their declined marks are dropped too.
  state.declined.clear();
  return open.map((item) => ({
    _tag: "item.completed",
    ...buildSessionEnvelope(state),
    turnId,
    itemId: item.itemId,
    kind: item.kind,
    status: "failed",
    ...(item.detail === undefined ? {} : { detail: item.detail }),
  }));
};

/**
 * Returns the turn's structured result, or undefined when there is none. Only
 * a completed turn of a session with an output schema has one: its answer, or
 * the lack of one, is validated against the schema. An interrupted or failed
 * turn gets no result, because a schema failure there would wrongly suggest
 * that an answer was checked and rejected.
 */
const judgeTurn = (state: Normalizing, ended: TurnState): StructuredResult | undefined => {
  const schema = state.outputSchema;
  if (schema === undefined || ended !== "completed") return undefined;
  return judgeAnswer(
    schema,
    state.answer === undefined
      ? { missing: `the agent finished without calling ${SUBMIT_RESULT_TOOL}` }
      : { value: state.answer },
  );
};

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
    {
      _tag: "session.usage.updated",
      ...buildSessionEnvelope(state),
      usage: toUsage(state.sessionTotals),
    },
    {
      _tag: "turn.completed",
      ...buildSessionEnvelope(state),
      turnId,
      state: stopped.state,
      usage: toUsage(state.sessionTotals),
      costUsd: cost,
      ...(stopped.error === undefined ? {} : { error: truncateMessage(stopped.error) }),
      ...(structuredResult === undefined ? {} : { structuredResult }),
    },
  ];
};

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
  switch (event.type) {
    case "agent_start": {
      // pi starts a new run for a retry, a compaction or a queued message, all
      // within the current turn. Emitting `turn.started` again would split one
      // turn in two, and resetting the totals would lose what the earlier
      // runs already cost.
      if (state.announced) return [];
      state.announced = true;
      resetTotals(state.turnTotals);
      const turnId = ensureTurnId(state);
      return [
        {
          _tag: "turn.started",
          ...buildSessionEnvelope(state),
          turnId,
          ...(state.model === undefined ? {} : { model: truncateFact(state.model) }),
        },
      ];
    }
    case "turn_end":
      // pi reports usage per assistant message and its tool calls, so both the
      // turn's cost and the session's are summed here.
      addUsage(state.turnTotals, event.message?.usage);
      addUsage(state.sessionTotals, event.message?.usage);
      recordStop(state, event.message);
      return warnIfCutOff(state, event.message);
    case "agent_end":
      // pi is about to run again in the same turn, so ending the turn here
      // would report it as over while it is still going.
      if (event.willRetry === true) {
        return [buildRuntimeWarning(state, "pi hit an error and is retrying by itself")];
      }
      recordStop(state, findLastAssistant(event));
      // pi will not retry this run. If it ended on an error, the turn records
      // the failed state, and this event reports the error itself.
      if (state.stopped.state !== "failed") return warnIfCutOff(state, findLastAssistant(event));
      state.reported = state.stopped.error ?? "";
      return [buildRuntimeError(state, "agent_error", state.reported)];
    case "agent_settled":
      return endTurn(state);
    case "auto_retry_end":
      // pi gave up retrying. That ends the attempts, not the turn: the settle
      // that follows ends the turn. pi emits this after the `agent_end` with
      // the same error, so an error already reported there is not reported
      // again.
      if (event.success !== false) return [];
      return readText(event.finalError) === state.reported
        ? []
        : [buildRuntimeError(state, "auto_retry_failed", readText(event.finalError))];
    case "extension_error":
      // Hercule's extension is the only one a session loads, so this means the
      // approval hook threw. Report it, so the user does not mistake it for a
      // silent allow.
      return [buildRuntimeError(state, "extension_error", readText(event.error))];
    case "message_update":
      return onBlockEvent(state, event);
    case "tool_execution_start":
      return onToolStart(state, event);
    case "tool_execution_update":
      return onToolUpdate(state, event);
    case "tool_execution_end":
      return onToolEnd(state, event);
    default:
      // New pi releases add event types, and a live session must survive one
      // this build does not know.
      return [];
  }
};

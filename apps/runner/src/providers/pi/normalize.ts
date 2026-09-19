/**
 * pi's event lines turned into the one normalized taxonomy (spec 06 section
 * 6): one raw line off stdout plus a small mutable per-session state in,
 * events out. It reads no process, no clock but the wall one, and no socket.
 *
 * The line arrives raw rather than decoded, because a line that is not JSON is
 * one of the things reported here: pi writes its own complaints down the same
 * pipe as its events, and one of them must not pass for silence.
 *
 * The state is a running position. pi names neither its turns nor its content
 * blocks, so the ids every surface brackets a turn by are minted here; and a
 * tool's progress arrives as the whole output so far, so what was already sent
 * is held to turn the next snapshot into the piece that is new.
 */
import type * as Schema from "effect/Schema";
import type { ItemKind, ProviderEvent, StreamKind, TurnState, Usage } from "@hydra/protocol";
import { count, enveloped, rawOf, type Envelope } from "../normalize";
import { idOf } from "../events";
import { fact, text } from "../text";

/** The one channel every raw payload from this adapter is filed under. */
const PI_EVENT = "pi.rpc.event";

/** Token counts and cost as pi reports them on a message. */
interface PiUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: { readonly total?: number };
}

/** One assistant message, as far as anything here reads it. */
interface PiMessage {
  readonly role?: unknown;
  readonly usage?: PiUsage;
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
}

/** What a tool call produced so far, in the shape pi's tools answer with. */
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
  /** What pi's own retry ended as, and which extension threw what. */
  readonly success?: unknown;
  readonly finalError?: unknown;
  readonly error?: unknown;
  readonly extensionPath?: unknown;
}

/** What one item of a turn is, once it has been started. */
interface Running {
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly detail?: Schema.Json;
}

/**
 * A tool item, and the output already reported for it. It keeps pi's own name
 * for the tool and the arguments it was called with, because a call the gate
 * holds is asked about after it started: what the question is called and what
 * the card shows are read off the call that is waiting.
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
  /** The native session, named on every event so a surface can join the two. */
  readonly nativeSessionId: string;
  /**
   * The model the session is running on. pi's events carry none until a
   * message ends, and the adapter is the party that chose it.
   */
  model: string | undefined;
  /**
   * The turn in flight. The adapter mints one for the input it sends, so the
   * user's own message and everything pi says about it share an id.
   */
  turnId: string | undefined;
  /** The assistant's content blocks, by the index pi streams them under. */
  readonly blocks: Map<number, Running>;
  /** The tool calls in flight, by pi's own call id. */
  readonly tools: Map<string, RunningTool>;
  /**
   * The calls the user refused, by pi's own call id. pi reports a blocked call
   * as an ordinary error, and a refusal read as a failure is the user's own
   * answer shown back to them as something that went wrong.
   */
  readonly declined: Set<string>;
  /** Summed over the pi turns of this Hydra turn, and of the session. */
  readonly turnTotals: Totals;
  readonly sessionTotals: Totals;
  /**
   * How the last assistant message stopped, which is how the turn ends: pi
   * reports an abort and a failure on the message, not on the settle.
   */
  stopped: { readonly state: TurnState; readonly error?: string };
  /**
   * Whether this turn has been announced. pi opens a run again for a retry, a
   * compaction and a queued message, all inside one turn, so the second and
   * third are not a turn of their own and their cost adds to the same total.
   */
  announced: boolean;
  /** The failure already reported for this run, so it is not reported twice. */
  reported: string | undefined;
}

const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export const normalizing = (sessionId: string, nativeSessionId: string): Normalizing => ({
  sessionId,
  nativeSessionId,
  model: undefined,
  turnId: undefined,
  blocks: new Map(),
  tools: new Map(),
  declined: new Set(),
  turnTotals: zero(),
  sessionTotals: zero(),
  stopped: { state: "completed" },
  announced: false,
  reported: undefined,
});

const envelope = (state: Normalizing): Envelope =>
  enveloped(state.sessionId, { nativeSessionId: state.nativeSessionId });

/** The line the event was read off, under the channel this adapter files. */
const raw = (payload: unknown): ReturnType<typeof rawOf> => rawOf(PI_EVENT, payload);

/**
 * The turn everything is filed under. pi opens a run without naming it, so an
 * event that arrives before the adapter sent anything still belongs to a turn.
 */
const turnOf = (state: Normalizing): string => (state.turnId ??= crypto.randomUUID());

const add = (totals: Totals, usage: PiUsage | undefined): void => {
  if (usage === undefined) return;
  totals.input += count(usage.input);
  totals.output += count(usage.output);
  totals.cacheRead += count(usage.cacheRead);
  totals.cacheWrite += count(usage.cacheWrite);
  const cost = usage.cost?.total;
  totals.cost += typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : 0;
};

const usageOf = (totals: Totals): Usage => ({
  inputTokens: totals.input,
  outputTokens: totals.output,
  cacheReadTokens: totals.cacheRead,
  cacheWriteTokens: totals.cacheWrite,
  costUsd: totals.cost,
});

const reset = (totals: Totals): void => {
  totals.input = 0;
  totals.output = 0;
  totals.cacheRead = 0;
  totals.cacheWrite = 0;
  totals.cost = 0;
};

/** The message that ended the run: pi's own last assistant one. */
const lastAssistant = (event: PiEvent): PiMessage | undefined => {
  const messages = event.messages ?? [];
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message?.role === "assistant") return message;
  }
  return event.message;
};

/**
 * How a turn ends, read off the message that ended it. Anything else - a stop,
 * a tool call, a length cap - is a turn that ran to its end.
 */
const stoppedBy = (message: PiMessage | undefined): Normalizing["stopped"] => {
  const reason = message?.stopReason;
  if (reason === "aborted") return { state: "interrupted" };
  if (reason !== "error") return { state: "completed" };
  const said = message?.errorMessage;
  return { state: "failed", ...(typeof said === "string" && said !== "" ? { error: said } : {}) };
};

/**
 * Something went wrong that the turn does not end on: pi's own words, under
 * the name pi gave the thing that failed, so a class this build has not heard
 * of still reaches the user.
 */
const failure = (state: Normalizing, name: string, message: string): ProviderEvent => ({
  _tag: "runtime.error",
  ...envelope(state),
  ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
  class: fact(name),
  ...(message === "" ? {} : { message: text(message) }),
});

const said = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Keeps the worst of what ended the run. An abort or an error is announced on
 * the message that carried it, and a later message that merely stopped would
 * otherwise report the turn as having finished normally.
 */
const stopping = (state: Normalizing, message: PiMessage | undefined): void => {
  const ended = stoppedBy(message);
  if (ended.state !== "completed" || state.stopped.state === "completed") state.stopped = ended;
};

/** An answer pi cut at the model's output limit, which is not a failure. */
const cutOff = (
  state: Normalizing,
  message: PiMessage | undefined,
): ReadonlyArray<ProviderEvent> =>
  message?.stopReason === "length"
    ? [warning(state, "the model stopped at its output limit, so its answer is cut short")]
    : [];

const warning = (state: Normalizing, message: string): ProviderEvent => ({
  _tag: "runtime.warning",
  ...envelope(state),
  ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
  message: text(message),
});

/** The two streamed kinds of assistant content, and the item each one is. */
const BLOCKS: Readonly<
  Record<string, { readonly kind: ItemKind; readonly streamKind: StreamKind }>
> = {
  text: { kind: "assistant_message", streamKind: "assistant_text" },
  thinking: { kind: "reasoning", streamKind: "reasoning_text" },
};

/** pi's built-in tools in the taxonomy's vocabulary; everything else is a call. */
const TOOL_KINDS: Readonly<Record<string, ItemKind>> = {
  bash: "command_execution",
  powershell: "command_execution",
  edit: "file_change",
  write: "file_change",
};

/**
 * The one field of a tool item a reader wants in a row: what the command ran,
 * what the patch touched, what the tool was called. `raw` holds the rest.
 */
const toolDetail = (toolName: string, args: Record<string, unknown> | undefined): Schema.Json => {
  const command = args?.["command"];
  if (typeof command === "string") return { command: text(command) };
  const path = args?.["path"];
  if (typeof path === "string") return { path: fact(path) };
  return { name: fact(toolName) };
};

/** What a tool has produced so far, as one piece of text. */
const outputOf = (result: PiToolResult | undefined): string =>
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
  const turnId = turnOf(state);
  if (phase === "start") {
    const itemId = crypto.randomUUID();
    state.blocks.set(index, { itemId, kind: block.kind });
    return [{ _tag: "item.started", ...envelope(state), turnId, itemId, kind: block.kind }];
  }
  const running = state.blocks.get(index);
  if (running === undefined) return [];
  if (phase === "end") {
    state.blocks.delete(index);
    return [
      {
        _tag: "item.completed",
        ...envelope(state),
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
          ...envelope(state),
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
    // A call pi named nothing gets an id of its own: filing two of them under
    // one id would make the second's output land on the first's row.
    itemId: callId === "" ? crypto.randomUUID() : idOf(callId),
    kind,
    detail: toolDetail(toolName, event.args),
    toolName,
    args: event.args,
    seen: "",
  };
  // Held under the id it was given, or the one minted for it: an entry under
  // the empty string would be every unnamed call's entry.
  state.tools.set(callId === "" ? item.itemId : callId, item);
  return [
    {
      _tag: "item.started",
      ...envelope(state),
      ...raw(event),
      turnId: turnOf(state),
      itemId: item.itemId,
      kind: item.kind,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
    },
  ];
};

const onToolUpdate = (state: Normalizing, event: PiEvent): ReadonlyArray<ProviderEvent> => {
  const item = state.tools.get(typeof event.toolCallId === "string" ? event.toolCallId : "");
  if (item === undefined) return [];
  const output = outputOf(event.partialResult);
  // pi's snapshot is the whole output so far, so only the piece past what was
  // already reported is new: sending the snapshot would print it all again. A
  // snapshot that is not a continuation of the last one is sent whole, because
  // there is nothing to append it to.
  const delta = output.startsWith(item.seen) ? output.slice(item.seen.length) : output;
  item.seen = output;
  return delta === ""
    ? []
    : [
        {
          _tag: "content.delta",
          ...envelope(state),
          turnId: turnOf(state),
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
  const refused = state.declined.delete(callId);
  return [
    {
      _tag: "item.completed",
      ...envelope(state),
      ...raw(event),
      turnId: turnOf(state),
      itemId: item.itemId,
      kind: item.kind,
      status: refused ? "declined" : event.isError === true ? "failed" : "completed",
      ...(item.detail === undefined ? {} : { detail: item.detail }),
    },
  ];
};

/**
 * The items that were still running when the turn ended. An item nobody closes
 * is a row that spins for the rest of the session, so a block pi stopped
 * mid-stream and a tool whose result never came are reported as failed.
 */
const abandoned = (state: Normalizing, turnId: string): ReadonlyArray<ProviderEvent> => {
  const open = [...state.blocks.values(), ...state.tools.values()];
  state.blocks.clear();
  state.tools.clear();
  // A call nobody will report the end of takes its answer with it.
  state.declined.clear();
  return open.map((item) => ({
    _tag: "item.completed",
    ...envelope(state),
    turnId,
    itemId: item.itemId,
    kind: item.kind,
    status: "failed",
    ...(item.detail === undefined ? {} : { detail: item.detail }),
  }));
};

/**
 * Ends the turn in flight, with everything still running under it. Exported
 * because a pi that died mid-turn ends it too, and the adapter is the only
 * party that hears the process go.
 */
export const ending = (
  state: Normalizing,
  ended?: Normalizing["stopped"],
): ReadonlyArray<ProviderEvent> => {
  const turnId = state.turnId;
  if (turnId === undefined) return [];
  const stopped = ended ?? state.stopped;
  const cost = state.turnTotals.cost;
  const closing = abandoned(state, turnId);
  state.turnId = undefined;
  state.announced = false;
  state.reported = undefined;
  state.stopped = { state: "completed" };
  return [
    ...closing,
    { _tag: "session.usage.updated", ...envelope(state), usage: usageOf(state.sessionTotals) },
    {
      _tag: "turn.completed",
      ...envelope(state),
      turnId,
      state: stopped.state,
      usage: usageOf(state.sessionTotals),
      costUsd: cost,
      ...(stopped.error === undefined ? {} : { error: text(stopped.error) }),
    },
  ];
};

export const normalize = (
  state: Normalizing,
  line: string,
  /**
   * The line already decoded, where the caller had to decode it anyway. A
   * caller with nothing to hand over leaves it out and the line is decoded
   * here, which is also how a line that is not JSON arrives.
   */
  decoded?: unknown,
): ReadonlyArray<ProviderEvent> => {
  let event: PiEvent;
  if (decoded === undefined) {
    try {
      event = JSON.parse(line) as PiEvent;
    } catch {
      // One unreadable line must not take the session down: pi writes its own
      // complaints down this pipe too, and a silent skip would hide them.
      // Reported by its size rather than its content: a line pi could not
      // frame is as likely to be a credential in a stack trace as a complaint.
      return [warning(state, `pi wrote a line of ${line.length} characters that is not an event`)];
    }
  } else {
    event = decoded as PiEvent;
  }
  switch (event.type) {
    case "agent_start": {
      // pi runs again for a retry, for a compaction and for a queued message,
      // all under the turn it is already on: announcing it again would bracket
      // one episode twice, and clearing the totals would throw away what the
      // earlier attempts already cost.
      if (state.announced) return [];
      state.announced = true;
      reset(state.turnTotals);
      const turnId = turnOf(state);
      return [
        {
          _tag: "turn.started",
          ...envelope(state),
          turnId,
          ...(state.model === undefined ? {} : { model: fact(state.model) }),
        },
      ];
    }
    case "turn_end":
      // One assistant message and its tools, which is where pi prices its
      // work: both the turn's own cost and the session's run through here.
      add(state.turnTotals, event.message?.usage);
      add(state.sessionTotals, event.message?.usage);
      stopping(state, event.message);
      return cutOff(state, event.message);
    case "agent_end":
      // pi is about to run again under the same turn, so ending it here would
      // report an episode as over while it is still going.
      if (event.willRetry === true) {
        return [warning(state, "pi hit an error it is retrying by itself")];
      }
      stopping(state, lastAssistant(event));
      // A run pi will not retry, that ended on an error: the turn carries the
      // state, and this is what went wrong under it.
      if (state.stopped.state !== "failed") return cutOff(state, lastAssistant(event));
      state.reported = state.stopped.error ?? "";
      return [failure(state, "agent_error", state.reported)];
    case "agent_settled":
      return ending(state);
    case "auto_retry_end":
      // pi gave up retrying, which is the end of the attempts rather than of
      // the turn: the settle that follows is what ends that. pi emits this
      // after the `agent_end` carrying the same message, so a failure already
      // reported off that message is not reported a second time.
      if (event.success !== false) return [];
      return said(event.finalError) === state.reported
        ? []
        : [failure(state, "auto_retry_failed", said(event.finalError))];
    case "extension_error":
      // Hydra's own extension is the only one a session loads, so this is a
      // gate that threw: the user hears it rather than reading a quiet allow.
      return [failure(state, "extension_error", said(event.error))];
    case "message_update":
      return onBlockEvent(state, event);
    case "tool_execution_start":
      return onToolStart(state, event);
    case "tool_execution_update":
      return onToolUpdate(state, event);
    case "tool_execution_end":
      return onToolEnd(state, event);
    default:
      // pi grows events between releases, and a live session must survive one
      // this build has not heard of.
      return [];
  }
};

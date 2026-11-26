/**
 * Turns the steps of `agy`'s subagents, read from their transcripts, into
 * normalized harness events attributed to each subagent. It is the second
 * normalizer of the adapter, beside `normalize.ts`, which handles the
 * session's own agent from ACP. The two never share a turn or an item: an
 * event of a subagent never changes the session's own state (spec 06 section
 * 13.1).
 *
 * The input is one step and one small mutable state per session; the output is
 * a list of events. This module does no I/O, but like `normalize.ts` it is not
 * pure: it mints ids and reads the clock through `buildEnvelope`.
 *
 * `agy` has no turn for a subagent, so this module supplies them:
 *
 * - A turn opens at the subagent's first model step (a `PLANNER_RESPONSE`)
 *   with none open. The input that started it (the parent's launch message, or
 *   a later message to the subagent) is shown as the turn's `user_message`.
 * - A turn ends `completed` at a model step with no tool calls. `agy`'s own
 *   swarm monitor ends a subagent's turn the same way.
 * - `agy` writes a step only when it has finished, so every item starts and
 *   completes in the same step, except a tool item, which completes at the
 *   later step that holds the call's result.
 */
import type { HarnessEvent, ItemStatus, SubagentId, Usage } from "@hercule/protocol";
import { buildEnvelope } from "../normalize";
import { buildUserMessage } from "../events";
import { truncateFact, truncateMessage } from "../text";
import type { AgyStep, AgySubagentLink } from "./session-files";
import { buildFailedToolItem, buildToolItem, type ToolCallFields } from "./tool-items";

/** The token counts of one scope (a turn, or the process), added up. */
interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** A tool item that has started and has no result yet. */
interface PendingTool {
  readonly itemId: string;
  readonly call: ToolCallFields;
}

/** A turn of a subagent that is open. */
interface OpenTurn {
  readonly id: string;
  readonly usage: Totals;
  hasUsage: boolean;
  /** Whether the turn has shown its `runtime.warning` for a model error. */
  warned: boolean;
}

/** One subagent: its own turn and item state, kept apart from every other agent. */
interface Subagent {
  readonly subagentId: SubagentId;
  readonly parentSubagentId: SubagentId | undefined;
  /** Whether `subagent.started` was sent for it in this process. */
  introduced: boolean;
  /**
   * What the parent told the subagent when it started it, until the first
   * message from a conversation is read. The launch message is also the
   * transcript's first step, and this text replaces the step's wrapped copy.
   */
  launchBrief: string | undefined;
  /** The input that the next turn opens with, when one is waiting. */
  pendingInput: string | undefined;
  turn: OpenTurn | undefined;
  /** The tool items of the last model step, in call order, that have no result yet. */
  pending: PendingTool[];
  /** The item of each `invoke_subagent` call, by the step that holds its result. */
  readonly launchItems: Map<number, string>;
  readonly processUsage: Totals;
}

/**
 * The state of one session's subagents. Build it with `buildSubagentsState`.
 * Nothing outside this module reads its fields.
 */
export interface SubagentsState {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  /** The subagents this process may get steps of, by conversation id. */
  readonly agents: Map<string, Subagent>;
}

const buildZeroTotals = (): Totals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });

const buildUsage = (totals: Totals): Usage => ({
  inputTokens: totals.inputTokens,
  outputTokens: totals.outputTokens,
  cacheReadTokens: totals.cacheReadTokens,
  cacheWriteTokens: 0,
});

const buildSubagent = (input: {
  readonly subagentId: SubagentId;
  readonly parentSubagentId: SubagentId | undefined;
  readonly launchBrief: string | undefined;
}): Subagent => ({
  ...input,
  introduced: false,
  pendingInput: undefined,
  turn: undefined,
  pending: [],
  launchItems: new Map(),
  processUsage: buildZeroTotals(),
});

/**
 * Returns the state for a new session. `known` are the subagents of an earlier
 * process of the session (`continue.subagents`), so that a subagent which works
 * again lands on its own record.
 */
export const buildSubagentsState = (input: {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly known: ReadonlyArray<{
    readonly subagentId: string;
    readonly parentSubagentId?: string | undefined;
  }>;
}): SubagentsState => ({
  sessionId: input.sessionId,
  nativeSessionId: input.nativeSessionId,
  agents: new Map(
    input.known.map((known) => [
      known.subagentId,
      buildSubagent({
        subagentId: known.subagentId,
        parentSubagentId: known.parentSubagentId,
        launchBrief: undefined,
      }),
    ]),
  ),
});

// ---- Event builders ----

/** Returns the fields every event of `agent` has. */
const buildBase = (state: SubagentsState, agent: Subagent) => ({
  ...buildEnvelope(state.sessionId, { nativeSessionId: state.nativeSessionId }),
  subagentId: agent.subagentId,
});

/**
 * Returns `subagent.started` for `agent`. The event belongs to the agent that
 * started it, so it has no `subagentId` field of its own (spec 06 section 13.2).
 */
const buildSubagentStarted = (
  state: SubagentsState,
  agent: Subagent,
  details: { readonly itemId?: string; readonly link?: AgySubagentLink },
): HarnessEvent => {
  const { role, typeName } = details.link ?? {};
  return {
    _tag: "subagent.started",
    ...buildEnvelope(state.sessionId, { nativeSessionId: state.nativeSessionId }),
    subagentId: agent.subagentId,
    ...(agent.parentSubagentId === undefined ? {} : { parentSubagentId: agent.parentSubagentId }),
    ...(details.itemId === undefined ? {} : { itemId: truncateFact(details.itemId) }),
    ...(role === undefined || role === "" ? {} : { description: truncateMessage(role) }),
    ...(typeName === undefined || typeName === "" ? {} : { agentType: truncateFact(typeName) }),
  };
};

/** Returns the events of a whole text item: it starts, holds `text`, and completes. */
const buildTextItem = (
  state: SubagentsState,
  agent: Subagent,
  turn: OpenTurn,
  kind: "assistant_message" | "reasoning",
  text: string,
): HarnessEvent[] => {
  const itemFields = { turnId: turn.id, itemId: crypto.randomUUID(), kind };
  return [
    { _tag: "item.started", ...buildBase(state, agent), ...itemFields },
    {
      _tag: "content.delta",
      ...buildBase(state, agent),
      turnId: turn.id,
      itemId: itemFields.itemId,
      streamKind: kind === "assistant_message" ? "assistant_text" : "reasoning_text",
      delta: text,
    },
    { _tag: "item.completed", ...buildBase(state, agent), ...itemFields, status: "completed" },
  ];
};

const buildUsageUpdated = (state: SubagentsState, agent: Subagent): HarnessEvent => ({
  _tag: "session.usage.updated",
  ...buildBase(state, agent),
  usage: buildUsage(agent.processUsage),
});

// ---- Turns ----

/**
 * Opens a turn for `agent` and returns its events: `turn.started` (with the
 * model when the step that opens it names one), then the `user_message` of the
 * input that is waiting, if there is one.
 */
const openTurn = (state: SubagentsState, agent: Subagent, model: string | undefined) => {
  const turn: OpenTurn = {
    id: crypto.randomUUID(),
    usage: buildZeroTotals(),
    hasUsage: false,
    warned: false,
  };
  agent.turn = turn;
  const events: HarnessEvent[] = [
    {
      _tag: "turn.started",
      ...buildBase(state, agent),
      turnId: turn.id,
      ...(model === undefined || model === "" ? {} : { model: truncateFact(model) }),
    },
  ];
  if (agent.pendingInput !== undefined) {
    events.push(
      ...buildUserMessage({
        sessionId: state.sessionId,
        subagentId: agent.subagentId,
        turnId: turn.id,
        text: truncateMessage(agent.pendingInput),
        steered: false,
      }),
    );
    agent.pendingInput = undefined;
  }
  return { turn, events };
};

/** Returns the turn `agent` has open, and the events that open one when it has none. */
const ensureTurn = (state: SubagentsState, agent: Subagent, model?: string) =>
  agent.turn === undefined
    ? openTurn(state, agent, model)
    : { turn: agent.turn, events: [] as HarnessEvent[] };

/**
 * Closes the turn `agent` has open and returns `turn.completed` with the
 * turn's usage, or nothing when no turn is open. Tool items without a result
 * stay running, as in the session's own turns: nothing in the files completes
 * them later.
 */
const closeTurn = (
  state: SubagentsState,
  agent: Subagent,
  endState: "completed" | "interrupted",
): HarnessEvent[] => {
  const turn = agent.turn;
  if (turn === undefined) return [];
  agent.turn = undefined;
  agent.pending = [];
  return [
    {
      _tag: "turn.completed",
      ...buildBase(state, agent),
      turnId: turn.id,
      state: endState,
      ...(turn.hasUsage ? { usage: buildUsage(turn.usage) } : {}),
    },
  ];
};

// ---- Messages to a subagent ----

/**
 * Parses the `[Message]` block that `agy` puts in a `SYSTEM_MESSAGE` step when
 * another agent, a task or the system sends a message. The block reads
 * `[Message] timestamp=<t> sender=<id> priority=<p> content=<text>` and the
 * content runs to the closing `</SYSTEM_MESSAGE>` tag, so it may span lines.
 * Returns `undefined` for any other system message, such as a reminder that a
 * hook inserts.
 */
const parseMessage = (
  content: string | undefined,
): { readonly sender: string; readonly text: string } | undefined => {
  const match =
    /\[Message\] [^\n]*? sender=(\S+) priority=\S+ content=([\s\S]*?)\n?<\/SYSTEM_MESSAGE>/.exec(
      content ?? "",
    );
  return match === null ? undefined : { sender: match[1]!, text: match[2]! };
};

/** Checks that the sender is `agy` itself or one of its background tasks, not an agent that wrote to the subagent. */
const isAutomaticSender = (sender: string): boolean =>
  sender === "system" || /\/task-\d+$/.test(sender);

/**
 * Returns the events of a `SYSTEM_MESSAGE` step. A message from another agent
 * is a steered `user_message` when a turn is open and the input of the next
 * turn otherwise. A message from `agy` or a task needs no `user_message`: it
 * only continues the turn, or the next model step opens one. Any other system
 * message is ignored.
 */
const normalizeSystemMessage = (
  state: SubagentsState,
  agent: Subagent,
  step: AgyStep,
): HarnessEvent[] => {
  const message = parseMessage(step.content);
  if (message === undefined || isAutomaticSender(message.sender)) return [];
  if (agent.turn === undefined) {
    // The launch message is the first message from a conversation, and it
    // comes before any turn. The link's brief is the unwrapped text of it.
    const text = agent.launchBrief ?? message.text;
    agent.launchBrief = undefined;
    agent.pendingInput =
      agent.pendingInput === undefined ? text : `${agent.pendingInput}\n\n${text}`;
    return [];
  }
  return [
    ...buildUserMessage({
      sessionId: state.sessionId,
      subagentId: agent.subagentId,
      turnId: agent.turn.id,
      text: truncateMessage(message.text),
      steered: true,
    }),
  ];
};

// ---- Model steps ----

/**
 * Returns the events of a `PLANNER_RESPONSE`: the turn if it opens one, the
 * reasoning, the reply, a started item for each tool call, and the usage. A
 * step with no tool calls ends the turn `completed`.
 */
const normalizeModelStep = (state: SubagentsState, agent: Subagent, step: AgyStep) => {
  const { turn, events } = ensureTurn(state, agent, step.model);
  // Results are logged in call order, so calls whose results never came
  // cannot be matched with the results of this step's calls.
  agent.pending = [];
  if (step.thinking !== undefined && step.thinking !== "") {
    events.push(...buildTextItem(state, agent, turn, "reasoning", step.thinking));
  }
  if (step.content !== undefined && step.content !== "") {
    events.push(...buildTextItem(state, agent, turn, "assistant_message", step.content));
  }
  for (const toolCall of step.toolCalls) {
    const itemId = crypto.randomUUID();
    const call: ToolCallFields = {
      toolCallId: itemId,
      name: toolCall.name,
      rawInput: toolCall.args,
    };
    const { kind, detail } = buildToolItem(call);
    agent.pending.push({ itemId, call });
    events.push({
      _tag: "item.started",
      ...buildBase(state, agent),
      turnId: turn.id,
      itemId,
      kind,
      detail,
    });
  }
  if (step.usage !== undefined) {
    for (const totals of [turn.usage, agent.processUsage]) {
      totals.inputTokens += step.usage.inputTokens;
      totals.outputTokens += step.usage.outputTokens;
      totals.cacheReadTokens += step.usage.cacheReadTokens;
    }
    turn.hasUsage = true;
    events.push(buildUsageUpdated(state, agent));
  }
  if (step.toolCalls.length === 0) events.push(...closeTurn(state, agent, "completed"));
  return events;
};

/** Returns the exit code a command's result text reports, or `undefined` when it names none. */
const readExitCode = (resultText: string | undefined): number | undefined => {
  const match = /^Command exited with code (-?\d+)\./m.exec(resultText ?? "");
  return match === null ? undefined : Number(match[1]);
};

/**
 * Returns the events of a `GENERIC` step, the result of the oldest tool call
 * that has none:
 *
 * - `DONE` completes its item, with the step's content as the output.
 * - `ERROR` fails it with the step's error.
 * - `RUNNING` (a command in the background) leaves it running: nothing in the
 *   files completes it later, so it stays running until the process ends.
 *
 * Returns nothing when no call is waiting for a result.
 */
const normalizeResultStep = (state: SubagentsState, agent: Subagent, step: AgyStep) => {
  const pending = agent.pending.shift();
  if (pending === undefined || agent.turn === undefined) return [];
  if (pending.call.name === "invoke_subagent") agent.launchItems.set(step.index, pending.itemId);
  if (step.status !== "DONE" && step.status !== "ERROR") return [];

  const exitCode = readExitCode(step.content);
  const done = step.status === "DONE";
  const call: ToolCallFields = {
    ...pending.call,
    rawOutput: done
      ? { output: step.content, ...(exitCode === undefined ? {} : { exit_code: exitCode }) }
      : step.error,
  };
  const { kind, detail } = done ? buildToolItem(call) : buildFailedToolItem(call);
  const status: ItemStatus = done ? "completed" : "failed";
  return [
    {
      _tag: "item.completed",
      ...buildBase(state, agent),
      turnId: agent.turn.id,
      itemId: pending.itemId,
      kind,
      status,
      detail,
    } satisfies HarnessEvent,
  ];
};

/**
 * Returns the `runtime.warning` for an `ERROR_MESSAGE` step, once per turn. It
 * is a model error that `agy` may retry, so the turn stays open and the
 * warning says that. The step opens a turn when none is open, because the
 * model was already called for it.
 */
const normalizeErrorStep = (state: SubagentsState, agent: Subagent, step: AgyStep) => {
  const { turn, events } = ensureTurn(state, agent);
  if (turn.warned) return events;
  turn.warned = true;
  const reason = [step.error, step.content].find((text) => text !== undefined && text !== "");
  events.push({
    _tag: "runtime.warning",
    ...buildBase(state, agent),
    turnId: turn.id,
    message: truncateMessage(
      `Antigravity may retry this subagent's request after an error${reason === undefined ? "" : `: ${reason}`}`,
    ),
  });
  return events;
};

// ---- Public ----

/**
 * Returns `subagent.started` for the subagent `link` names, with `itemId` the
 * `subagent` item of the parent's call that launched it when the caller knows
 * it. Returns nothing when the subagent was already introduced in this
 * process. A subagent known from an earlier process is introduced the same
 * way, because the controller fills what its record lacks and never overwrites
 * (spec 06 section 13.2).
 */
export const introduceSubagent = (
  state: SubagentsState,
  link: AgySubagentLink,
  itemId: string | undefined,
): HarnessEvent[] => {
  let agent = state.agents.get(link.conversationId);
  if (agent === undefined) {
    agent = buildSubagent({
      subagentId: link.conversationId,
      // A parent that is the session's own conversation is no subagent.
      parentSubagentId:
        link.parentConversationId === state.nativeSessionId ? undefined : link.parentConversationId,
      launchBrief: link.brief,
    });
    state.agents.set(link.conversationId, agent);
  }
  if (agent.introduced) return [];
  agent.introduced = true;
  return [
    buildSubagentStarted(state, agent, { link, ...(itemId === undefined ? {} : { itemId }) }),
  ];
};

/**
 * Returns the events one step of the subagent `conversationId` adds. Returns
 * nothing for a conversation that is no known subagent: such a step is never
 * given to another agent. A subagent known from an earlier process and not yet
 * introduced is introduced first, so no event of it comes before its
 * `subagent.started`.
 */
export const normalizeSubagentStep = (
  state: SubagentsState,
  conversationId: string,
  step: AgyStep,
): HarnessEvent[] => {
  const agent = state.agents.get(conversationId);
  if (agent === undefined) return [];
  const events = (() => {
    switch (step.type) {
      case "SYSTEM_MESSAGE":
        return normalizeSystemMessage(state, agent, step);
      case "PLANNER_RESPONSE":
        return normalizeModelStep(state, agent, step);
      case "GENERIC":
        return normalizeResultStep(state, agent, step);
      case "ERROR_MESSAGE":
        return normalizeErrorStep(state, agent, step);
      default:
        return [];
    }
  })();
  if (events.length === 0 || agent.introduced) return events;
  agent.introduced = true;
  return [buildSubagentStarted(state, agent, {}), ...events];
};

/**
 * Returns `turn.completed` with state `interrupted` for every subagent turn
 * that is open. The session calls it once `agy` has answered `session/cancel`,
 * which stops every subagent.
 */
export const interruptSubagentTurns = (state: SubagentsState): HarnessEvent[] =>
  [...state.agents.values()].flatMap((agent) => closeTurn(state, agent, "interrupted"));

/** Checks whether some subagent has a turn open, so the session keeps reading the files. */
export const hasOpenSubagentTurn = (state: SubagentsState): boolean =>
  [...state.agents.values()].some((agent) => agent.turn !== undefined);

/**
 * Returns the item of the `invoke_subagent` call of the subagent `conversationId`
 * whose result is the step `resultStepIndex`, or `undefined` when that step
 * was not read or is no such result. It names the item that a grandchild's
 * `subagent.started` points at.
 */
export const findSubagentLaunchItem = (
  state: SubagentsState,
  conversationId: string,
  resultStepIndex: number,
): string | undefined => state.agents.get(conversationId)?.launchItems.get(resultStepIndex);

/** Returns the token counts of every subagent since the process started, added up. */
export const readSubagentUsage = (state: SubagentsState): Usage => {
  const sum = buildZeroTotals();
  for (const { processUsage } of state.agents.values()) {
    sum.inputTokens += processUsage.inputTokens;
    sum.outputTokens += processUsage.outputTokens;
    sum.cacheReadTokens += processUsage.cacheReadTokens;
  }
  return buildUsage(sum);
};

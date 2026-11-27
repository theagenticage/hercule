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
import { buildUsage, buildZeroTotals, type Totals } from "./normalize";
import { buildUserMessage } from "../events";
import { truncateFact, truncateMessage } from "../text";
import { readStepErrorText, type AgyStep, type AgySubagentLink } from "./agy-files";
import {
  buildFailedToolItem,
  buildToolItem,
  LAUNCH_TOOL_NAME,
  type ToolCallFields,
} from "./tool-items";

/** A tool item that has started and has no result yet. */
interface ToolAwaitingResult {
  readonly itemId: string;
  readonly call: ToolCallFields;
}

/** A turn of a subagent that is open. */
interface OpenSubagentTurn {
  readonly id: string;
  readonly usage: Totals;
  hasUsage: boolean;
  /** Whether the turn has shown its `runtime.warning` for a model error. */
  warned: boolean;
}

/** One subagent: its own turn and item state, kept apart from every other agent. */
interface Subagent {
  readonly subagentId: SubagentId;
  /** Whether `subagent.started` was sent for it in this process. */
  introduced: boolean;
  /**
   * What the parent told the subagent when it started it, until the first
   * message from a conversation is read. The launch message is also the
   * transcript's first step, and this text replaces the step's wrapped copy.
   */
  launchBrief: string | undefined;
  /**
   * True after `agy` took a cancel, until a message from a conversation arrives.
   * A step of a stopped subagent that is read late is shown, but the turn it
   * opens ends at once as interrupted: `agy` is no longer working on it, so
   * nothing would ever close that turn.
   */
  isStopped: boolean;
  /** The input that the next turn opens with, when one is waiting. */
  inputForNextTurn: string | undefined;
  turn: OpenSubagentTurn | undefined;
  /** The tool items of the last model step, in call order, that have no result yet. */
  toolsAwaitingResult: ToolAwaitingResult[];
  readonly processUsage: Totals;
  /**
   * Whether some count of this subagent is missing or invalid, or its files
   * could not be read. Its usage is then reported in the incomplete form.
   */
  hasIncompleteUsage: boolean;
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
  /** Whether the session was told once that a subagent started a subagent of its own. */
  hasWarnedAboutGrandchild: boolean;
}

const buildSubagent = (input: {
  readonly subagentId: SubagentId;
  readonly launchBrief: string | undefined;
}): Subagent => ({
  ...input,
  introduced: false,
  isStopped: false,
  inputForNextTurn: undefined,
  turn: undefined,
  toolsAwaitingResult: [],
  processUsage: buildZeroTotals(),
  hasIncompleteUsage: false,
});

/**
 * Returns the state for a new session. `known` are the subagents of an earlier
 * process of the session (`continue.subagents`), so that a subagent which works
 * again lands on its own record.
 */
export const buildSubagentsState = (input: {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly known: ReadonlyArray<{ readonly subagentId: string }>;
}): SubagentsState => ({
  sessionId: input.sessionId,
  nativeSessionId: input.nativeSessionId,
  hasWarnedAboutGrandchild: false,
  agents: new Map(
    input.known.map((known) => [
      known.subagentId,
      buildSubagent({
        subagentId: known.subagentId,
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
    ...(details.itemId === undefined ? {} : { itemId: truncateFact(details.itemId) }),
    ...(role === undefined || role === "" ? {} : { description: truncateMessage(role) }),
    ...(typeName === undefined || typeName === "" ? {} : { agentType: truncateFact(typeName) }),
  };
};

/** Returns the events of a whole text item: it starts, holds `text`, and completes. */
const buildTextItem = (
  state: SubagentsState,
  agent: Subagent,
  turn: OpenSubagentTurn,
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
  ...(agent.hasIncompleteUsage
    ? { usageReport: { status: "incomplete" as const, counts: buildUsage(agent.processUsage) } }
    : { usage: buildUsage(agent.processUsage) }),
});

// ---- Turns ----

/**
 * Opens a turn for `agent` and returns its events: `turn.started` (with the
 * model when the step that opens it names one), then the `user_message` of the
 * input that is waiting, if there is one.
 */
const openSubagentTurn = (state: SubagentsState, agent: Subagent, model: string | undefined) => {
  const turn: OpenSubagentTurn = {
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
  if (agent.inputForNextTurn !== undefined) {
    events.push(
      ...buildUserMessage({
        sessionId: state.sessionId,
        subagentId: agent.subagentId,
        turnId: turn.id,
        text: truncateMessage(agent.inputForNextTurn),
        steered: false,
      }),
    );
    agent.inputForNextTurn = undefined;
  }
  return { turn, events };
};

/** Returns the turn `agent` has open, and the events that open one when it has none. */
const ensureTurn = (state: SubagentsState, agent: Subagent, model?: string) =>
  agent.turn === undefined
    ? openSubagentTurn(state, agent, model)
    : { turn: agent.turn, events: [] as HarnessEvent[] };

/**
 * Closes the turn `agent` has open and returns `turn.completed` with the
 * turn's usage, or nothing when no turn is open. The turn carries no usage
 * when some count of the subagent is incomplete. An `interrupted` or `failed`
 * end first fails every tool item that has no result (see the comment in the
 * body). A `completed` end leaves such items running: nothing in the files
 * completes them later.
 */
const closeSubagentTurn = (
  state: SubagentsState,
  agent: Subagent,
  endState: "completed" | "interrupted" | "failed",
): HarnessEvent[] => {
  const turn = agent.turn;
  if (turn === undefined) return [];
  agent.turn = undefined;
  // `agy` stops the subagent's commands when it is interrupted, and nothing
  // more is read from a subagent that failed, so a call without a result will
  // never get one. It fails now, as the items of the
  // session's own agent do when the process ends. A call that left `toolsAwaitingResult`
  // with a `RUNNING` result is not tracked any more, so it stays as it is.
  const failedItems: HarnessEvent[] =
    endState !== "completed"
      ? agent.toolsAwaitingResult.map(({ itemId, call }) => ({
          _tag: "item.completed",
          ...buildBase(state, agent),
          turnId: turn.id,
          itemId,
          ...buildToolItem(call),
          status: "failed",
        }))
      : [];
  agent.toolsAwaitingResult = [];
  return [
    ...failedItems,
    {
      _tag: "turn.completed",
      ...buildBase(state, agent),
      turnId: turn.id,
      state: endState,
      ...(turn.hasUsage && !agent.hasIncompleteUsage ? { usage: buildUsage(turn.usage) } : {}),
    },
  ];
};

// ---- Messages to a subagent ----

/**
 * Parses the `[Message]` block that `agy` puts in a `SYSTEM_MESSAGE` step when
 * another agent, a task or the system sends a message. The block reads
 * `[Message] timestamp=<t> sender=<id> priority=<p> content=<text>` and the
 * content runs to the closing `</SYSTEM_MESSAGE>` tag, so it may span lines.
 * The sender must be the id of a conversation (a UUID). Returns `undefined` for
 * any other system message, such as a reminder that a hook inserts or a
 * message from `system` or a background task.
 */
const parseMessageBlock = (content: string | undefined): { readonly text: string } | undefined => {
  const match =
    /\[Message\] [^\n]*? sender=[0-9a-f-]{36} priority=\S+ content=([\s\S]*?)\n?<\/SYSTEM_MESSAGE>/.exec(
      content ?? "",
    );
  return match === null ? undefined : { text: match[1]! };
};

/**
 * Returns the events of a `SYSTEM_MESSAGE` step. A message from another agent
 * is a steered `user_message` when a turn is open and the input of the next
 * turn otherwise. Any other system message is ignored.
 */
const normalizeSystemMessage = (
  state: SubagentsState,
  agent: Subagent,
  step: AgyStep,
): HarnessEvent[] => {
  const message = parseMessageBlock(step.content);
  if (message === undefined) return [];
  // A message from a conversation is new work for a stopped subagent.
  agent.isStopped = false;
  if (agent.turn === undefined) {
    // The launch message is the first message from a conversation, and it
    // comes before any turn. The link's brief is the unwrapped text of it.
    const text = agent.launchBrief ?? message.text;
    agent.launchBrief = undefined;
    agent.inputForNextTurn =
      agent.inputForNextTurn === undefined ? text : `${agent.inputForNextTurn}\n\n${text}`;
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
  agent.toolsAwaitingResult = [];
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
    agent.toolsAwaitingResult.push({ itemId, call });
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
  }
  // No recording shows a subagent that starts a subagent, so the reader does not follow one.
  // Its work and tokens are missing, and the session is told once.
  const startsSubagent = step.toolCalls.some((call) => call.name === LAUNCH_TOOL_NAME);
  if (step.hasInvalidUsage === true || startsSubagent) agent.hasIncompleteUsage = true;
  if (step.usage !== undefined || step.hasInvalidUsage === true || startsSubagent) {
    events.push(buildUsageUpdated(state, agent));
  }
  if (startsSubagent && !state.hasWarnedAboutGrandchild) {
    state.hasWarnedAboutGrandchild = true;
    events.push({
      _tag: "runtime.warning",
      ...buildEnvelope(state.sessionId, { nativeSessionId: state.nativeSessionId }),
      message:
        "This subagent started a subagent of its own, which Hercule does not read, so its work is not shown and its tokens are not counted.",
    });
  }
  if (step.toolCalls.length === 0) events.push(...closeSubagentTurn(state, agent, "completed"));
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
  const awaiting = agent.toolsAwaitingResult.shift();
  if (awaiting === undefined || agent.turn === undefined) return [];
  if (step.status !== "DONE" && step.status !== "ERROR") return [];

  const exitCode = readExitCode(step.content);
  const done = step.status === "DONE";
  const call: ToolCallFields = {
    ...awaiting.call,
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
      itemId: awaiting.itemId,
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
  const reason = readStepErrorText(step);
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
 * `subagent` item of the session's call that launched it when
 * `findLaunchItem` knows it. Returns nothing when the subagent was already
 * introduced in this process. A subagent known from an earlier process is
 * introduced the same way, because the controller fills what its record lacks
 * and never overwrites (spec 06 section 13.2).
 */
export const introduceSubagent = (
  state: SubagentsState,
  link: AgySubagentLink,
  findLaunchItem: (toolCallId: string) => string | undefined,
): HarnessEvent[] => {
  let agent = state.agents.get(link.conversationId);
  if (agent === undefined) {
    agent = buildSubagent({ subagentId: link.conversationId, launchBrief: link.brief });
    state.agents.set(link.conversationId, agent);
  }
  if (agent.introduced) return [];
  agent.introduced = true;
  const itemId = findLaunchItem(link.launchToolCallId);
  return [
    buildSubagentStarted(state, agent, { link, ...(itemId === undefined ? {} : { itemId }) }),
  ];
};

/** Returns `events` with `subagent.started` in front when `agent` was not introduced yet. */
const introduceBefore = (
  state: SubagentsState,
  agent: Subagent,
  events: HarnessEvent[],
): HarnessEvent[] => {
  if (events.length === 0 || agent.introduced) return events;
  agent.introduced = true;
  return [buildSubagentStarted(state, agent, {}), ...events];
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
  const events: HarnessEvent[] = (() => {
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
  if (agent.isStopped) events.push(...closeSubagentTurn(state, agent, "interrupted"));
  return introduceBefore(state, agent, events);
};

/**
 * Returns the events that end the subagent `conversationId` after its files
 * could not be read: its open turn ends `failed` with its tool items awaiting a result
 * failed, and its usage is reported in the incomplete form, because the steps
 * that were never read hold tokens. Returns nothing for a conversation that is
 * no known subagent, and for a subagent that was already ended this way.
 */
export const endUnreadableSubagent = (
  state: SubagentsState,
  conversationId: string,
): HarnessEvent[] => {
  const agent = state.agents.get(conversationId);
  if (agent === undefined) return [];
  const events: HarnessEvent[] = [];
  if (!agent.hasIncompleteUsage) {
    agent.hasIncompleteUsage = true;
    events.push(buildUsageUpdated(state, agent));
  }
  events.push(...closeSubagentTurn(state, agent, "failed"));
  return introduceBefore(state, agent, events);
};

/**
 * Returns the events that end every known subagent after the session's own
 * files could not be read, as `endUnreadableSubagent` does for one.
 */
export const endUnreadableSubagents = (state: SubagentsState): HarnessEvent[] =>
  [...state.agents.keys()].flatMap((id) => endUnreadableSubagent(state, id));

/**
 * Returns `turn.completed` with state `interrupted` for every subagent turn
 * that is open, and marks every subagent as stopped (see `Subagent.isStopped`).
 * The session calls it once `agy` has answered `session/cancel`, which stops
 * every subagent.
 */
export const interruptSubagentTurns = (state: SubagentsState): HarnessEvent[] =>
  [...state.agents.values()].flatMap((agent) => {
    agent.isStopped = true;
    return closeSubagentTurn(state, agent, "interrupted");
  });

/** Checks whether some subagent has a turn open, so the session keeps reading the files. */
export const hasOpenSubagentTurn = (state: SubagentsState): boolean =>
  [...state.agents.values()].some((agent) => agent.turn !== undefined);

/**
 * Returns the token counts of every subagent since the process started, added
 * up, and whether the count of any subagent is incomplete (see
 * `Subagent.hasIncompleteUsage`).
 */
export const sumSubagentUsage = (
  state: SubagentsState,
): { readonly usage: Usage; readonly hasIncompleteCount: boolean } => {
  const sum = buildZeroTotals();
  let hasIncompleteCount = false;
  for (const { processUsage, hasIncompleteUsage } of state.agents.values()) {
    sum.inputTokens += processUsage.inputTokens;
    sum.outputTokens += processUsage.outputTokens;
    sum.cacheReadTokens += processUsage.cacheReadTokens;
    if (hasIncompleteUsage) hasIncompleteCount = true;
  }
  return { usage: buildUsage(sum), hasIncompleteCount };
};

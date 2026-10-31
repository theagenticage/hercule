/**
 * The blocks of a thread's transcript as the desktop draws it: one flat list
 * in reading order, one block per item of the virtualized list. The web draws
 * one divider per turn (`buildTurns`); the desktop keeps the order of talk and
 * work inside a turn, so each run of tool calls between two messages gets its
 * own divider, and each agent message stands on its own.
 *
 * Rows are not in the order things happened. The controller holds a
 * message's text until the message completes (or 4 KB of it), so a message's
 * text row can sit after a message the user steered in while it was written.
 * So each message is placed by its `item.started` row, and its text is
 * gathered from its rows wherever they sit.
 */
import {
  isAsyncQuestion,
  type ContextCompactionDetail,
  type Input,
  type TodoListDetail,
  type TranscriptRow,
} from "@hercule/contract";
import { readJsonObject, readStringList } from "../json-shape";
import type { AgentState } from "./agent-state";
import { readFetchedUrl, readToolCallName, summarizeTodoList } from "./item-detail";
import { findOpenItem } from "./open-item";
import { readInputSender } from "./sender";
import {
  buildCompletedItem,
  buildStartedItem,
  buildUpdatedItem,
  buildUnknownEventMessage,
  buildUserMessage,
  describeToolCallTarget,
  type ThreadItem,
  type ThreadUserMessage,
} from "./turns";

type HarnessEvent = TranscriptRow["event"];
type ItemStarted = Extract<HarnessEvent, { _tag: "item.started" }>;
type ItemUpdated = Extract<HarnessEvent, { _tag: "item.updated" }>;
type ItemCompleted = Extract<HarnessEvent, { _tag: "item.completed" }>;
type TurnEndState = Extract<HarnessEvent, { _tag: "turn.completed" }>["state"];

/** A tool item in a work stretch, with what its summary and its row show. */
export interface WorkItem extends ThreadItem {
  /**
   * What the item acted on, in one line, as the desktop's row shows it:
   *
   * - a file read's `path`, and a file search's `pattern` and `path`, read
   *   from the fixed fields of their detail;
   * - a tool call's command, path, query or description, never its tool's
   *   name, which the row shows as its label (`describeToolCallTarget`);
   * - a page fetch's URL, and a todo list's step in progress, without its
   *   progress count, which the row shows in its label;
   * - for any other kind, the target the web's row shows.
   */
  readonly target: string;
  /**
   * Whether `target` is code, such as a command, a path or a search pattern,
   * which the desktop draws in the mono face. A fetched URL is code, like a
   * path. A web search's query, a todo list's step, a subagent's or a tool's
   * description, and an error's message are words.
   */
  readonly targetIsCode: boolean;
  /**
   * The files a file change touched or a file read read, as its detail names
   * them. Empty for any other item.
   */
  readonly paths: readonly string[];
  /** The time of the item's `item.started` row. */
  readonly startedAt: string;
  /**
   * The name of the tool a tool call used, such as `Bash` or
   * `github/create_issue`, as its detail names it (`readToolCallName`): a call
   * to an MCP server through Anthropic's API connector has the server's name
   * before the tool's. Empty when the detail names none, and for any item that
   * is not a tool call.
   */
  readonly toolName: string;
  /**
   * Whether a `web_search` item fetched a page rather than searched: its
   * detail names a URL (`readFetchedUrl`). False for every other item.
   */
  readonly isPageFetch: boolean;
  /**
   * The label of an `unknown` item, such as `claude: system/foo_bar`: it names
   * a message no decision covers, or a known message that could not be read.
   * Empty when the item has none, as on a row written before the label
   * existed, and for any item that is not an `unknown` one.
   */
  readonly fallbackLabel: string;
  /**
   * What the item's `item.completed` row returned, as the adapter sent it: the
   * `detail.content` (a string, a list of content blocks), or, for a
   * compaction, the `detail.summary` string. It is `undefined` while the item
   * runs or when it returned nothing. It is kept as it is, and only read for
   * its text when a row shows it (`buildWorkRows`), so building the transcript
   * does no work for results nobody opens.
   */
  readonly resultContent: unknown;
}

/**
 * A message sent into the thread: the opening one, or one steered into the
 * running turn. The session's owner sent it, or another session's agent did.
 */
export interface UserBlock extends ThreadUserMessage {
  readonly kind: "user";
  readonly key: string;
  readonly at: string;
  /**
   * True for a message on its way into the session, drawn from its queued
   * input (`appendSendingMessages`). Absent on a message the transcript holds.
   */
  readonly sending?: true;
}

/** The items of one turn between two messages. */
export interface WorkBlock {
  readonly kind: "work";
  readonly key: string;
  readonly turnId: string;
  /** Never empty, and always holds an item other than reasoning. */
  readonly items: readonly WorkItem[];
  /** The turn's start, or the end of the message before the stretch. */
  readonly startedAt: string;
  /**
   * The start of the message after the stretch, or the end of its turn. While
   * a Request is open, the time it opened. `null` while the stretch still runs.
   */
  readonly endedAt: string | null;
}

/** A message the agent wrote. */
export interface AgentBlock {
  readonly kind: "agent";
  readonly key: string;
  readonly itemId: string;
  readonly turnId: string;
  /** The text the stream rows hold. The text still streaming is in the tail, not here. */
  readonly text: string;
  readonly startedAt: string;
  /** The model the turn ran on, or the agent's model when the harness did not say. */
  readonly model: string;
  /**
   * Whether the agent is still writing it: it is the transcript's open item
   * (`findOpenItem`), in a turn that still runs. Only the open item's text
   * streams in the tail, so at most one message is open. An earlier message
   * whose end never arrived is not open, and shows the text its rows hold.
   */
  readonly open: boolean;
  /** Whether this message is the one the thread's working face is on. */
  readonly live: boolean;
}

/** The end of a turn that did not complete. */
export interface EndingBlock {
  readonly kind: "ending";
  readonly key: string;
  readonly turnId: string;
  /** `interrupted` when it was stopped, `failed`, or `null` when it was cut short. */
  readonly endState: Exclude<TurnEndState, "completed"> | null;
  /** From the turn's start to its end, in milliseconds. `null` when it was cut short. */
  readonly duration: number | null;
}

/**
 * The status line at the bottom of a running turn that has drawn nothing
 * yet: right after the user's message, while the agent only reasons, and
 * while a session or subagent starts. It stands where an agent message will
 * be, so the thread never shows an agent row with no text.
 */
export interface PendingBlock {
  readonly kind: "pending";
  readonly key: string;
  /**
   * When the wait began, for the line's timer: the start of the stretch the
   * turn is in. `null` while no turn has started, which reads "Starting…".
   */
  readonly since: string | null;
}

/** The note that the thread waits on the user's answer to a Request. */
export interface WaitingBlock {
  readonly kind: "waiting";
  readonly key: string;
  readonly requestId: string;
  /** The time the Request opened. */
  readonly openedAt: string;
}

/**
 * A warning the runner or the harness reported about the agent's work, such
 * as a retried request or an event too large to send whole (spec 06).
 */
export interface WarningBlock {
  readonly kind: "warning";
  readonly key: string;
  /** The warning's text, as the runner wrote it. */
  readonly message: string;
  readonly at: string;
}

/**
 * An error the runner or the harness reported: a session that could not
 * start, such as one whose skill could not be loaded, or a turn that failed,
 * such as one whose context window is full (spec 06).
 */
export interface ErrorBlock {
  readonly kind: "error";
  readonly key: string;
  /** The error's text, as the runner wrote it, or the error's class when it has no text. */
  readonly message: string;
  readonly at: string;
}

/**
 * A neutral note the runner or the harness reported, that is not a problem: a
 * conversation that was cleared, or memories that were recalled (spec 06).
 */
export interface RuntimeNoticeBlock {
  readonly kind: "runtime-notice";
  readonly key: string;
  /** The runtime notice's text, as the runner wrote it. */
  readonly message: string;
  readonly at: string;
}

export type ThreadBlock =
  | UserBlock
  | WorkBlock
  | AgentBlock
  | EndingBlock
  | PendingBlock
  | WaitingBlock
  | RuntimeNoticeBlock
  | WarningBlock
  | ErrorBlock;

interface BuildingTurn {
  readonly turnId: string;
  startedAt: string;
  model: string | undefined;
  /** The time of the last row that names the turn. A turn cut short without an exit row ends here. */
  lastAt: string;
  finished: boolean;
  /** Whether an item started in this turn. A turn with none draws nothing, not even its ending. */
  drawn: boolean;
  /** Where the next stretch starts: the turn's start, or the end of the last message. */
  boundary: string;
  stretch: BuildingStretch | null;
  /** The item that started last in this turn, of any kind. */
  lastStartedItemId: string | null;
}

interface BuildingStretch {
  readonly kind: "work";
  readonly turn: BuildingTurn;
  readonly items: WorkItem[];
  readonly startedAt: string;
  endedAt: string | null;
  frozenAt: string | null;
}

interface BuildingAgent {
  readonly kind: "agent";
  readonly turn: BuildingTurn;
  readonly itemId: string;
  readonly startedAt: string;
  text: string;
  completed: boolean;
}

interface BuildingEnding {
  readonly kind: "ending";
  readonly turn: BuildingTurn;
  readonly block: EndingBlock;
}

type Slot =
  | UserBlock
  | BuildingStretch
  | BuildingAgent
  | BuildingEnding
  | WaitingBlock
  | RuntimeNoticeBlock
  | WarningBlock
  | ErrorBlock;

/**
 * Returns the files an item touched, as its detail names them, or `[]` for an
 * item that is neither a file change nor a file read:
 *
 * - a file read names one, in the fixed field `path`;
 * - a file change names its `paths` list, else one path from the tool's
 *   input or the detail. The adapters spell it in their own ways (Claude
 *   Code's `input.file_path`, Codex's `paths`, pi's `path`), and any of them
 *   may be absent.
 */
const readItemPaths = (event: ItemStarted | ItemUpdated | ItemCompleted): readonly string[] => {
  const detail = readJsonObject(event.detail);
  if (event.kind === "file_read") return typeof detail?.path === "string" ? [detail.path] : [];
  if (event.kind !== "file_change") return [];
  const listed = readStringList(detail?.paths);
  if (listed !== undefined) return listed;
  const input = readJsonObject(detail?.input);
  const path = input?.file_path ?? input?.notebook_path ?? input?.path ?? detail?.path;
  return typeof path === "string" ? [path] : [];
};

/** The kinds of item whose target, as the web's row shows it, is code. */
const CODE_TARGET_KINDS: ReadonlySet<ItemStarted["kind"]> = new Set([
  "command_execution",
  "file_change",
  "image_generation",
]);

/**
 * Returns what a work item acted on, as its row in the desktop shows it (see
 * `WorkItem.target`), and whether that is code. Reads only the fixed fields
 * of a file read's and a file search's detail, never the tool's input, which
 * differs from one harness to the next.
 */
const readWorkItemTarget = (
  event: ItemStarted | ItemUpdated | ItemCompleted,
  threadItem: ThreadItem,
  todoList: TodoListDetail | undefined,
  isPageFetch: boolean,
): { readonly target: string; readonly targetIsCode: boolean } => {
  switch (event.kind) {
    case "file_read":
    case "file_search": {
      const detail = readJsonObject(event.detail);
      const pattern = typeof detail?.pattern === "string" ? detail.pattern : "";
      const path = typeof detail?.path === "string" ? detail.path : "";
      return {
        target: pattern !== "" && path !== "" ? `${pattern} in ${path}` : pattern || path,
        targetIsCode: true,
      };
    }
    case "tool_call": {
      const { text, isCode } = describeToolCallTarget(event.detail);
      return { target: text, targetIsCode: isCode };
    }
    case "todo_list":
      return { target: summarizeTodoList(todoList?.steps ?? []).current, targetIsCode: false };
    case "web_search":
      return { target: threadItem.target, targetIsCode: isPageFetch };
    default:
      return { target: threadItem.target, targetIsCode: CODE_TARGET_KINDS.has(event.kind) };
  }
};

/**
 * Returns the fields of a work item that come from the detail of an
 * `item.started`, `item.updated` or `item.completed` row, with `threadItem` as
 * the projection the web's row shows. Every row that carries a detail builds
 * them here, so an update redraws exactly what a start draws.
 */
const readWorkItemDetail = (
  event: ItemStarted | ItemUpdated | ItemCompleted,
  threadItem: ThreadItem,
  todoList: TodoListDetail | undefined,
): Pick<WorkItem, "target" | "targetIsCode" | "paths" | "toolName" | "isPageFetch"> => {
  const isPageFetch = event.kind === "web_search" && readFetchedUrl(event.detail) !== "";
  return {
    ...readWorkItemTarget(event, threadItem, todoList, isPageFetch),
    paths: readItemPaths(event),
    toolName: event.kind === "tool_call" ? readToolCallName(event.detail) : "",
    isPageFetch,
  };
};

/**
 * Returns the blocks of one agent's transcript in reading order: the
 * session's own agent's, or a subagent's. `agent` is that agent's state, and
 * decides what the rows cannot: whether the last turn still runs, the
 * Requests the agent waits on, and the model when a turn does not name one.
 *
 * - A `user` block per user message, and an `agent` block per assistant
 *   message, placed where the message started. A message with no text gets
 *   a block only while it is open, since the agent may yet write it.
 * - A `work` block per stretch of items between two messages of a turn, once
 *   it holds an item other than reasoning.
 * - An `ending` block after a turn that was stopped, failed, or cut short. A
 *   turn is cut short when, before its `turn.completed`, its session exited,
 *   its session started again, another turn started, or the agent's records
 *   say it can no longer be running a turn (`mayBeRunningTurn`).
 * - A `waiting` block where one of the agent's open Requests opened, once its
 *   `request.opened` row has landed. An async question gets none: the agent
 *   does not wait on it, and the question's text is already in the
 *   transcript as the agent's own message. The dock above the composer is
 *   where it waits on the user.
 * - A `warning` block per `runtime.warning` row, where the row sits. It does
 *   not end the work stretch it falls in: the stretch's divider stays one,
 *   above the warning, and items that start after the warning still join it.
 * - A `runtime-notice` block per `runtime.notice` row, placed and kept in the stretch
 *   in the same way. An `unknown` row (an event type this client has no arm for) gets one
 *   too, with the text `Unknown event: <type>`.
 * - An `error` block per `runtime.error` row, where the row sits. Like a
 *   warning, it does not end the work stretch it falls in.
 * - A `pending` block at the end while the agent has no open Request (an
 *   async question does not count, because the agent keeps working), no
 *   agent message holds the working face, the last block other than a
 *   runtime notice, warning or error is not the running turn's running `work` block,
 *   and either the last turn has not finished or, before any turn, the agent
 *   is working.
 *
 * The working face is on one block at most: the agent message the agent is
 * writing; else the running turn's last agent message, when nothing started
 * after it (its turn's end is about to land). While nothing holds it, the
 * `pending` block or the running work stretch's divider shows the agent is
 * busy, because a face is drawn only beside text.
 *
 * Each block's key is built from an item id, a turn id, a request id or, for
 * a runtime notice, a warning or an error, its row's position, so it stays the same as rows
 * are appended.
 */
export const buildThreadBlocks = (
  rows: readonly TranscriptRow[],
  agent: AgentState,
): readonly ThreadBlock[] => {
  // The Requests the agent is parked on. An async question is not one: the
  // agent keeps working, so it must not freeze a stretch, hide the working
  // face or mark an item as awaiting.
  const parkedRequests = agent.openRequests.filter((request) => !isAsyncQuestion(request));
  const openRequestIds = new Set(parkedRequests.map((request) => request.requestId));
  const awaitingItemIds = new Set(parkedRequests.map((request) => request.itemId));
  const slots: Slot[] = [];
  const turns = new Map<string, BuildingTurn>();
  const agents = new Map<string, BuildingAgent>();
  const workItems = new Map<
    string,
    {
      readonly stretch: BuildingStretch;
      readonly index: number;
      /** The latest decoded detail of a compaction (`StartedItem.compaction`, `UpdatedItem.compaction`). */
      latestCompaction: ContextCompactionDetail | undefined;
    }
  >();
  // An object rather than a `let`, because the helpers below reassign it and
  // TypeScript does not see an assignment made inside a closure.
  const state: { current: BuildingTurn | null } = { current: null };

  const finishTurn = (turn: BuildingTurn, at: string, endState: TurnEndState | null): void => {
    closeStretch(turn, at);
    turn.finished = true;
    if (endState === "completed") return;
    slots.push({
      kind: "ending",
      turn,
      block: {
        kind: "ending",
        key: `ending:${turn.turnId}`,
        turnId: turn.turnId,
        endState,
        duration: endState === null ? null : Date.parse(at) - Date.parse(turn.startedAt),
      },
    });
  };

  const closeStretch = (turn: BuildingTurn, at: string): void => {
    if (turn.stretch !== null) turn.stretch.endedAt = at;
    turn.stretch = null;
  };

  /** Returns the turn a row names, starting it when this is the first row to name it. */
  const enterTurn = (turnId: string, at: string): BuildingTurn => {
    const known = turns.get(turnId);
    if (known !== undefined) {
      known.lastAt = at;
      return known;
    }
    // Only one turn runs at a time, so a new turn means the one before it
    // ended, even when no row said so.
    const previous = state.current;
    if (previous !== null && !previous.finished) finishTurn(previous, previous.lastAt, null);
    const started: BuildingTurn = {
      turnId,
      startedAt: at,
      model: undefined,
      lastAt: at,
      finished: false,
      drawn: false,
      boundary: at,
      stretch: null,
      lastStartedItemId: null,
    };
    turns.set(turnId, started);
    state.current = started;
    return started;
  };

  const startAgent = (turn: BuildingTurn, itemId: string, at: string): BuildingAgent => {
    closeStretch(turn, at);
    const agent: BuildingAgent = {
      kind: "agent",
      turn,
      itemId,
      startedAt: at,
      text: "",
      completed: false,
    };
    agents.set(itemId, agent);
    slots.push(agent);
    turn.drawn = true;
    turn.lastStartedItemId = itemId;
    turn.boundary = at;
    return agent;
  };

  for (const row of rows) {
    const event = row.event;
    switch (event._tag) {
      case "turn.started": {
        const turn = enterTurn(event.turnId, event.at);
        turn.startedAt = event.at;
        turn.model = event.model;
        break;
      }
      case "turn.completed": {
        const turn = enterTurn(event.turnId, event.at);
        if (!turn.finished) finishTurn(turn, event.at, event.state);
        break;
      }
      case "item.started": {
        // A message whose text row came first is already placed.
        if (agents.has(event.itemId)) break;
        const turn = enterTurn(event.turnId, event.at);
        turn.drawn = true;
        turn.lastStartedItemId = event.itemId;
        if (event.kind === "user_message") {
          closeStretch(turn, event.at);
          slots.push({
            kind: "user",
            key: `user:${event.itemId}`,
            ...buildUserMessage(event),
            at: event.at,
          });
          turn.boundary = event.at;
        } else if (event.kind === "assistant_message") {
          startAgent(turn, event.itemId, event.at);
        } else {
          if (turn.stretch === null) {
            turn.stretch = {
              kind: "work",
              turn,
              items: [],
              startedAt: turn.boundary,
              endedAt: null,
              frozenAt: null,
            };
            slots.push(turn.stretch);
          }
          const stretch = turn.stretch;
          // The turn already ended, so nothing closes this stretch later. It
          // ends with the item that opened it, or its divider would count
          // "Working for" forever.
          if (turn.finished) stretch.endedAt = event.at;
          const started = buildStartedItem(event);
          workItems.set(event.itemId, {
            stretch,
            index: stretch.items.length,
            latestCompaction: started.compaction,
          });
          const threadItem = started.item;
          stretch.items.push({
            ...threadItem,
            ...readWorkItemDetail(event, threadItem, started.todoList),
            startedAt: event.at,
            fallbackLabel: started.unknownLabel,
            resultContent: undefined,
          });
        }
        break;
      }
      case "item.updated": {
        // Only a work item that started can change. A message's text never
        // comes from an update, and a row for an item never seen is dropped.
        const work = workItems.get(event.itemId);
        if (work === undefined) break;
        const item = work.stretch.items[work.index]!;
        const updated = buildUpdatedItem(item, event);
        if (updated === undefined) break;
        work.stretch.items[work.index] = {
          ...updated.item,
          ...readWorkItemDetail(event, updated.item, updated.todoList),
          fallbackLabel: updated.unknownLabel,
        };
        if (updated.compaction !== undefined) work.latestCompaction = updated.compaction;
        break;
      }
      case "item.completed": {
        // Looked up by id rather than by turn: a harness can complete an item
        // after its turn was interrupted, under a turn of its own.
        const agent = agents.get(event.itemId);
        if (agent !== undefined) {
          agent.completed = true;
          agent.turn.boundary = event.at;
          break;
        }
        const work = workItems.get(event.itemId);
        if (work !== undefined) {
          const current = work.stretch.items[work.index]!;
          const completed = buildCompletedItem(current, work.latestCompaction, event);
          work.stretch.items[work.index] = {
            ...completed.item,
            ...(completed.update === undefined
              ? {}
              : readWorkItemDetail(event, completed.item, completed.update.todoList)),
            resultContent:
              current.kind === "context_compaction"
                ? completed.compaction?.summary
                : readJsonObject(event.detail)?.content,
          };
        }
        break;
      }
      case "content.delta": {
        if (event.streamKind !== "assistant_text") break;
        // The adapters start an item before its text, but nothing in the
        // protocol requires it. A message is placed at its first text row
        // rather than its text left out.
        const agent =
          agents.get(event.itemId) ??
          startAgent(enterTurn(event.turnId, event.at), event.itemId, event.at);
        agent.text += event.delta;
        break;
      }
      // A harness that exited, or a new one that started, runs no turn of
      // the one before.
      case "session.exited":
      case "session.started": {
        const turn = state.current;
        if (turn !== null && !turn.finished) finishTurn(turn, event.at, null);
        break;
      }
      case "request.opened": {
        // The row names no turn, so it belongs to the turn it sits in.
        if (!openRequestIds.has(event.request.requestId)) break;
        slots.push({
          kind: "waiting",
          key: `waiting:${event.request.requestId}`,
          requestId: event.request.requestId,
          openedAt: event.at,
        });
        const stretch = state.current?.stretch ?? null;
        if (stretch !== null) stretch.frozenAt = event.at;
        break;
      }
      case "runtime.notice": {
        // Like a warning, a runtime notice is not a step of the work and does not end the stretch.
        slots.push({
          kind: "runtime-notice",
          key: `runtime-notice:${String(row.position)}`,
          message: event.message,
          at: event.at,
        });
        break;
      }
      case "unknown": {
        // An event type this client does not know, from a newer runner or controller. It is
        // drawn as a runtime notice, so the gap shows in the thread and the work goes on.
        slots.push({
          kind: "runtime-notice",
          key: `runtime-notice:${String(row.position)}`,
          message: buildUnknownEventMessage(event.originalType),
          at: event.at,
        });
        break;
      }
      case "runtime.warning": {
        // A warning tells the user about the work, and is not a step of it.
        // Ending the stretch here would split one divider into many on a
        // run of retries.
        slots.push({
          kind: "warning",
          key: `warning:${String(row.position)}`,
          message: event.message,
          at: event.at,
        });
        break;
      }
      case "runtime.error": {
        // An error does not end the stretch either. A turn the error failed
        // ends with its own `turn.completed`, which closes the stretch and
        // draws the turn's ending, so a split here would draw two lines for
        // one failure. A session that failed to start has no stretch.
        slots.push({
          kind: "error",
          key: `error:${String(row.position)}`,
          message: event.message ?? event.class,
          at: event.at,
        });
        break;
      }
      default:
        break;
    }
  }

  // An agent whose records say it cannot be running a turn is running none.
  // While it may be, its records may be older than the rows, so the rows decide.
  const last = state.current;
  if (last !== null && !last.finished && !agent.mayBeRunningTurn) {
    finishTurn(last, last.lastAt, null);
  }
  const running = last !== null && !last.finished ? last : null;
  const hasFace =
    parkedRequests.length === 0 && (running !== null || (last === null && agent.working));
  const openItemId = findOpenItem(rows);
  const faceAgent =
    hasFace && running !== null ? findFaceAgent(running, agents, openItemId) : undefined;
  const model = (turn: BuildingTurn | null): string => turn?.model ?? agent.model;

  const blocks: ThreadBlock[] = [];
  for (const slot of slots) {
    switch (slot.kind) {
      case "user":
      case "waiting":
      case "runtime-notice":
      case "warning":
      case "error":
        blocks.push(slot);
        break;
      case "agent": {
        const open = slot.itemId === openItemId && !slot.turn.finished;
        // A message that ended with no text, such as one the user stopped
        // before its first word, would draw a face and a meta line beside
        // nothing. Only an open message may be empty: its row waits for the
        // first word behind a "Writing…" line.
        if (slot.text === "" && !open) break;
        blocks.push({
          kind: "agent",
          key: `agent:${slot.itemId}`,
          itemId: slot.itemId,
          turnId: slot.turn.turnId,
          text: slot.text,
          startedAt: slot.startedAt,
          model: model(slot.turn),
          open,
          live: slot === faceAgent,
        });
        break;
      }
      case "work":
        if (slot.items.every((item) => item.kind === "reasoning")) break;
        blocks.push({
          kind: "work",
          key: `work:${slot.items[0]!.itemId}`,
          turnId: slot.turn.turnId,
          // Only a running item can wait on an open Request. An item the
          // harness already finished keeps its result.
          items: slot.items.map((item) =>
            awaitingItemIds.has(item.itemId) && item.result === "running"
              ? { ...item, result: "awaiting approval" as const }
              : item,
          ),
          startedAt: slot.startedAt,
          endedAt: slot.endedAt ?? slot.frozenAt,
        });
        break;
      case "ending":
        if (slot.turn.drawn) blocks.push(slot.block);
        break;
    }
  }
  // A running work stretch of the running turn ends the list: its "Working
  // for" divider already shows the agent is busy, so a status line under it
  // would say the same twice. A finished
  // stretch of an earlier turn shows no such divider, so it does not count.
  // A runtime notice, a warning or an error reports on the work and is not a step of
  // it, so a running stretch above one still shows the agent is busy.
  const lastBlock = blocks.findLast(
    (block) =>
      block.kind !== "runtime-notice" && block.kind !== "warning" && block.kind !== "error",
  );
  const endsOnRunningWork =
    lastBlock?.kind === "work" &&
    lastBlock.endedAt === null &&
    lastBlock.turnId === running?.turnId;
  if (hasFace && faceAgent === undefined && !endsOnRunningWork)
    blocks.push({ kind: "pending", key: "pending", since: running?.boundary ?? null });
  return blocks;
};

/**
 * Returns the agent message of the running turn that holds the working face,
 * or `undefined` when the face belongs on no message:
 *
 * - the open item (`openItemId`, from `findOpenItem`), when it is an agent
 *   message: the agent is writing it, even if the user steered a message in
 *   below it;
 * - else the turn's last started item, when it is an agent message that has
 *   completed. The turn's end usually lands a moment later, and moving the
 *   face to a status line in between would flash a second face.
 */
const findFaceAgent = (
  running: BuildingTurn,
  agents: ReadonlyMap<string, BuildingAgent>,
  openItemId: string | null,
): BuildingAgent | undefined => {
  const writing = openItemId === null ? undefined : agents.get(openItemId);
  if (writing !== undefined && writing.turn === running) return writing;
  const lastStarted =
    running.lastStartedItemId === null ? undefined : agents.get(running.lastStartedItemId);
  // A message with no text is not drawn, so it cannot hold the face.
  return lastStarted?.completed === true && lastStarted.text !== "" ? lastStarted : undefined;
};

/**
 * Returns `blocks` with one user block for each input in `sending`, the
 * messages on their way into the session (`splitQueuedInputs`), drawn from
 * their queued inputs until the inputs read them delivered. The transcript
 * can hold a message a moment before that (#623). They go after every other
 * block, but above a closing status line, so the agent's status stays the
 * last line. Each block is keyed by its input, is marked `sending`, and
 * names the session whose agent sent it, when another session's agent did
 * (`readInputSender`).
 *
 * Returns `blocks` itself when nothing is sending, so a memoized list keeps
 * its identity.
 */
export const appendSendingMessages = (
  blocks: readonly ThreadBlock[],
  sending: readonly Input[],
): readonly ThreadBlock[] => {
  if (sending.length === 0) return blocks;
  const messages = sending.map((input): UserBlock => {
    const senderSessionId = readInputSender(input);
    return {
      kind: "user",
      key: `sending:${input.id}`,
      itemId: input.id,
      text: input.text,
      attachments: input.attachments,
      skills: [],
      steered: false,
      ...(senderSessionId === undefined ? {} : { senderSessionId }),
      at: input.createdAt,
      sending: true,
    };
  });
  const closing = blocks.at(-1)?.kind === "pending" ? blocks.length - 1 : blocks.length;
  return [...blocks.slice(0, closing), ...messages, ...blocks.slice(closing)];
};

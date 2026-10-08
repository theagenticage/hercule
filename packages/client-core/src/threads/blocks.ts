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
import type { Attachment, TranscriptRow } from "@hercule/contract";
import { readJsonObject, readStringList } from "../json-shape";
import type { AgentState } from "./agent-state";
import { findOpenItem } from "./open-item";
import { buildThreadItem, readUserAttachments, type ThreadItem } from "./turns";

type ProviderEvent = TranscriptRow["event"];
type ItemStarted = Extract<ProviderEvent, { _tag: "item.started" }>;
type TurnEndState = Extract<ProviderEvent, { _tag: "turn.completed" }>["state"];

/** A tool item in a work stretch, with what its summary counts. */
export interface WorkItem extends ThreadItem {
  /** The files a file change touched, as its detail names them. Empty for any other item. */
  readonly paths: readonly string[];
}

/** A message the user sent: the opening one, or one steered into the running turn. */
export interface UserBlock {
  readonly kind: "user";
  readonly key: string;
  readonly itemId: string;
  readonly text: string;
  /** The images sent with the message, in the order they were attached. Empty when none were. */
  readonly attachments: readonly Attachment[];
  readonly at: string;
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
  /** Whether the thread's working face is on this message instead of on a live row. */
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
 * The working face at the bottom of a running turn, while no message holds it
 * and no running work stretch shows the agent is busy: right after the user's
 * message, and while the agent only reasons.
 */
export interface LiveBlock {
  readonly kind: "live";
  readonly key: string;
  /** The model the running turn runs on, or the agent's model. */
  readonly model: string;
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

export type ThreadBlock =
  UserBlock | WorkBlock | AgentBlock | EndingBlock | LiveBlock | WaitingBlock | WarningBlock;

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
  UserBlock | BuildingStretch | BuildingAgent | BuildingEnding | WaitingBlock | WarningBlock;

/**
 * Returns the files a file change item touched, as its detail names them:
 * the `paths` list, else one path from the tool's input or the detail. The
 * adapters spell it in their own ways (Claude Code's `input.file_path`,
 * Codex's `paths`, pi's `path`), and any of them may be absent.
 */
const readChangedPaths = (event: ItemStarted): readonly string[] => {
  if (event.kind !== "file_change") return [];
  const detail = readJsonObject(event.detail);
  const listed = readStringList(detail?.paths);
  if (listed !== undefined) return listed;
  const input = readJsonObject(detail?.input);
  const path = input?.file_path ?? input?.notebook_path ?? input?.path ?? detail?.path;
  return typeof path === "string" ? [path] : [];
};

/**
 * Returns the blocks of one agent's transcript in reading order: the
 * session's own agent's, or a subagent's. `agent` is that agent's state, and
 * decides what the rows cannot: whether the last turn still runs, the
 * Requests the agent waits on, and the model when a turn does not name one.
 *
 * - A `user` block per user message, and an `agent` block per assistant
 *   message, placed where the message started.
 * - A `work` block per stretch of items between two messages of a turn, once
 *   it holds an item other than reasoning.
 * - An `ending` block after a turn that was stopped, failed, or cut short. A
 *   turn is cut short when, before its `turn.completed`, its session exited,
 *   its session started again, another turn started, or the agent's records
 *   say it can no longer be running a turn (`mayBeRunningTurn`).
 * - A `waiting` block where one of the agent's open Requests opened, once its
 *   `request.opened` row has landed.
 * - A `warning` block per `runtime.warning` row, where the row sits. It does
 *   not end the work stretch it falls in: the stretch's divider stays one,
 *   above the warning, and items that start after the warning still join it.
 * - A `live` block at the end while the agent has no open Request, no agent
 *   message holds the working face, the last block is not the running
 *   turn's running `work` block, and either the last turn has not finished
 *   or, before any turn, the agent is working.
 *
 * The working face is on one block at most: the agent message the agent is
 * writing; else the running turn's last agent message, when nothing started
 * after it (its turn's end is about to land); else the `live` block. While
 * the running turn's running work stretch is the last block, the face is on
 * none: the stretch's divider shows the agent is busy.
 *
 * Each block's key is built from an item id, a turn id, a request id or, for
 * a warning, its row's position, so it stays the same as rows are appended.
 */
export const buildThreadBlocks = (
  rows: readonly TranscriptRow[],
  agent: AgentState,
): readonly ThreadBlock[] => {
  const openRequestIds = new Set(agent.openRequests.map((request) => request.requestId));
  const awaitingItemIds = new Set(agent.openRequests.map((request) => request.itemId));
  const slots: Slot[] = [];
  const turns = new Map<string, BuildingTurn>();
  const agents = new Map<string, BuildingAgent>();
  const workItems = new Map<
    string,
    { readonly stretch: BuildingStretch; readonly index: number }
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
          const detail = readJsonObject(event.detail);
          const text = typeof detail?.text === "string" ? detail.text : "";
          slots.push({
            kind: "user",
            key: `user:${event.itemId}`,
            itemId: event.itemId,
            text,
            attachments: readUserAttachments(detail),
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
          workItems.set(event.itemId, { stretch, index: stretch.items.length });
          stretch.items.push({
            ...buildThreadItem(event),
            paths: readChangedPaths(event),
          });
        }
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
          work.stretch.items[work.index] = {
            ...work.stretch.items[work.index]!,
            result: event.status,
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
    agent.openRequests.length === 0 && (running !== null || (last === null && agent.working));
  const openItemId = findOpenItem(rows);
  const faceAgent =
    hasFace && running !== null ? findFaceAgent(running, agents, openItemId) : undefined;
  const model = (turn: BuildingTurn | null): string => turn?.model ?? agent.model;

  const blocks: ThreadBlock[] = [];
  for (const slot of slots) {
    switch (slot.kind) {
      case "user":
      case "waiting":
      case "warning":
        blocks.push(slot);
        break;
      case "agent":
        blocks.push({
          kind: "agent",
          key: `agent:${slot.itemId}`,
          itemId: slot.itemId,
          turnId: slot.turn.turnId,
          text: slot.text,
          startedAt: slot.startedAt,
          model: model(slot.turn),
          open: slot.itemId === openItemId && !slot.turn.finished,
          live: slot === faceAgent,
        });
        break;
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
  // for" divider already shows the agent is busy, and a face row under it
  // would look like a response that has started when it has not. A finished
  // stretch of an earlier turn shows no such divider, so it does not count.
  const lastBlock = blocks.at(-1);
  const endsOnRunningWork =
    lastBlock?.kind === "work" &&
    lastBlock.endedAt === null &&
    lastBlock.turnId === running?.turnId;
  if (hasFace && faceAgent === undefined && !endsOnRunningWork)
    blocks.push({ kind: "live", key: "live", model: model(running) });
  return blocks;
};

/**
 * Returns the agent message of the running turn that holds the working face,
 * or `undefined` when the face belongs on a live block:
 *
 * - the open item (`openItemId`, from `findOpenItem`), when it is an agent
 *   message: the agent is writing it, even if the user steered a message in
 *   below it;
 * - else the turn's last started item, when it is an agent message that has
 *   completed. The turn's end usually lands a moment later, and moving the
 *   face to a live block in between would flash a second face.
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
  return lastStarted?.completed === true ? lastStarted : undefined;
};

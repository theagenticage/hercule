/**
 * Groups a transcript into turns. A transcript is a flat log of provider
 * events, and a turn is what the thread screen renders. Grouping here means
 * the transcript column only renders turns, and no provider event names leak
 * into it.
 *
 * The assistant's text is never on `item.started` or `item.completed`: it
 * only arrives as `content.delta` events (spec 06 §6.3-6.4). So:
 *
 * - the user's message comes from `detail.text` on the `user_message` item's
 *   `item.started`;
 * - the assistant's text is the turn's `assistant_text` deltas joined in
 *   transcript order.
 */
import type { TranscriptRow } from "@hercule/contract";
import { readJsonObject } from "../json-shape";

type ProviderEvent = TranscriptRow["event"];
type ItemStarted = Extract<ProviderEvent, { _tag: "item.started" }>;
type ItemKind = ItemStarted["kind"];
type ItemStatus = Extract<ProviderEvent, { _tag: "item.completed" }>["status"];

export interface ThreadItem {
  readonly itemId: string;
  readonly verb: string;
  readonly target: string;
  /**
   * `awaiting approval` marks a running item the session's open request is
   * about. The text is decided here rather than in the column that shows it,
   * so both screens that render an item show the same text.
   */
  readonly result: "completed" | "failed" | "declined" | "running" | "awaiting approval";
}

export interface ThreadTurn {
  readonly turnId: string;
  readonly user: string;
  readonly items: readonly ThreadItem[];
  readonly assistantText: string;
  readonly startedAt: string;
  readonly duration: number | null;
}

/** The verb shown for each item kind. It is one word per kind, never more detailed. */
const VERBS: Partial<Record<ItemKind, string>> = {
  reasoning: "reasoning",
  command_execution: "command",
  file_change: "edit",
  tool_call: "tool",
  web_search: "search",
  subagent: "subagent",
  plan: "plan",
  context_compaction: "compaction",
  error: "error",
};

const readItemVerb = (kind: ItemKind): string => VERBS[kind] ?? "unknown";

/** Long enough for a useful summary, short enough that a whole file never ends up in a row. */
const MAX_TARGET_LENGTH = 200;

/**
 * Returns the field of an item's `detail` that is worth showing in a row: the
 * command a shell item ran, the path a file item changed, or a tool call's
 * description. Returns `undefined` when none of these is present, and the
 * caller then shows the raw JSON. `detail` is JSON owned by the adapter
 * (spec 06 §6.3), so every field is optional.
 */
const findDetailText = (detail: Record<string, unknown>): string | undefined => {
  const input = readJsonObject(detail.input);
  const candidate =
    input?.command ??
    detail.command ??
    input?.file_path ??
    detail.path ??
    input?.description ??
    detail.description ??
    detail.name;
  return typeof candidate === "string" ? candidate : undefined;
};

/**
 * Returns a one-line summary of an item's `detail`, truncated to
 * `MAX_TARGET_LENGTH`. A string is used as it is; any other value is
 * summarized by `findDetailText`, or else shown as compact JSON.
 */
const summarizeDetail = (detail: unknown): string => {
  if (detail === undefined || detail === null) return "";
  const text =
    typeof detail === "string"
      ? detail
      : (findDetailText(readJsonObject(detail) ?? {}) ?? JSON.stringify(detail));
  const line = text.split("\n")[0] ?? "";
  return line.length > MAX_TARGET_LENGTH ? `${line.slice(0, MAX_TARGET_LENGTH)}…` : line;
};

interface Building {
  turnId: string;
  startedAt: string;
  completedAt: string | null;
  user: string;
  items: ThreadItem[];
  itemIndex: Map<string, number>;
  assistantText: string;
  /**
   * The item of the last `assistant_text` delta, used to insert a paragraph
   * break when a new item starts.
   */
  lastAssistantItemId: string | null;
}

/** Returns the transcript's turns, in the order they first appear. */
export const buildTurns = (
  rows: readonly TranscriptRow[],
  /** The item the session's open request is about, if it has one. */
  awaitingItemId?: string,
): readonly ThreadTurn[] => {
  const turns = new Map<string, Building>();

  const findOrStartTurn = (turnId: string, fallbackAt: string): Building => {
    const held = turns.get(turnId);
    if (held !== undefined) return held;
    const made: Building = {
      turnId,
      startedAt: fallbackAt,
      completedAt: null,
      user: "",
      items: [],
      itemIndex: new Map(),
      assistantText: "",
      lastAssistantItemId: null,
    };
    turns.set(turnId, made);
    return made;
  };

  for (const row of rows) {
    const event: ProviderEvent = row.event;
    switch (event._tag) {
      case "turn.started": {
        findOrStartTurn(event.turnId, event.at).startedAt = event.at;
        break;
      }
      case "turn.completed": {
        findOrStartTurn(event.turnId, event.at).completedAt = event.at;
        break;
      }
      case "item.started": {
        const turn = findOrStartTurn(event.turnId, event.at);
        if (event.kind === "user_message") {
          // A steered input adds a second `user_message` to the running turn
          // (spec 06 §5), so its text is appended to the first, never replaces it.
          const detail = event.detail as { text?: string } | undefined;
          const text = detail?.text ?? "";
          turn.user = turn.user === "" ? text : `${turn.user}\n\n${text}`;
        } else if (event.kind !== "assistant_message") {
          turn.itemIndex.set(event.itemId, turn.items.length);
          turn.items.push({
            itemId: event.itemId,
            verb: readItemVerb(event.kind),
            target: summarizeDetail(event.detail),
            result: "running",
          });
        }
        break;
      }
      case "item.completed": {
        const turn = findOrStartTurn(event.turnId, event.at);
        if (event.kind === "user_message" || event.kind === "assistant_message") break;
        const index = turn.itemIndex.get(event.itemId);
        if (index === undefined) break;
        const status: ItemStatus = event.status;
        turn.items[index] = { ...turn.items[index]!, result: status };
        break;
      }
      case "content.delta": {
        if (event.streamKind !== "assistant_text") break;
        const turn = findOrStartTurn(event.turnId, event.at);
        // A turn can make any number of model calls (spec 06 §6.2), so its
        // text can come from several assistant_message items. Start each new
        // item on a new paragraph, so two items never run together as one
        // sentence.
        if (turn.lastAssistantItemId !== null && turn.lastAssistantItemId !== event.itemId) {
          turn.assistantText += "\n\n";
        }
        turn.assistantText += event.delta;
        turn.lastAssistantItemId = event.itemId;
        break;
      }
      default:
        break;
    }
  }

  return Array.from(turns.values()).map((turn) => ({
    turnId: turn.turnId,
    user: turn.user,
    // Only a running item can be waiting for the open request. An item the
    // harness already finished keeps its result, even if the request still
    // refers to it.
    items: turn.items.map((item) =>
      item.itemId === awaitingItemId && item.result === "running"
        ? { ...item, result: "awaiting approval" as const }
        : item,
    ),
    assistantText: turn.assistantText,
    startedAt: turn.startedAt,
    duration:
      turn.completedAt === null ? null : Date.parse(turn.completedAt) - Date.parse(turn.startedAt),
  }));
};

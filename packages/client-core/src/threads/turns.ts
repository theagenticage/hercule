/**
 * A transcript is a flat log of provider events; a turn is what the thread
 * surface renders. Grouping it here means the transcript column is a render
 * of this shape and nothing about the provider vocabulary leaks into it.
 *
 * Text is never on `item.started` / `item.completed` for a message item - it
 * only ever arrives as `content.delta` (spec 06 §6.3-6.4) - so the user's
 * message comes off `item.started`'s `detail.text` and the assistant's comes
 * off the concatenated `assistant_text` deltas in the turn, in the order the
 * transcript carries them.
 */
import type { TranscriptRow } from "@hercule/contract";

type ProviderEvent = TranscriptRow["event"];
type ItemStarted = Extract<ProviderEvent, { _tag: "item.started" }>;
type ItemKind = ItemStarted["kind"];
type ItemStatus = Extract<ProviderEvent, { _tag: "item.completed" }>["status"];

export interface ThreadItem {
  readonly itemId: string;
  readonly verb: string;
  readonly target: string;
  /**
   * `awaiting approval` is what an open item the session is parked on reads
   * as: the word is here rather than in the column that prints it, so both
   * surfaces that render an item say the same thing about it.
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

/** The word a tool item's verb is drawn from. Never expanded per kind's fine detail. */
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

/** Long enough to read as a summary, short enough that a whole file body never lands in a row. */
const MAX_TARGET_LENGTH = 200;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/**
 * The one field of an item's `detail` a reader actually wants in a row: the
 * command a shell item ran, the path a file item touched, or the description
 * a tool call carried - never the row's own raw JSON when one of those exists.
 * `detail` is adapter-owned Json (spec 06 §6.3), so every field is read
 * optionally; the fallback is the same JSON dump this always fell back to.
 */
const findDetailText = (detail: Record<string, unknown>): string | undefined => {
  const input = asRecord(detail.input);
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

/** `detail` is adapter-owned Json; a plain string speaks for itself, anything else is compact JSON. */
const summarizeDetail = (detail: unknown): string => {
  if (detail === undefined || detail === null) return "";
  const text =
    typeof detail === "string"
      ? detail
      : (findDetailText(asRecord(detail) ?? {}) ?? JSON.stringify(detail));
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
  /** Which item `assistantText`'s last delta belonged to - a turn's own paragraph break. */
  lastAssistantItemId: string | null;
}

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
          // A steered input opens a second `user_message` in the turn it folded
          // into (spec 06 §5), so the first one is appended to, never replaced.
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
        // A turn holds any number of model calls (spec 06 §6.2), so its
        // assistant text can carry more than one assistant_message item; a
        // new item's first delta after another's is a paragraph break, not a
        // continuation, so the two never run together as one sentence.
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
    // Only an item still running can be the one a request is parked on: one
    // the harness already settled keeps its own outcome, whatever the row
    // still names.
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

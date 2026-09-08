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
import type { TranscriptRow } from "@hydra/contract";

type ProviderEvent = TranscriptRow["event"];
type ItemStarted = Extract<ProviderEvent, { _tag: "item.started" }>;
type ItemKind = ItemStarted["kind"];
type ItemStatus = Extract<ProviderEvent, { _tag: "item.completed" }>["status"];

export interface ThreadItem {
  readonly itemId: string;
  readonly verb: string;
  readonly target: string;
  readonly result: "completed" | "failed" | "declined" | "running";
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

const verbOf = (kind: ItemKind): string => VERBS[kind] ?? "unknown";

/** Long enough to read as a summary, short enough that a whole file body never lands in a row. */
const MAX_TARGET_LENGTH = 200;

/** `detail` is adapter-owned Json; a plain string speaks for itself, anything else is compact JSON. */
const summarize = (detail: unknown): string => {
  if (detail === undefined || detail === null) return "";
  const line = typeof detail === "string" ? (detail.split("\n")[0] ?? "") : JSON.stringify(detail);
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
}

export const turnsOf = (rows: readonly TranscriptRow[]): readonly ThreadTurn[] => {
  const turns = new Map<string, Building>();

  const turnOf = (turnId: string, fallbackAt: string): Building => {
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
    };
    turns.set(turnId, made);
    return made;
  };

  for (const row of rows) {
    const event: ProviderEvent = row.event;
    switch (event._tag) {
      case "turn.started": {
        turnOf(event.turnId, event.at).startedAt = event.at;
        break;
      }
      case "turn.completed": {
        turnOf(event.turnId, event.at).completedAt = event.at;
        break;
      }
      case "item.started": {
        const turn = turnOf(event.turnId, event.at);
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
            verb: verbOf(event.kind),
            target: summarize(event.detail),
            result: "running",
          });
        }
        break;
      }
      case "item.completed": {
        const turn = turnOf(event.turnId, event.at);
        if (event.kind === "user_message" || event.kind === "assistant_message") break;
        const index = turn.itemIndex.get(event.itemId);
        if (index === undefined) break;
        const status: ItemStatus = event.status;
        turn.items[index] = { ...turn.items[index]!, result: status };
        break;
      }
      case "content.delta": {
        if (event.streamKind !== "assistant_text") break;
        turnOf(event.turnId, event.at).assistantText += event.delta;
        break;
      }
      default:
        break;
    }
  }

  return Array.from(turns.values()).map((turn) => ({
    turnId: turn.turnId,
    user: turn.user,
    items: turn.items,
    assistantText: turn.assistantText,
    startedAt: turn.startedAt,
    duration:
      turn.completedAt === null ? null : Date.parse(turn.completedAt) - Date.parse(turn.startedAt),
  }));
};

/**
 * Works out what one event reported by a runner does to a session: which
 * stream rows it produces, and which status it leaves the session in. The code
 * is pure. The service does the rest: it writes the rows, and it decides
 * whether to trust the event.
 *
 * Deltas are never stored per token, so a streaming reply writes a handful of
 * rows instead of one per token. They are held per (agent, item, stream kind)
 * and flushed as one row when:
 *
 * - the item completes,
 * - the turn of the agent that produced them completes,
 * - the session exits,
 * - the held text reaches `DELTA_FLUSH_BYTES`, so a long item is stored in
 *   pieces and a crash loses only its tail. The piece ends at the last
 *   whitespace in the text held before the newest delta, and the rest stays
 *   held, so no word is split across two rows. Everything held is flushed
 *   when the newest delta alone reaches the size, or when that text has no
 *   whitespace in its last `DELTA_FLUSH_BYTES / 2` characters.
 *
 * Every other event becomes its own row. Spec 04 (Streaming) owns the rule
 * that deltas are not stored per token.
 *
 * A session's events come from its own agent and from its subagents. Only the
 * session's own agent moves the session's status and closes its own Requests
 * at the end of a turn (spec 06 section 13.1).
 */
import type { ItemKind, ProviderEvent, StreamKind, SubagentId } from "@hercule/protocol";
import type { SessionRequest, SessionStatus } from "@hercule/contract";

/**
 * How much held delta text forces a flush inside one item. It is roughly a
 * screenful of command output. A crash in the middle of an item loses only the
 * tail, not the whole transcript, and a streaming reply writes a handful of
 * rows instead of one per token.
 */
export const DELTA_FLUSH_BYTES = 4 * 1024;

/** The text held for one (item, stream kind), and where it came from. */
interface Held {
  /** The first delta held. The merged row keeps its id and timestamp. */
  readonly first: Extract<ProviderEvent, { _tag: "content.delta" }>;
  readonly text: string;
  /** The sequence number of the last delta merged in. Writing the row is idempotent on it. */
  readonly seq: number;
}

/** One session's ingest state. Replaced whole, never edited in place. */
export interface Tracked {
  /** The highest sequence number applied so far, after adding `base`. */
  readonly lastSeq: number;
  /**
   * The offset added to the sequence numbers of the session's current process.
   * A runner numbers a session's events from zero in each process, and a
   * resumed session is a second process under the same id, so without the
   * offset the two would collide. Zero for a session that was never resumed.
   */
  readonly base: number;
  readonly buffers: ReadonlyMap<string, Held>;
}

/** The result of folding one event: rows to append, and the status it leaves behind. */
export interface Folded {
  readonly rows: ReadonlyArray<StreamRow>;
  /** `undefined` when this event does not change the session's status. */
  readonly status: SessionStatus | undefined;
  readonly next: Tracked;
}

/** One row of the append-only stream, before the position is assigned. */
export interface StreamRow {
  readonly seq: number;
  readonly at: string;
  readonly event: ProviderEvent;
}

export const startTracking = (from: Omit<Tracked, "buffers">): Tracked => ({
  ...from,
  buffers: new Map(),
});

/**
 * Returns the agent an event is stored under: the subagent it names, or
 * `undefined` for the session's own agent. A `subagent.started` belongs to the
 * agent that started the subagent, so it is stored under its
 * `parentSubagentId` rather than the id it introduces (spec 06 section 13.2).
 */
export const attributeEvent = (event: ProviderEvent): SubagentId | undefined => {
  if (event._tag === "subagent.started") return event.parentSubagentId;
  return "subagentId" in event ? event.subagentId : undefined;
};

/**
 * The item kinds that count as tool calls. An `item.started` of one of these
 * kinds adds one to its session's `toolCalls`, and one to the `toolCalls` of
 * the subagent that reported it, when a subagent did. Handing work to a
 * subagent, the `subagent` kind, counts as a call too.
 *
 * Migration 0067 copies this list to count the tool calls stored before it.
 * A kind added here counts only the calls stored after the change, unless a
 * new migration counts the earlier ones.
 */
export const TOOL_CALL_KINDS: ReadonlySet<ItemKind> = new Set([
  "command_execution",
  "file_change",
  "file_read",
  "file_search",
  "tool_call",
  "web_search",
  "subagent",
]);

/**
 * Builds the key one held text is stored under. Two agents may stream at the
 * same time, and two stream kinds on one item are two separate texts, so the
 * key includes all three. No vendor id contains a NUL character, so using it
 * as the separator means two keys cannot collide.
 */
const buildBufferKey = (
  agent: SubagentId | undefined,
  itemId: string,
  streamKind: StreamKind,
): string => `${agent ?? ""}\u0000${itemId}\u0000${streamKind}`;

/**
 * Returns the index just after the last whitespace in the last
 * `DELTA_FLUSH_BYTES / 2` characters of `text`, or `undefined` when there is
 * none. Cutting `text` there ends the first part on a word break and starts
 * the second on a word.
 *
 * Whitespace further back is not used. Text that ends in one long word, such
 * as an encoded blob, would keep that word held, and every later delta would
 * then cut off a tiny row.
 */
const findWordBreakNearEnd = (text: string): number | undefined => {
  const stop = Math.max(0, text.length - DELTA_FLUSH_BYTES / 2);
  for (let index = text.length - 1; index > stop; index--) {
    if (/\s/.test(text[index]!)) return index + 1;
  }
  return undefined;
};

const toFlushedRow = (held: Held): StreamRow => ({
  seq: held.seq,
  at: held.first.at,
  event: { ...held.first, delta: held.text },
});

/**
 * Returns the status an event leaves the session in, or `undefined` when it
 * changes nothing. Only the session's own agent moves the status: a subagent's
 * turn never makes the session busy or idle.
 */
const computeStatusAfter = (event: ProviderEvent): SessionStatus | undefined => {
  if (attributeEvent(event) !== undefined) return undefined;
  switch (event._tag) {
    case "session.started":
      return "idle";
    case "turn.started":
      return "busy";
    case "turn.completed":
      return "idle";
    case "session.exited":
      return "exited";
    default:
      return undefined;
  }
};

/** An event that can open or close one of the Requests a session waits on. */
export type RequestEvent = Extract<
  ProviderEvent,
  { readonly _tag: "request.opened" | "request.resolved" | "turn.completed" | "session.exited" }
>;

/** An event that can close one of the Requests a session waits on. */
export type RequestClosingEvent = Exclude<RequestEvent, { readonly _tag: "request.opened" }>;

/** Checks whether an event can open or close one of the Requests a session waits on. */
export const isRequestEvent = (event: ProviderEvent): event is RequestEvent =>
  event._tag === "request.opened" ||
  event._tag === "request.resolved" ||
  event._tag === "turn.completed" ||
  event._tag === "session.exited";

/**
 * Returns the session's open Requests after this event, oldest first, given
 * the list open now:
 *
 * - `request.opened` adds the Request at the end, with the subagent that
 *   asked;
 * - `request.resolved` removes the Request it names, and leaves the others;
 * - `turn.completed` removes the Requests of the agent whose turn ended, and
 *   only those: the session's own agent ending its turn leaves its subagents'
 *   Requests open;
 * - `session.exited` removes every Request.
 *
 * Returns `open` itself when nothing changed, so a caller can tell a change by
 * comparing references. A Request reported again with an id already open
 * changes nothing.
 */
export const computeOpenRequestsAfter = (
  event: RequestEvent,
  open: ReadonlyArray<SessionRequest>,
): ReadonlyArray<SessionRequest> => {
  const keep = (predicate: (request: SessionRequest) => boolean) => {
    const kept = open.filter(predicate);
    return kept.length === open.length ? open : kept;
  };
  switch (event._tag) {
    case "request.opened": {
      if (open.some((request) => request.requestId === event.request.requestId)) return open;
      const asker = event.subagentId === undefined ? {} : { subagentId: event.subagentId };
      return [...open, { ...event.request, ...asker }];
    }
    case "request.resolved":
      return keep((request) => request.requestId !== event.requestId);
    case "turn.completed":
      return keep((request) => request.subagentId !== event.subagentId);
    case "session.exited":
      return open.length === 0 ? open : [];
  }
};

/**
 * Compares a session's open Requests before and after a change, by request
 * id. Returns the Requests that closed, in the order they were open, and the
 * ones that opened, oldest first.
 */
export const compareOpenRequests = (
  before: ReadonlyArray<SessionRequest>,
  after: ReadonlyArray<SessionRequest>,
): {
  readonly closed: ReadonlyArray<SessionRequest>;
  readonly opened: ReadonlyArray<SessionRequest>;
} => {
  const afterIds = new Set(after.map((request) => request.requestId));
  const beforeIds = new Set(before.map((request) => request.requestId));
  return {
    closed: before.filter((request) => !afterIds.has(request.requestId)),
    opened: after.filter((request) => !beforeIds.has(request.requestId)),
  };
};

/**
 * Applies one event reported by the runner, at sequence number
 * `tracked.base + reported`. Returns `undefined` for a sequence number the
 * session has already seen, which means a replayed frame that writes nothing.
 * The caller keeps `next` only after the write commits, so a failed
 * transaction leaves the state as it was.
 */
export const fold = (
  tracked: Tracked,
  reported: number,
  event: ProviderEvent,
): Folded | undefined => {
  const seq = tracked.base + reported;
  if (seq <= tracked.lastSeq) return undefined;
  const buffers = new Map(tracked.buffers);
  const rows: Array<StreamRow> = [];

  const agent = attributeEvent(event);
  /** Flushes the held texts that `isFlushed` picks, in the order they were first held. */
  const flushBuffers = (isFlushed: (held: Held) => boolean): void => {
    for (const [key, held] of buffers) {
      if (!isFlushed(held)) continue;
      rows.push(toFlushedRow(held));
      buffers.delete(key);
    }
  };

  if (event._tag === "content.delta") {
    const key = buildBufferKey(agent, event.itemId, event.streamKind);
    const held = buffers.get(key);
    const grown: Held =
      held === undefined
        ? { first: event, text: event.delta, seq }
        : { first: held.first, text: held.text + event.delta, seq };
    if (grown.text.length < DELTA_FLUSH_BYTES) {
      buffers.set(key, grown);
    } else {
      const cut = held === undefined ? undefined : findWordBreakNearEnd(held.text);
      if (held === undefined || cut === undefined) {
        rows.push(toFlushedRow(grown));
        buffers.delete(key);
      } else {
        // The row ends on a word break, so full-text search finds every word
        // whole. It holds text up to an earlier delta only, so it takes that
        // delta's sequence number, and the rest stays held under this one:
        // two rows never share a sequence number, which would drop the second.
        rows.push(toFlushedRow({ ...held, text: held.text.slice(0, cut) }));
        const rest: Held = { first: event, text: held.text.slice(cut) + event.delta, seq };
        // A delta that alone reaches the bound is written at once, as one
        // with no word break would be, so no more than the bound is ever held.
        if (rest.text.length < DELTA_FLUSH_BYTES) {
          buffers.set(key, rest);
        } else {
          rows.push(toFlushedRow(rest));
          buffers.delete(key);
        }
      }
    }
    // A delta is not a boundary and moves nothing: `busy` is already where the
    // turn that produced it put the session.
    return { rows, status: undefined, next: { lastSeq: seq, base: tracked.base, buffers } };
  }

  // The three events after which no more text arrives for the held deltas.
  // An item or a turn ends only for the agent that reported it; another agent
  // may still be streaming.
  const isOwnAgent = (held: Held) => held.first.subagentId === agent;
  if (event._tag === "item.completed") {
    flushBuffers((held) => isOwnAgent(held) && held.first.itemId === event.itemId);
  }
  if (event._tag === "turn.completed") flushBuffers(isOwnAgent);
  if (event._tag === "session.exited") flushBuffers(() => true);

  rows.push({ seq, at: event.at, event });
  return {
    rows,
    status: computeStatusAfter(event),
    next: { lastSeq: seq, base: tracked.base, buffers },
  };
};

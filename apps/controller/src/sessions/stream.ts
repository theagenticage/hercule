/**
 * Works out what one event reported by a runner does to a session: which
 * stream rows it produces, and which status it leaves the session in. The code
 * is pure. The service does the rest: it writes the rows, and it decides
 * whether to trust the event.
 *
 * Deltas are never stored per token (spec 04, Streaming). They are held per
 * (item, stream kind) and flushed as one row when:
 *
 * - the item completes,
 * - the turn completes,
 * - the session exits,
 * - the held text reaches `DELTA_FLUSH_BYTES`. Spec 04 left the flush rule
 *   inside an item open; this is the rule chosen here.
 *
 * Every other event becomes its own row.
 */
import type { OpenRequest, ProviderEvent, StreamKind } from "@hercule/protocol";
import type { SessionStatus } from "@hercule/contract";

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
 * Two stream kinds on one item are two separate texts, so the key includes
 * both. No vendor id contains a NUL character, so using it as the separator
 * means two keys cannot collide.
 */
const buildBufferKey = (itemId: string, streamKind: StreamKind): string =>
  `${itemId}\u0000${streamKind}`;

const toFlushedRow = (held: Held): StreamRow => ({
  seq: held.seq,
  at: held.first.at,
  event: { ...held.first, delta: held.text },
});

const computeStatusAfter = (event: ProviderEvent): SessionStatus | undefined => {
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

/**
 * Returns the session's open request after this event, given the request open
 * now. Returns:
 *
 * - the new request, for an event that opens one;
 * - `null`, for an event that closes the open request;
 * - `undefined`, for an event that does not change it.
 *
 * A completed turn and an exited harness both close the open request, whether
 * or not it was ever answered, because the question ended with the turn. They
 * return `null` only when a request is open: clearing nothing would still make
 * every client watching the session refetch it. A `request.resolved` event
 * names its own request, so one for an older request leaves the open one
 * alone.
 */
export const computeOpenRequestAfter = (
  event: ProviderEvent,
  open: OpenRequest | null,
): OpenRequest | null | undefined => {
  switch (event._tag) {
    case "request.opened":
      return event.request;
    case "request.resolved":
      return open?.requestId === event.requestId ? null : undefined;
    case "turn.completed":
    case "session.exited":
      return open === null ? undefined : null;
    default:
      return undefined;
  }
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

  const flushBuffers = (itemId?: string): void => {
    for (const [key, held] of buffers) {
      if (itemId !== undefined && held.first.itemId !== itemId) continue;
      rows.push(toFlushedRow(held));
      buffers.delete(key);
    }
  };

  if (event._tag === "content.delta") {
    const key = buildBufferKey(event.itemId, event.streamKind);
    const held = buffers.get(key);
    const grown: Held =
      held === undefined
        ? { first: event, text: event.delta, seq }
        : { first: held.first, text: held.text + event.delta, seq };
    if (grown.text.length >= DELTA_FLUSH_BYTES) {
      rows.push(toFlushedRow(grown));
      buffers.delete(key);
    } else {
      buffers.set(key, grown);
    }
    // A delta is not a boundary and moves nothing: `busy` is already where the
    // turn that produced it put the session.
    return { rows, status: undefined, next: { lastSeq: seq, base: tracked.base, buffers } };
  }

  // The three events after which no more text arrives for the held deltas.
  if (event._tag === "item.completed") flushBuffers(event.itemId);
  if (event._tag === "turn.completed" || event._tag === "session.exited") flushBuffers();

  rows.push({ seq, at: event.at, event });
  return {
    rows,
    status: computeStatusAfter(event),
    next: { lastSeq: seq, base: tracked.base, buffers },
  };
};

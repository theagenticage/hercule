/**
 * What one reported event does to a session: which stream rows it produces, and
 * where it leaves the status axis. Pure, and separate from the service, which
 * does the two things this cannot: it writes, and it decides when to believe.
 *
 * Deltas are never persisted per token (spec 04, Streaming). They are held per
 * (item, stream kind) and flushed at an item boundary, a turn boundary, an
 * exit, and - the in-item cadence spec 04 left open and this build pins - once
 * the held text passes `DELTA_FLUSH_BYTES`. Every other event is its own row.
 */
import type { OpenRequest, ProviderEvent, StreamKind } from "@hydra/protocol";
import type { SessionStatus } from "@hydra/contract";

/**
 * How much held delta text forces a flush inside one item. Roughly a screenful
 * of command output: a crash mid-item loses a tail rather than a transcript,
 * and a streaming reply writes a handful of rows rather than one per token.
 */
export const DELTA_FLUSH_BYTES = 4 * 1024;

/** The text held for one (item, stream kind), and where it came from. */
interface Held {
  /** The first delta of the run, whose id and instant the coalesced row keeps. */
  readonly first: Extract<ProviderEvent, { _tag: "content.delta" }>;
  readonly text: string;
  /** The sequence of the last delta folded in: what the row is idempotent on. */
  readonly seq: number;
}

/** One session's ingest state. Replaced whole, never edited in place. */
export interface Tracked {
  /** The highest applied sequence, in the space `base` puts them in. */
  readonly lastSeq: number;
  /**
   * What this session's current process's sequence numbers are counted from.
   * A machine numbers a session's events from zero per process, and a resumed
   * session is a second process under the same id, so the two would otherwise
   * collide; zero for a session that has never been resumed.
   */
  readonly base: number;
  readonly buffers: ReadonlyMap<string, Held>;
}

/** What one event turns into: rows to append, and the status it leaves behind. */
export interface Folded {
  readonly rows: ReadonlyArray<StreamRow>;
  /** Absent when this event does not move the session. */
  readonly status: SessionStatus | undefined;
  readonly next: Tracked;
}

/** One row of the append-only stream, before the position is assigned. */
export interface StreamRow {
  readonly seq: number;
  readonly at: string;
  readonly event: ProviderEvent;
}

export const track = (from: Omit<Tracked, "buffers">): Tracked => ({
  ...from,
  buffers: new Map(),
});

/**
 * Two stream kinds on one item are two runs of text, so the key carries both.
 * The NUL separator is what no vendor id contains, so ids cannot collide.
 */
const keyOf = (itemId: string, streamKind: StreamKind): string => `${itemId}\u0000${streamKind}`;

const flushed = (held: Held): StreamRow => ({
  seq: held.seq,
  at: held.first.at,
  event: { ...held.first, delta: held.text },
});

const statusAfter = (event: ProviderEvent): SessionStatus | undefined => {
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
 * Where this event leaves the request the session is parked on, given the one
 * it is parked on now: `undefined` for an event that says nothing about it,
 * `null` for one that ends it, and the request itself for one that opens it.
 *
 * A turn that completes and a harness that exits both end any park with them,
 * whether or not the answer ever arrived: the question died with the turn. A
 * resolution names its own request, so one for a park that is no longer open
 * leaves the open one alone.
 */
export const openRequestAfter = (
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
      return null;
    default:
      return undefined;
  }
};

/**
 * Applies one reported event, under the sequence `base` puts it at. `undefined`
 * is a sequence this session has already seen - a replayed frame - and writes
 * nothing. The caller keeps `next` only once the write commits, so a failed
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

  const flush = (itemId?: string): void => {
    for (const [key, held] of buffers) {
      if (itemId !== undefined && held.first.itemId !== itemId) continue;
      rows.push(flushed(held));
      buffers.delete(key);
    }
  };

  if (event._tag === "content.delta") {
    const key = keyOf(event.itemId, event.streamKind);
    const held = buffers.get(key);
    const grown: Held =
      held === undefined
        ? { first: event, text: event.delta, seq }
        : { first: held.first, text: held.text + event.delta, seq };
    if (grown.text.length >= DELTA_FLUSH_BYTES) {
      rows.push(flushed(grown));
      buffers.delete(key);
    } else {
      buffers.set(key, grown);
    }
    // A delta is not a boundary and moves nothing: `busy` is already where the
    // turn that produced it put the session.
    return { rows, status: undefined, next: { lastSeq: seq, base: tracked.base, buffers } };
  }

  // The three moments held text has nothing more coming for it.
  if (event._tag === "item.completed") flush(event.itemId);
  if (event._tag === "turn.completed" || event._tag === "session.exited") flush();

  rows.push({ seq, at: event.at, event });
  return { rows, status: statusAfter(event), next: { lastSeq: seq, base: tracked.base, buffers } };
};

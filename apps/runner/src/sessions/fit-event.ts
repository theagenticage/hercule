/**
 * Keeps every event the runner sends within one WebSocket frame.
 *
 * The controller closes the runner's socket on a frame larger than
 * `MAX_FRAME_BYTES`, and that ends the stream of every session on the runner.
 * Most fields of an event are bounded by the protocol, but `raw`, an item's
 * `detail`, a `content.delta` and a turn's structured result are not: a
 * Claude `Read` of a large image puts its bytes in `detail` and again in
 * `raw`. So the supervisor passes every event through `fitEventToFrame`
 * before it numbers it (spec 06 section 6).
 */
import { MAX_FRAME_BYTES, type ProviderEvent } from "@hercule/protocol";

type ContentDelta = Extract<ProviderEvent, { readonly _tag: "content.delta" }>;

type TurnCompleted = Extract<ProviderEvent, { readonly _tag: "turn.completed" }>;

/**
 * The most bytes one UTF-16 code unit can take in a frame. JSON escapes a
 * control character as, for example, `\u0001`, and a lone surrogate as
 * `\ud800`: six bytes each. Every other code unit takes at most three bytes of
 * UTF-8, and a surrogate pair takes four bytes for its two units.
 */
const MAX_BYTES_PER_UNIT = 6;

const BYTES_PER_MIB = 1024 * 1024;

/**
 * Measures the bytes `event` takes on the socket, as the UTF-8 text of its
 * `sessionEvent` frame. The frame is measured with the largest possible
 * sequence number, so the result holds for whatever number the event gets.
 *
 * The socket sends `JSON.stringify` of the frame as the `RunnerToController`
 * schema encodes it. That encoding transforms no field of an event: it may
 * write the keys in another order, but every value stays the same, so the byte
 * count is the same.
 */
const measureFrameBytes = (event: ProviderEvent): number =>
  Buffer.byteLength(
    JSON.stringify({ _tag: "sessionEvent", seq: Number.MAX_SAFE_INTEGER, event }),
    "utf8",
  );

/** Checks whether a UTF-16 code unit is the first half of a surrogate pair. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/**
 * Splits a `content.delta` into consecutive deltas whose frames each fit, or
 * returns undefined when the rest of the event leaves no room for text. The
 * first piece keeps the event's id and every later piece gets a new one, so
 * no two events in a stream share an id.
 *
 * Each piece holds as many code units as fit at the worst case of six bytes
 * per unit, so no piece needs to be measured. A cut never falls between the
 * two halves of a surrogate pair, which would turn one character into two
 * broken ones.
 */
const splitDelta = (event: ContentDelta): ReadonlyArray<ContentDelta> | undefined => {
  // The rest of the frame is measured under both ids, because a new id can be
  // longer than the event's own.
  const rest = Math.max(
    measureFrameBytes({ ...event, delta: "" }),
    measureFrameBytes({ ...event, eventId: crypto.randomUUID(), delta: "" }),
  );
  const room = MAX_FRAME_BYTES - rest;
  const unitsPerPiece = Math.floor(room / MAX_BYTES_PER_UNIT);
  // A piece of one unit could not hold a surrogate pair.
  if (unitsPerPiece < 2) return undefined;
  const pieces: Array<ContentDelta> = [];
  let start = 0;
  while (start < event.delta.length) {
    let end = Math.min(start + unitsPerPiece, event.delta.length);
    if (end < event.delta.length && isHighSurrogate(event.delta.charCodeAt(end - 1))) end -= 1;
    pieces.push({
      ...event,
      eventId: start === 0 ? event.eventId : crypto.randomUUID(),
      delta: event.delta.slice(start, end),
    });
    start = end;
  }
  return pieces;
};

/** Formats a byte count as MiB, rounded up so a size over the limit never reads as equal to it. */
const formatMiB = (bytes: number): string => {
  const hundredths = Math.ceil((bytes / BYTES_PER_MIB) * 100) / 100;
  return `${String(hundredths)} MiB`;
};

/**
 * Describes a frame size over the limit in words a user reads, for example
 * "4.01 MiB, too large to send (the limit is 2 MiB)". Every warning and
 * reason this module writes uses it, so the wording is in one place.
 */
const describeExcessSize = (bytes: number): string =>
  `${formatMiB(bytes)}, too large to send (the limit is ${formatMiB(MAX_FRAME_BYTES)})`;

/**
 * Names what an event carried, as the start of a sentence for a user: the
 * result or the input of an item, by its kind written as words ("A tool
 * call result"), or the event's type for anything else.
 */
const describeEventSubject = (event: ProviderEvent): string => {
  switch (event._tag) {
    case "item.completed":
      return `A ${event.kind.replace(/_/g, " ")} result`;
    case "item.started":
      return `A ${event.kind.replace(/_/g, " ")} input`;
    case "content.delta":
      return "A piece of streamed text";
    default:
      return `A ${event._tag} event`;
  }
};

/**
 * Describes a structured result too large to send, for example "The turn's
 * structured result was 2.31 MiB, too large to send (the limit is 2 MiB)".
 */
const describeOversizedResult = (bytes: number): string =>
  `The turn's structured result was ${describeExcessSize(bytes)}`;

/**
 * Replaces a turn's `ok` structured result with a schema failure that gives the
 * size as its reason. A `turn.completed` must never be dropped: it ends the
 * turn for the controller and for the supervisor, and ends an agent step's turn
 * as a `schema_failure` with this reason instead of leaving the step waiting.
 * Returns undefined when the turn has no `ok` result to replace.
 */
const replaceStructuredResult = (event: TurnCompleted, bytes: number): TurnCompleted | undefined =>
  event.structuredResult?.outcome === "ok"
    ? {
        ...event,
        structuredResult: {
          outcome: "schema-failure",
          reason: `${describeOversizedResult(bytes)}.`,
        },
      }
    : undefined;

/**
 * Builds the `runtime.warning` that tells the user what was left out of
 * `event` to make it fit, on the same agent and turn as the event. `sentence`
 * is the whole explanation; the item's id, when there is one, follows it,
 * because the id is long and only useful for debugging.
 *
 * `subagent.started` belongs to the agent that started the subagent, and its
 * `subagentId` names the new subagent, so its warning goes to the parent:
 * `parentSubagentId`, or the session's own agent when that is absent.
 */
const buildOmissionWarning = (event: ProviderEvent, sentence: string): ProviderEvent => {
  const subagentId =
    event._tag === "subagent.started"
      ? event.parentSubagentId
      : "subagentId" in event
        ? event.subagentId
        : undefined;
  const turnId = "turnId" in event ? event.turnId : undefined;
  const itemId = "itemId" in event ? event.itemId : undefined;
  return {
    _tag: "runtime.warning",
    eventId: crypto.randomUUID(),
    sessionId: event.sessionId,
    at: event.at,
    ...(subagentId === undefined ? {} : { subagentId }),
    ...(turnId === undefined ? {} : { turnId }),
    message: itemId === undefined ? sentence : `${sentence} Item ${itemId}.`,
  };
};

/**
 * Builds the warning for `event`, whose frame took `bytes`, saying what
 * `leftOut` describes, for example "its raw data was left out".
 */
const warnOfOmission = (event: ProviderEvent, bytes: number, leftOut: string): ProviderEvent =>
  buildOmissionWarning(
    event,
    `${describeEventSubject(event)} was ${describeExcessSize(bytes)}, so ${leftOut}.`,
  );

/**
 * Returns `event` as events whose `sessionEvent` frames each take at most
 * `MAX_FRAME_BYTES`. An event that fits is returned alone and unchanged.
 * Otherwise it is shrunk in this order, stopping as soon as it fits:
 *
 * 1. Its `raw` is dropped.
 * 2. A `content.delta` is split into consecutive deltas. The stream is
 *    append-only, so the pieces add up to the same text.
 * 3. An `item.started` or `item.completed` also loses its `detail`.
 * 4. A `turn.completed` has an `ok` structured result replaced by a schema
 *    failure, so the turn still ends.
 * 5. Anything still too big is not sent at all.
 *
 * Whenever something is left out, a `runtime.warning` that names what was left
 * out is added after the shrunk event, so the item it names already exists
 * when the warning arrives. A loss is never silent.
 */
export const fitEventToFrame = (event: ProviderEvent): ReadonlyArray<ProviderEvent> => {
  const bytes = measureFrameBytes(event);
  if (bytes <= MAX_FRAME_BYTES) return [event];

  const { raw, ...withoutRaw } = event;
  const lostRaw = raw !== undefined;
  if (lostRaw && measureFrameBytes(withoutRaw) <= MAX_FRAME_BYTES) {
    return [withoutRaw, warnOfOmission(event, bytes, "its raw data was left out")];
  }

  if (withoutRaw._tag === "content.delta") {
    const pieces = splitDelta(withoutRaw);
    if (pieces !== undefined) {
      return lostRaw
        ? [...pieces, warnOfOmission(event, bytes, "its raw data was left out")]
        : pieces;
    }
  }

  if (withoutRaw._tag === "item.started" || withoutRaw._tag === "item.completed") {
    const { detail, ...withoutDetail } = withoutRaw;
    if (detail !== undefined && measureFrameBytes(withoutDetail) <= MAX_FRAME_BYTES) {
      // An item's result carries its output; an item's input, its details.
      const detailName = withoutRaw._tag === "item.completed" ? "output" : "details";
      const leftOut = lostRaw
        ? `its ${detailName} and raw data were left out`
        : `its ${detailName} ${detailName === "output" ? "was" : "were"} left out`;
      return [withoutDetail, warnOfOmission(event, bytes, leftOut)];
    }
  }

  if (withoutRaw._tag === "turn.completed") {
    const withoutResult = replaceStructuredResult(withoutRaw, bytes);
    if (withoutResult !== undefined && measureFrameBytes(withoutResult) <= MAX_FRAME_BYTES) {
      const rawNote = lostRaw ? ", and the turn's raw data was left out" : "";
      return [
        withoutResult,
        buildOmissionWarning(
          event,
          `${describeOversizedResult(bytes)}, so it was replaced by a failure${rawNote}.`,
        ),
      ];
    }
  }

  return [
    buildOmissionWarning(
      event,
      `A ${event._tag} event was ${describeExcessSize(bytes)}, so it was left out.`,
    ),
  ];
};

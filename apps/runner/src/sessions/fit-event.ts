/**
 * Keeps every event the runner sends within one WebSocket frame.
 *
 * The controller closes the runner's socket on a frame larger than
 * `MAX_FRAME_BYTES`, and that ends the stream of every session on the runner.
 * Most fields of an event are bounded by the protocol, but `raw`, the native
 * ids in `providerRefs`, an item's `detail`, a `content.delta` and a turn's
 * structured result are not: a Claude `Read` of a large image puts its bytes
 * in `detail` and again in `raw`. So the supervisor passes every event through
 * `fitEventToFrame` before it numbers it (spec 06 section 6).
 */
import { MAX_FRAME_BYTES, type ProviderEvent } from "@hercule/protocol";
import { describeExcessSize, measureFrameBytes } from "../frame-size";

type ContentDelta = Extract<ProviderEvent, { readonly _tag: "content.delta" }>;

/**
 * The most bytes one UTF-16 code unit can take in a frame. JSON escapes a
 * control character as, for example, `\u0001`, and a lone surrogate as
 * `\ud800`: six bytes each. Every other code unit takes at most three bytes of
 * UTF-8, and a surrogate pair takes four bytes for its two units.
 */
const MAX_BYTES_PER_UNIT = 6;

/**
 * Measures the bytes `event` takes on the socket as a `sessionEvent` frame.
 * The frame is measured with the largest possible sequence number, so the
 * result holds for whatever number the event gets.
 */
const measureEventBytes = (event: ProviderEvent): number =>
  measureFrameBytes({ _tag: "sessionEvent", seq: Number.MAX_SAFE_INTEGER, event });

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
    measureEventBytes({ ...event, delta: "" }),
    measureEventBytes({ ...event, eventId: crypto.randomUUID(), delta: "" }),
  );
  const unitsPerPiece = Math.floor((MAX_FRAME_BYTES - rest) / MAX_BYTES_PER_UNIT);
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

/** Returns `noun` after "A" or "An", whichever its first letter takes. */
const withArticle = (noun: string): string => `${/^[aeiou]/i.test(noun) ? "An" : "A"} ${noun}`;

/** What each event that is not about an item is, as words a user reads. */
const EVENT_SUBJECTS: Record<
  Exclude<ProviderEvent["_tag"], "item.started" | "item.completed">,
  string
> = {
  "session.started": "The session's start",
  "session.exited": "The session's end",
  "turn.started": "The start of a turn",
  "turn.completed": "The end of a turn",
  "content.delta": "A piece of streamed text",
  "session.usage.updated": "A usage update",
  "runtime.warning": "A warning",
  "runtime.error": "An error",
  "request.opened": "A request",
  "request.resolved": "The end of a request",
  "subagent.started": "The start of a subagent",
};

/**
 * Names what `event` is, as the start of a sentence a user reads: the input
 * or the result of an item, by its kind written as words ("A tool call
 * result"), or the kind of event.
 */
const describeEventSubject = (event: ProviderEvent): string => {
  switch (event._tag) {
    case "item.started":
      return withArticle(`${event.kind.replace(/_/g, " ")} input`);
    case "item.completed":
      return withArticle(`${event.kind.replace(/_/g, " ")} result`);
    default:
      return EVENT_SUBJECTS[event._tag];
  }
};

/**
 * Builds the `runtime.warning` that says what happened to `event`, on the
 * same agent and turn as the event. The item's id, when there is one, follows
 * `sentence`, because the id is long and only useful for debugging.
 *
 * `subagent.started` belongs to the agent that started the subagent, and its
 * `subagentId` names the new subagent, so its warning goes to the parent:
 * `parentSubagentId`, or the session's own agent when that is absent.
 */
const buildWarning = (event: ProviderEvent, sentence: string): ProviderEvent => {
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

/** Joins words as a list a person writes: "a", "a and b", "a, b and c". */
const joinAsList = (words: ReadonlyArray<string>): string =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

/**
 * Returns `event` as events whose `sessionEvent` frames each take at most
 * `MAX_FRAME_BYTES`. An event that fits is returned alone and unchanged.
 * Otherwise it is shrunk in this order, stopping as soon as it fits:
 *
 * 1. Its `raw` is dropped.
 * 2. A `content.delta` is split into consecutive deltas. The stream is
 *    append-only, so the pieces add up to the same text.
 * 3. An `item.started` or `item.completed` loses its `detail`.
 * 4. A `turn.completed` has an `ok` structured result replaced by a schema
 *    failure that gives the result's size, so an agent step fails with a
 *    reason instead of a value too large to send.
 * 5. Its `providerRefs` are dropped.
 * 6. Anything still too big is not sent at all. Every field left on a
 *    `turn.completed` or a `session.exited` is bounded by the protocol, so
 *    neither ever reaches this step: a turn or a session left open would never
 *    end.
 *
 * Whenever something is left out, a `runtime.warning` that says what is added
 * after the shrunk event, so the item it names already exists when the warning
 * arrives. A loss is never silent. After a `session.exited` the warning is
 * still stored, because the controller records events after a session's end.
 */
export const fitEventToFrame = (event: ProviderEvent): ReadonlyArray<ProviderEvent> => {
  const bytes = measureEventBytes(event);
  if (bytes <= MAX_FRAME_BYTES) return [event];

  const subject = `${describeEventSubject(event)} was ${describeExcessSize(bytes)}`;
  // What was left out, as nouns after "its", and whether each is plural.
  const leftOut: Array<{ readonly noun: string; readonly plural: boolean }> = [];
  let replacedResult = false;
  const buildLossWarning = (): ProviderEvent => {
    const clauses: Array<string> = [];
    if (replacedResult) clauses.push("its structured result was replaced by a failure");
    if (leftOut.length > 0) {
      const verb = leftOut.length > 1 || leftOut[0]?.plural === true ? "were" : "was";
      clauses.push(`its ${joinAsList(leftOut.map((part) => part.noun))} ${verb} left out`);
    }
    return buildWarning(event, `${subject}, so ${clauses.join(", and ")}.`);
  };

  const { raw, ...withoutRaw } = event;
  let shrunk: ProviderEvent = withoutRaw;
  if (raw !== undefined) {
    leftOut.push({ noun: "raw data", plural: false });
    if (measureEventBytes(shrunk) <= MAX_FRAME_BYTES) return [shrunk, buildLossWarning()];
  }

  if (shrunk._tag === "content.delta") {
    const pieces = splitDelta(shrunk);
    if (pieces !== undefined) return leftOut.length > 0 ? [...pieces, buildLossWarning()] : pieces;
  }

  if (shrunk._tag === "item.started" || shrunk._tag === "item.completed") {
    const { detail, ...withoutDetail } = shrunk;
    if (detail !== undefined) {
      // An item's result carries its output; an item's input, its details.
      leftOut.unshift(
        shrunk._tag === "item.completed"
          ? { noun: "output", plural: false }
          : { noun: "details", plural: true },
      );
      shrunk = withoutDetail;
      if (measureEventBytes(shrunk) <= MAX_FRAME_BYTES) return [shrunk, buildLossWarning()];
    }
  }

  if (shrunk._tag === "turn.completed" && shrunk.structuredResult?.outcome === "ok") {
    // The turn is measured without its raw data, which is already left out,
    // so the size given is close to the result's own.
    const resultBytes = measureEventBytes(shrunk);
    shrunk = {
      ...shrunk,
      structuredResult: {
        outcome: "schema-failure",
        reason: `The turn's structured result was ${describeExcessSize(resultBytes)}.`,
      },
    };
    replacedResult = true;
    if (measureEventBytes(shrunk) <= MAX_FRAME_BYTES) return [shrunk, buildLossWarning()];
  }

  const { providerRefs, ...withoutRefs } = shrunk;
  if (providerRefs !== undefined) {
    leftOut.push({ noun: "native ids", plural: true });
    shrunk = withoutRefs;
    if (measureEventBytes(shrunk) <= MAX_FRAME_BYTES) return [shrunk, buildLossWarning()];
  }

  return [buildWarning(event, `${subject}, so it was left out.`)];
};

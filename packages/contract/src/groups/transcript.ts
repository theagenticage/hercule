/**
 * Transcripts: the normalized stream a session left behind, read back in order.
 *
 * The transcript is a separate entity from the session record ([11-public-api
 * section 2]): the record holds a session's current state, and the transcript
 * holds what it did. The transcript is append-only and keyed by a per-session
 * position, so reading it is a keyset walk over that position. Each agent of
 * a session has a transcript of its own: the session's own agent's, and one
 * per subagent. Reading one has no other filter; besides the agent, the only
 * choices a caller has are which end to start from and which position to read
 * after.
 *
 * `transcript.query` is the full-text search over every session's messages.
 * It returns passages: the text of one message that matched, with where it
 * came from. An assistant recalls its own conversations with `agentId: "me"`.
 *
 * A row carries the normalized `HarnessEvent` verbatim, which is the same
 * document the runner reported except for `content.delta`, where the controller
 * coalesces a run of deltas into one row ([04-state-store, Streaming deltas are
 * coalesced]). Nothing else is folded, rewritten or dropped.
 */
import { Schema } from "effect";
import { HarnessEvent, StructuredResult, SubagentId } from "@hercule/protocol";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, IdOrMe, OWN_SESSION_ALIAS, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { bounded } from "../strings";
import { MAX_SEARCH_TEXT_LENGTH } from "./task";

/**
 * A position in a session's stream that a read can start after: an integer of
 * 0 or more. 0 means "after nothing", so the read returns the whole stream.
 * A position past the newest row is valid and returns an empty page.
 */
export const TranscriptPosition = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * One row of a session's stream. `position` is the session's own monotonic
 * counter, which a cursor refers to and the rows are ordered by;
 * `at` is the instant the runner read off its own clock when the event
 * happened, which is why it is not necessarily monotonic across machines.
 */
export const TranscriptRow = Schema.Struct({
  position: Schema.Int,
  at: Schema.String,
  event: HarnessEvent,
});

export type TranscriptRow = Schema.Schema.Type<typeof TranscriptRow>;

/**
 * What a turn returned under its session's output schema, as the protocol
 * defines it. It is re-exported rather than defined again here: a reader of
 * transcript rows is the only consumer of this result outside the runner, and
 * two definitions of it could drift apart.
 */
export { StructuredResult };

/** The only order a transcript has. A cursor is only valid for the listing it came from. */
export const TRANSCRIPT_SORT_FIELDS = ["position"] as const;

/**
 * One message that matched a transcript search. `excerpt` is a short window
 * of the message's text around the hit. `subagentId` is present when the
 * message is from one of the session's subagents.
 */
export const Passage = Schema.Struct({
  sessionId: Id,
  subagentId: Schema.optionalKey(SubagentId),
  turnId: Schema.String,
  at: Timestamp,
  excerpt: Schema.String,
});

export type Passage = Schema.Schema.Type<typeof Passage>;

/** The only order of a transcript search: when the message was written. */
export const PASSAGE_SORT_FIELDS = ["at"] as const;

/** The filters of `transcript.query`, beside the search text. All of them narrow the search. */
export const PassageFilter = Schema.Struct({
  text: bounded(1, MAX_SEARCH_TEXT_LENGTH),
  sessionId: Schema.optionalKey(Id),
  /** The Agent whose sessions to search. `me` is the Agent the calling session runs as. */
  agentId: Schema.optionalKey(IdOrMe),
  /** `me` keeps the sessions the calling session spawned. */
  actor: Schema.optionalKey(Schema.Literal(OWN_SESSION_ALIAS)),
  since: Schema.optionalKey(Timestamp),
  until: Schema.optionalKey(Timestamp),
});

export const transcript = HttpApiGroup.make("transcript")
  .add(
    HttpApiEndpoint.get("read", "/sessions/:id/transcript", {
      params: { id: Id },
      query: Schema.Struct({
        /**
         * The subagent whose transcript to read. Without it, the session's
         * own agent's transcript is read; a subagent's events are never
         * part of it.
         */
        subagentId: Schema.optionalKey(SubagentId),
        /**
         * Only the rows whose position is greater than this. A client that
         * holds the rows up to a position reads the newer ones with it. A
         * position beyond the newest row returns an empty page. A cursor is
         * only valid for the listing with the same `after`.
         */
        after: Schema.optionalKey(TranscriptPosition),
        ...pageParams(TRANSCRIPT_SORT_FIELDS).fields,
      }),
      success: page(TranscriptRow),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.get("query", "/transcripts", {
      query: Schema.Struct({
        ...PassageFilter.fields,
        ...pageParams(PASSAGE_SORT_FIELDS).fields,
      }),
      success: page(Passage),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
  )
  .middleware(Authenticated);

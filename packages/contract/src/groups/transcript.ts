/**
 * Transcripts: the normalized stream a session left behind, read back in order.
 *
 * The transcript is a separate entity from the session record ([11-public-api
 * section 2]): the record holds a session's current state, and the transcript
 * holds what it did. The transcript is append-only and keyed by a per-session
 * position, so reading it is a keyset walk over that position and nothing
 * else: there is no filter and no search, and the only choice a caller has is
 * which end to start from.
 * `transcript.query`, the full-text search over every session, is a different
 * operation and is not built yet.
 *
 * A row carries the normalized `ProviderEvent` verbatim, which is the same
 * document the runner reported except for `content.delta`, where the controller
 * coalesces a run of deltas into one row ([04-state-store, Streaming deltas are
 * coalesced]). Nothing else is folded, rewritten or dropped.
 */
import { Schema } from "effect";
import { ProviderEvent, StructuredResult } from "@hercule/protocol";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";

/**
 * One row of a session's stream. `position` is the session's own monotonic
 * counter, which a cursor refers to and the rows are ordered by;
 * `at` is the instant the runner read off its own clock when the event
 * happened, which is why it is not necessarily monotonic across machines.
 */
export const TranscriptRow = Schema.Struct({
  position: Schema.Int,
  at: Schema.String,
  event: ProviderEvent,
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

export const transcript = HttpApiGroup.make("transcript")
  .add(
    HttpApiEndpoint.get("read", "/sessions/:id/transcript", {
      params: { id: Id },
      query: pageParams(TRANSCRIPT_SORT_FIELDS),
      success: page(TranscriptRow),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);

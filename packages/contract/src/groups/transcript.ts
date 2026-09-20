/**
 * Transcripts: the normalized stream a session left behind, read back in order.
 *
 * The transcript is a separate entity from the session record ([11-public-api
 * section 2]): the record says where a session stands, the transcript says what
 * it did. It is append-only and keyed by a per-session position, so reading it
 * is a keyset walk over that position and nothing else: there is no filter and
 * no search, and the only choice a caller has is which end to start from.
 * `transcript.query`, the full-text search over every session, is a different
 * operation and is not built yet.
 *
 * A row carries the normalized `ProviderEvent` verbatim, which is the same
 * document the runner reported except for `content.delta`, where the controller
 * coalesces a run of deltas into one row ([04-state-store, Streaming deltas are
 * coalesced]). Nothing else is folded, rewritten or dropped.
 */
import { Schema } from "effect";
import { ProviderEvent, StructuredResult } from "@hydra/protocol";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";

/**
 * One row of a session's stream. `position` is the session's own monotonic
 * counter, which is what a cursor names and what the rows are ordered by;
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
 * What a turn answered under its session's output schema, as the protocol
 * spells it. It is re-exported and not restated here. A reader of a transcript
 * row is the one consumer of this verdict outside the runner, and two
 * spellings of one verdict could disagree.
 */
export { StructuredResult };

/** The one order a transcript has. A cursor is only valid for the walk it came from. */
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

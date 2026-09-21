/**
 * The matcher's use cases: everything that decides who an event reaches.
 *
 * Enrichment is here rather than in the events domain because of what it owes
 * the matcher: amending an event gives the matcher one more look at that one
 * event, and what that look writes are rows in the sessions domain. A write
 * across domains comes from above, so the whole of it sits in this layer. The
 * amendment itself is the events domain's own write, made through its service.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  EnrichPayload,
  EventId,
  validationOf,
  type Event,
  type Forbidden,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { withTransaction } from "../db";
import { EventService } from "../events";

/** One event named by its position in the log, and what is to be amended on it. */
const EnrichInput = Schema.Struct({ id: EventId, ...EnrichPayload.fields });

type EnrichInput = Schema.Schema.Type<typeof EnrichInput>;

const decodeEnrich = Schema.decodeUnknownEffect(EnrichInput, { errors: "all" });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventService;

  return {
    /**
     * Amends what an event is about, and hands the matcher the amended event.
     *
     * The amendment and that second look are one transaction, so two
     * enrichments of one event cannot each drop the other's refs, and a look
     * that writes cannot be separated from the write it read.
     */
    enrichEvent: (
      input: EnrichInput,
    ): Effect.Effect<Event, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        // Amending the log is writing to it, which is the grant an emit needs.
        yield* requireGrant("event.enrich");
        const decoded = yield* Effect.mapError(decodeEnrich(input), validationOf);

        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const amended = yield* events.amend(decoded);
            // A ref added here may be what a subscription has been waiting
            // for, so the matcher looks at this one event again. That call is
            // the matcher's own and lands with it; the rows it writes are
            // unique per subscription and event, so whatever matched before
            // gets nothing a second time.
            return amended;
          }),
        );
      }),
  };
});

/** The matcher, and the enrichment that gives it a second look at one event. */
export class Matcher extends Context.Service<Matcher, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Matcher",
) {}

export const MatcherLayer: Layer.Layer<Matcher, never, SqlClient.SqlClient | EventService> =
  Layer.effect(Matcher)(make);

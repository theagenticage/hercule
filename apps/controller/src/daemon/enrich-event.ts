/**
 * Enrichment: amending what an event is about, and giving the router one more
 * look at that one event.
 *
 * It is here rather than in the events domain because of what it owes the
 * router: amending an event gives the router one more look at it, and what
 * that look writes are rows in another domain. A write across domains comes
 * from above, so the whole of it sits in this layer. The amendment itself is
 * the events domain's own write, made through its service.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  EventEnrichInput,
  EventId,
  validationOf,
  type Event,
  type Forbidden,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { withTransaction } from "../db";
import { AuditLog, EventService } from "../events";
import { SessionService } from "../sessions";
import { EvaluationErrorNotifier } from "../subscriptions";
import { EventRouter } from "./event-router";
import { buildRoutingTables } from "./routing";

/** One event named by its position in the log, and what is to be amended on it. */
const EnrichInput = Schema.Struct({ id: EventId, ...EventEnrichInput.fields });

type EnrichInput = Schema.Schema.Type<typeof EnrichInput>;

const decodeEnrich = Schema.decodeUnknownEffect(EnrichInput, { errors: "all" });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventService;
  const audit = yield* AuditLog;
  const router = yield* EventRouter;
  const routingTables = yield* buildRoutingTables;

  return {
    /**
     * Amends what an event is about, and hands the router the amended event.
     *
     * The amendment and that second look are one transaction, so two
     * enrichments of one event cannot each drop the other's refs, and a look
     * that writes cannot be separated from the write it read. What the look
     * writes reaches its destination on the pipeline's next tick.
     */
    enrichEvent: (
      input: EnrichInput,
    ): Effect.Effect<Event, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        // Amending the log is writing to it, which is the grant an emit needs.
        yield* requireGrant("event.enrich");
        const decoded = yield* Effect.mapError(decodeEnrich(input), validationOf);
        const actor = yield* currentStamp;

        const { amended, reports } = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const amended = yield* events.amend(decoded);
            // The stamp for an amendment is an audit entry and not a column on
            // the event: the event's own actor is whoever emitted it, and it
            // stays that, or the log would forget where the event came from.
            // An event may be amended many times, and each amendment is its own
            // fact with its own author, which one column could not hold either.
            yield* audit.append({
              kind: "event.enriched",
              actor,
              payload: {
                eventId: decoded.id,
                ...(decoded.system === undefined ? {} : { system: decoded.system }),
                ...(decoded.url === undefined ? {} : { url: decoded.url }),
                ...(decoded.refs === undefined ? {} : { refs: decoded.refs }),
              },
            });
            // A ref added here may be what a route has been waiting for, so the
            // router looks at this one event again. The rows that look writes
            // are delivered by the next tick, within one interval: this call
            // runs on a request's own fiber, which is gone the moment the
            // answer is written, and a delivery started on it would be cut off
            // half way.
            return { amended, reports: yield* router.rerouteEvent(decoded.id, routingTables) };
          }),
        );
        yield* reports;
        return amended;
      }),
  };
});

/** The enrichment use case, which the `event.enrich` handler calls. */
export class Enrichment extends Context.Service<Enrichment, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Enrichment",
) {}

export const EnrichmentLayer: Layer.Layer<
  Enrichment,
  never,
  | SqlClient.SqlClient
  | AuditLog
  | EventService
  | EventRouter
  | SessionService
  | EvaluationErrorNotifier
> = Layer.effect(Enrichment)(make);

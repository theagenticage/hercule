/**
 * Enrichment: adds details to an event that is already in the log, then
 * routes that event again.
 *
 * This lives in the daemon rather than in the events domain because routing
 * the event again can write rows in other domains, and a write across domains
 * belongs to the layer above them. The change to the event itself is still
 * made by the events domain, through its service.
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
  createDecodeValidationError,
  type Event,
  type Forbidden,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../../actor";
import { withTransaction } from "../../db";
import { AuditLog, EventService } from "../../events";
import { SessionService } from "../../sessions";
import { EvaluationErrorNotifier } from "../../subscriptions";
import { EventRouter } from "./event-router";
import { buildRoutingTables } from "./routing";

/** The id of an event in the log, and the fields to add to it. */
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
     * Adds the given fields to an event, then routes the amended event again.
     * Returns the amended event. Fails if the caller lacks the grant, the
     * input is invalid, or the event does not exist.
     *
     * The amendment and the second routing run in one transaction. That way,
     * two enrichments of the same event cannot overwrite each other's refs,
     * and the routing always sees the amendment it follows. Rows the routing
     * writes are delivered on the pipeline's next tick.
     */
    enrichEvent: (
      input: EnrichInput,
    ): Effect.Effect<Event, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        // Amending an event writes to the log, so it needs the same grant as an emit.
        yield* requireGrant("event.enrich");
        const decoded = yield* Effect.mapError(decodeEnrich(input), createDecodeValidationError);
        const actor = yield* currentStamp;

        const { amended, reports } = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const amended = yield* events.amend(decoded);
            // The actor of an amendment goes in an audit entry, not in a column
            // on the event. The event's own actor is whoever emitted it, and it
            // must stay that way, or the log would lose where the event came
            // from. An event can also be amended many times, each time by a
            // different actor, which one column could not hold.
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
            // router routes this event again. The rows it writes are delivered
            // by the next tick, within one interval. They are not delivered
            // here because this call runs on the request's fiber, which ends as
            // soon as the response is written, and would cut a delivery off
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

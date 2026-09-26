/**
 * The routing tables the event router receives, and the deliveries that send
 * the rows waiting to go out.
 *
 * Each table is the only module that knows both the domain that owns a claim
 * and the domain that handles it. Today the pipeline has:
 *
 * - one routing table, with a route per live subscription;
 * - one delivery, for queued inputs, whoever wrote them: a routing table or a
 *   person typing.
 *
 * A trigger table and a run delivery will join them when workflows arrive.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { SessionService } from "../../../sessions";
import { EvaluationErrorNotifier } from "../../../subscriptions";
import type { Delivery, RoutingTable } from "../event-router";
import { Live } from "../../sessions";
import { queuedInputDelivery } from "./queued-input-delivery";
import { sessionRoutingTable } from "./session-routing-table";

/**
 * Builds every routing table a pass routes events to. The enrichment use case
 * gives the router this same list for its one event, so an event enriched
 * later reaches exactly the routes a pass would have reached.
 */
export const buildRoutingTables: Effect.Effect<
  ReadonlyArray<RoutingTable>,
  never,
  SqlClient.SqlClient | SessionService | EvaluationErrorNotifier
> = Effect.map(sessionRoutingTable, (table) => [table]);

/** Builds every delivery that sends the rows waiting to go out, whoever wrote them. */
export const buildDeliveries: Effect.Effect<
  ReadonlyArray<Delivery>,
  never,
  SqlClient.SqlClient | Live
> = Effect.map(queuedInputDelivery, (delivery) => [delivery]);

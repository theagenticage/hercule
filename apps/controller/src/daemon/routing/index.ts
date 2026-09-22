/**
 * The routing tables the event router is handed, and the deliveries that
 * reconcile the rows waiting to go out.
 *
 * Each table is the only module that knows both the domain owning a claim and
 * the domain that answers it. The two lists below are what the pipeline is
 * made of today: one table per live subscription, and one delivery for the
 * queued inputs, which it reconciles whoever wrote them - a routing table, or
 * a person typing. A trigger table and its run delivery join them when
 * workflows arrive.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { SessionService } from "../../sessions";
import { EvaluationErrorNotifier } from "../../subscriptions";
import type { Delivery, RoutingTable } from "../event-router";
import { Live } from "../live";
import { queuedInputDelivery } from "./queued-input-delivery";
import { sessionRoutingTable } from "./session-routing-table";

/**
 * Every routing table one pass walks the log for. The enrichment use case
 * gives the router this same list for its one event, so a ref added by hand
 * reaches exactly what a pass would have reached.
 */
export const buildRoutingTables: Effect.Effect<
  ReadonlyArray<RoutingTable>,
  never,
  SqlClient.SqlClient | SessionService | EvaluationErrorNotifier
> = Effect.map(sessionRoutingTable, (table) => [table]);

/** Every consumer of the rows waiting to go out, whoever wrote them. */
export const buildDeliveries: Effect.Effect<
  ReadonlyArray<Delivery>,
  never,
  SessionService | Live
> = Effect.map(queuedInputDelivery, (delivery) => [delivery]);

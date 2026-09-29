/**
 * The routing tables the event router receives, and the deliveries that send
 * the rows waiting to go out.
 *
 * Each table is the only module that knows both the domain that owns a claim
 * and the domain that handles it. Today the pipeline has:
 *
 * - two routing tables: one with a route per live subscription, and one with
 *   a route per active start trigger;
 * - two deliveries: one for queued inputs, whoever wrote them (a routing
 *   table or a person typing), and one that starts the runs of the start
 *   triggers that matched.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { NotificationService } from "../../../notifications";
import type { SessionService } from "../../../sessions";
import type { TriggerEffects, TriggerHealth } from "../../../workflows";
import type { Delivery, RoutingTable } from "../event-router";
import { Live } from "../../sessions";
import { queuedInputDelivery } from "./queued-input-delivery";
import { sessionRoutingTable } from "./session-routing-table";
import { triggerEffectDelivery } from "./trigger-effect-delivery";
import { triggerRoutingTable } from "./trigger-routing-table";

/**
 * Builds every routing table a pass routes events to. The enrichment use case
 * gives the router this same list for its one event, so an event enriched
 * later reaches exactly the routes a pass would have reached.
 */
export const buildRoutingTables: Effect.Effect<
  ReadonlyArray<RoutingTable>,
  never,
  SqlClient.SqlClient | SessionService | NotificationService | TriggerHealth | TriggerEffects
> = Effect.all([sessionRoutingTable, triggerRoutingTable]);

/** Builds every delivery that sends the rows waiting to go out, whoever wrote them. */
export const buildDeliveries: Effect.Effect<
  ReadonlyArray<Delivery>,
  never,
  SqlClient.SqlClient | Live | TriggerEffects
> = Effect.all([queuedInputDelivery, triggerEffectDelivery]);

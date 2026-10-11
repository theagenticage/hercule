/**
 * The routing tables the event router receives, and the deliveries that send
 * the rows waiting to go out.
 *
 * Each table is the only module that knows both the domain that owns a claim
 * and the domain that handles it. Today the pipeline has:
 *
 * - four routing tables: one with a route per live subscription a session
 *   holds, one with a route per live subscription a run holds for a signal
 *   trigger, one with a route per active start trigger, and Intake's, with a
 *   route per active event source that declares signal kinds. Intake's is
 *   last, because it reads what the others wrote for the same event to tell
 *   whether a session or a run already handles it;
 * - three deliveries: one for queued inputs, whoever wrote them (a routing
 *   table or a person typing), one that starts the runs of the start
 *   triggers that matched, and one that turns Intake's raises into signals.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { BoundOperations } from "../../../bound-actions";
import type { ConnectionTypes } from "../../../connections";
import type { AuditLog } from "../../../events";
import type { Notifier } from "../../../notifications";
import type { PluginHost } from "../../../plugins";
import type { RunService } from "../../../runs";
import type { SessionService } from "../../../sessions";
import type { TriggerEffects, TriggerHealth } from "../../../workflows";
import type { Delivery, RoutingTable } from "../event-router";
import { Live } from "../../sessions";
import { intakeRoutingTable } from "./intake-routing-table";
import { queuedInputDelivery } from "./queued-input-delivery";
import { sessionRoutingTable } from "./session-routing-table";
import { signalRaiseDelivery } from "./signal-raise-delivery";
import { signalRoutingTable } from "./signal-routing-table";
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
  | SqlClient.SqlClient
  | SessionService
  | RunService
  | Notifier
  | TriggerHealth
  | TriggerEffects
  | PluginHost
  | AuditLog
> = Effect.all([sessionRoutingTable, signalRoutingTable, triggerRoutingTable, intakeRoutingTable]);

/** Builds every delivery that sends the rows waiting to go out, whoever wrote them. */
export const buildDeliveries: Effect.Effect<
  ReadonlyArray<Delivery>,
  never,
  | SqlClient.SqlClient
  | Live
  | TriggerEffects
  | PluginHost
  | ConnectionTypes
  | BoundOperations
  | Notifier
  | AuditLog
> = Effect.all([queuedInputDelivery, triggerEffectDelivery, signalRaiseDelivery]);

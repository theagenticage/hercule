/**
 * The controller daemon: the layer above the domains. It is the only module
 * that sends frames to runners and the only consumer of what they report, so a
 * domain below it holds rows and their rules and reaches for nothing else. The
 * providers domain is the last exception, still sending its own frames; issue
 * #209 brings it under the same rule.
 *
 * One file per use case, beside a shared helper or two (`absorbing.ts`,
 * `resuming.ts`), and a use case is anything that sequences a write set across
 * domains together with a message to a machine.
 *
 * Where a check shared by two use cases lives follows what it reads: one over a
 * single domain's own rows belongs to that domain (`providers/resolved.ts`),
 * one that reads across domains belongs here (`resuming.ts`).
 *
 * `routing/` is the one folder below this one. It holds the routing tables the
 * event router is handed, and each of them is the only module that knows both
 * the domain that owns a claim and the domain that answers it.
 */
export { cancelStrandedInputsAndReportLostWakeUps } from "./boot";
export { DispatchLayer } from "./dispatch";
export { Enrichment, EnrichmentLayer } from "./enrich-event";
export { EventRouter, EventRouterLayer } from "./event-router";
export { Inbound, InboundLayer } from "./inbound";
export { Live, LiveLayer, SessionInputDeadline } from "./live";
export { LostRunnerSweepInterval, sweepSessionsOnLostRunners } from "./lost-runners";
export { EventRoutingInterval, Pipeline, PipelineLayer } from "./pipeline";
export { Placement, PlacementLayer } from "./placement";
export { ProfileRemoval, ProfileRemovalLayer } from "./profile-removal";
export { Provisioning, ProvisioningLayer, WorkspaceSweepInterval } from "./provisioning";
export { Retirement, RetirementLayer } from "./retirement";

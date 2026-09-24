/**
 * The controller daemon: the layer above the domains. It is the only module
 * that sends frames to runners and the only one that handles what runners
 * report. The domains below it hold rows and their rules, and depend on
 * nothing else. The providers domain is the last exception: it still sends its
 * own frames, and issue #209 moves it under the same rule.
 *
 * The folder has one file per use case, plus a few shared helpers
 * (`absorbing.ts`, `resuming.ts`). A use case is anything that combines writes
 * across domains with a message to a runner.
 *
 * A check shared by two use cases lives where its data lives:
 *
 * - a check that reads one domain's rows belongs to that domain
 *   (`providers/resolved.ts`);
 * - a check that reads across domains belongs here (`resuming.ts`).
 *
 * `routing/` is the only subfolder. It holds the routing tables the event
 * router receives. Each table is the only module that knows both the domain
 * that owns a claim and the domain that handles it.
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
export { resumeUnfinishedRuns, RunEngine, RunEngineLayer } from "./run-engine";

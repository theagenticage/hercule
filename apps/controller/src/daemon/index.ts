/**
 * The controller daemon: the layer above the domains. A domain decides what
 * happens; the controller daemon decides where and how it runs. It owns:
 *
 * - the wire to runners: it is the only module that sends frames to runners
 *   and the only one that handles what they report, passing each result to
 *   the domain that owns it. The providers domain is the last exception: it
 *   still sends its own frames, and issue #209 moves it under the same rule;
 * - the fibers behind the ports domains declare, such as the runs domain's
 *   Run Executor and the plugins domain's Ingest Executor;
 * - the loops that run for the life of the controller, and boot;
 * - the ports that break a cycle between two domains, and, as the last
 *   resort, an operation whose domains could not be untangled otherwise.
 *
 * There is one file per use case, grouped in one folder per concern. Each
 * folder's `index.ts` is what the rest of the controller daemon imports it
 * through:
 *
 * - `sessions/`: placing a session, starting queued sessions on a runner with
 *   room, the operations that reach a live session, and the sweep that ends
 *   the sessions of lost runners;
 * - `events/`: the event router, the pipeline that runs it, enrichment, and
 *   the routing tables and deliveries in `events/routing/`;
 * - `workspaces/`: provisioning and disposing workspaces, and the sweep that
 *   removes the ones nothing needs any more;
 * - `runners/`: sending a runner that connects the work owed to it, handling
 *   what runners report, and retiring a runner;
 * - `permissions/`: deleting a permission profile;
 * - `connections/`: what the connections domain reads from the resources and
 *   workflows domains;
 * - `bound-actions/`: the Bound Operations port, which checks and runs the
 *   operation of the answer the user takes on a decision Notification or a
 *   Signal, and writes the Describe Line of each answer;
 * - `workflows/`: what the workflows domain reads from the runs domain, and
 *   the Scheduler, which fires cron triggers;
 * - `runs/`: the Run Executor, which gives each run's execution a fiber, and
 *   Workspace Steps, which hands a workspace step to its runner and stops it;
 * - `ingest/`: the Ingest Reconciler, which keeps an ingest handle open for
 *   every Connection that should be ingesting events from its plugin, and
 *   the Ingest Executor, which gives each Connection's ingest a fiber.
 * - `promotion/`: the driver that ends a promotion freeze at its token's
 *   expiry.
 *
 * The top level holds what belongs to no single folder: the steps run once at
 * boot (`boot.ts`), the helpers every long-running loop uses (`absorbing.ts`),
 * and the test helpers several folders share (`testing.ts`).
 *
 * A check shared by two use cases lives where its data lives:
 *
 * - a check that reads one domain's rows belongs to that domain
 *   (`providers/resolved.ts`);
 * - a check that only controller daemon use cases share belongs here, in the
 *   folder of those use cases (`sessions/resuming.ts`).
 *
 * ADR 0033 records this layout.
 */
export { endStrandedInputsAndReportLostWakeUps } from "./boot";
export {
  Enrichment,
  EnrichmentLayer,
  EventRouter,
  EventRouterLayer,
  EventRoutingInterval,
  Pipeline,
  PipelineLayer,
} from "./events";
export { AttachmentSweepInterval, runAttachmentSweepLoop } from "./attachments";
export { ConnectionServiceWithReferencesLayer } from "./connections";
export { IngestExecutorLayer, IngestReconcileInterval, runIngestReconciler } from "./ingest";
export { BoundOperationsLayer } from "./bound-actions";
export { ProfileRemoval, ProfileRemovalLayer } from "./permissions";
export { thawExpiredFreezes } from "./promotion";
export {
  Arrival,
  ArrivalLayer,
  Inbound,
  InboundLayer,
  PromotionFleet,
  PromotionFleetLayer,
  PromotionFleetRouteLayer,
  recordDeparturesAfterThaws,
  Retirement,
  RetirementLayer,
  sweepUnreachableRunners,
} from "./runners";
export { RunExecutorLayer, RunFibers, RunTargetsLayer, WorkspaceStepsLayer } from "./runs";
export {
  AssistantSessionsLayer,
  DispatchLayer,
  Live,
  LiveLayer,
  LostRunnerSweepInterval,
  Placement,
  PlacementLayer,
  RunServiceReference,
  RunServiceReferenceFill,
  RunServiceReferenceLayer,
  SessionInputDeadline,
  SessionObserverLayer,
  sweepSessionsOnLostRunners,
} from "./sessions";
export {
  checkSchedulerInterval,
  runScheduler,
  SchedulerInterval,
  TriggeredRunsLayer,
  WorkflowRunsLayer,
  WorkflowSignalsLayer,
} from "./workflows";
export { Provisioning, ProvisioningLayer, WorkspaceSweepInterval } from "./workspaces";

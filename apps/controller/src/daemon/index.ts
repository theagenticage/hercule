/**
 * The controller daemon: the layer above the domains. A domain decides what
 * happens; the controller daemon decides where and how it runs. It owns:
 *
 * - the wire to runners: it is the only module that sends frames to runners
 *   and the only one that handles what they report, passing each result to
 *   the domain that owns it;
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
 *   room, the operations that reach a live session, the skills a session
 *   has, and the sweep that ends the sessions of lost runners;
 * - `events/`: the event router, the pipeline that runs it, enrichment, and
 *   the routing tables and deliveries in `events/routing/`;
 * - `workspaces/`: provisioning and disposing workspaces, and the sweep that
 *   removes the ones nothing needs any more;
 * - `runners/`: sending a runner that connects the work owed to it, handling
 *   what runners report, asking a runner for its facts or to install a
 *   harness, and retiring a runner;
 * - `provider-accounts/`: probing the accounts on the runners and keeping their
 *   snapshots fresh, reading the usage of the accounts that need an active
 *   read, and the operations that sign an account in on a runner or probe it;
 * - `discussions/`: sending a session the Discussion Input that tells it
 *   what it has not been told about its Discussions yet, and recording
 *   the files sessions edit so that sessions that edited one file meet in a
 *   Discussion;
 * - `permissions/`: deleting a permission profile;
 * - `connections/`: what the connections domain reads from the resources and
 *   workflows domains;
 * - `bound-actions/`: the Bound Operations port, which checks and runs the
 *   operation of the answer the user takes on a decision Notification or a
 *   Signal, and writes the Describe Line of each answer;
 * - `workflows/`: what the workflows domain reads from the runs domain, the
 *   observers that validate the stored workflows again when a plugin, agent
 *   or Connection they use changes, and the Scheduler, which fires cron
 *   triggers;
 * - `runs/`: the Run Executor, which gives each run's execution a fiber, and
 *   Workspace Steps, which hands a workspace step to its runner and stops it;
 * - `ingest/`: the Ingest Reconciler, which keeps an ingest handle open for
 *   every Connection that should be ingesting events from its plugin, and
 *   the Ingest Executor, which gives each Connection's ingest a fiber.
 * - `promotion/`: the driver that ends a promotion freeze at its token's
 *   expiry.
 * - `text-generation/`: the implementation of the `TextGeneration` service,
 *   which picks a runner for one small model call, sends it and writes its
 *   audit entry.
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
  SignalBuildFailuresLayer,
} from "./events";
export { AttachmentSweepInterval, runAttachmentSweepLoop } from "./attachments";
export { runSkillUpdateCheckLoop, SkillUpdateCheckInterval } from "./skills";
export { ConnectionServiceWithReferencesLayer } from "./connections";
export {
  DiscussionInputs,
  DiscussionInputsLayer,
  DiscussionInputsReference,
  DiscussionInputsReferenceFill,
  DiscussionInputsReferenceLayer,
  SessionEditObserverLayer,
} from "./discussions";
export {
  IngestExecutorLayer,
  IngestReconcileInterval,
  OpenSignalsLayer,
  runIngestReconciler,
} from "./ingest";
export { BoundOperationsLayer } from "./bound-actions";
export {
  PermissionRequests,
  PermissionRequestsLayer,
  ProfileRemoval,
  ProfileRemovalLayer,
} from "./permissions";
export { thawExpiredFreezes } from "./promotion";
export {
  AccountUsageReadingInterval,
  ProviderAccountProbeDeadline,
  ProviderAccountProbeInterval,
  ProviderAccountProbing,
  ProviderAccountProbingLayer,
  ProviderAccountRunnerOperations,
  ProviderAccountRunnerOperationsLayer,
  ProviderAccountSignInDeadline,
  runAccountUsageReadingLoop,
} from "./provider-accounts";
export {
  Arrival,
  ArrivalLayer,
  FactsRefresh,
  FactsRefreshLayer,
  HarnessInstall,
  HarnessInstallLayer,
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
export {
  RunExecutorLayer,
  RunFibers,
  RunTargetsLayer,
  TaskTrackingRunsLayer,
  WorkspaceStepsLayer,
} from "./runs";
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
  SessionSkills,
  SessionSkillsLayer,
  sweepSessionsOnLostRunners,
} from "./sessions";
export {
  checkSchedulerInterval,
  revalidateStoredWorkflowsOrLog,
  runScheduler,
  SchedulerInterval,
  TriggeredRunsLayer,
  WorkflowRunsLayer,
  WorkflowSignalsLayer,
  WorkflowValidityObserversLayer,
} from "./workflows";
export { Provisioning, ProvisioningLayer, WorkspaceSweepInterval } from "./workspaces";
export {
  forwardTargetChanges,
  TextGenerationDeadline,
  TextGenerationLayer,
  TextGenerationTargetChanges,
  TextGenerationTargetChangesLayer,
} from "./text-generation";

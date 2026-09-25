/**
 * The controller daemon: the layer above the domains. It is the only module
 * that sends frames to runners and the only one that handles what runners
 * report. The domains below it hold rows and their rules, and depend on
 * nothing else. The providers domain is the last exception: it still sends its
 * own frames, and issue #209 moves it under the same rule.
 *
 * A use case is anything that combines writes across domains with a message to
 * a runner. There is one file per use case, grouped in one folder per concern.
 * Each folder's `index.ts` is what the rest of the controller daemon imports
 * it through:
 *
 * - `sessions/`: placing a session, starting queued sessions on a runner with
 *   room, the operations that reach a live session, and the sweep that ends
 *   the sessions of lost runners;
 * - `events/`: the event router, the pipeline that runs it, enrichment, and
 *   the routing tables and deliveries in `events/routing/`;
 * - `workspaces/`: provisioning and disposing workspaces, and the sweep that
 *   removes the ones nothing needs any more;
 * - `runners/`: handling what runners report, and retiring a runner;
 * - `permissions/`: deleting a permission profile;
 * - `runs/`: the run engine, which starts runs and executes their steps.
 *
 * The top level holds what belongs to no single folder: the steps run once at
 * boot (`boot.ts`), the helpers every long-running loop uses (`absorbing.ts`),
 * and the test helpers several folders share (`testing.ts`).
 *
 * A check shared by two use cases lives where its data lives:
 *
 * - a check that reads one domain's rows belongs to that domain
 *   (`providers/resolved.ts`);
 * - a check that reads across domains belongs here, in the folder of the use
 *   cases that share it (`sessions/resuming.ts`).
 */
export { cancelStrandedInputsAndReportLostWakeUps } from "./boot";
export {
  Enrichment,
  EnrichmentLayer,
  EventRouter,
  EventRouterLayer,
  EventRoutingInterval,
  Pipeline,
  PipelineLayer,
} from "./events";
export { ProfileRemoval, ProfileRemovalLayer } from "./permissions";
export { Inbound, InboundLayer, Retirement, RetirementLayer } from "./runners";
export { resumeUnfinishedRuns, RunEngine, RunEngineLayer, RunFibers } from "./runs";
export {
  DispatchLayer,
  Live,
  LiveLayer,
  LostRunnerSweepInterval,
  Placement,
  PlacementLayer,
  SessionInputDeadline,
  sweepSessionsOnLostRunners,
} from "./sessions";
export { Provisioning, ProvisioningLayer, WorkspaceSweepInterval } from "./workspaces";

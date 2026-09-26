/**
 * The controller daemon: the layer above the domains. A domain decides what
 * happens; the controller daemon decides where and how it runs. It owns:
 *
 * - the wire to runners: it is the only module that sends frames to runners
 *   and the only one that handles what they report, passing each result to
 *   the domain that owns it. The providers domain is the last exception: it
 *   still sends its own frames, and issue #209 moves it under the same rule;
 * - the fibers behind the ports domains declare, such as the runs domain's
 *   Run Executor;
 * - the loops that run for the life of the controller, and boot;
 * - the ports that break a cycle between two domains, and, as the last
 *   resort, an operation whose domains could not be untangled otherwise.
 *
 * See ADR 0033, amendment of 2026-09-25. There is one file per use case,
 * grouped in one folder per concern. Each folder's `index.ts` is what the rest
 * of the controller daemon imports it through:
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
 * - `workflows/`: what the workflows domain reads from the runs domain;
 * - `runs/`: the Run Executor, which gives each run's execution a fiber.
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
export { RunExecutorLayer, RunFibers } from "./runs";
export {
  AssistantSessionsLayer,
  DispatchLayer,
  Live,
  LiveLayer,
  LostRunnerSweepInterval,
  Placement,
  PlacementLayer,
  SessionInputDeadline,
  sweepSessionsOnLostRunners,
} from "./sessions";
export { WorkflowRunsLayer } from "./workflows";
export { Provisioning, ProvisioningLayer, WorkspaceSweepInterval } from "./workspaces";

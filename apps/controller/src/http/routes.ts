/**
 * The derived routes: one line per operation.
 *
 * A handler calls its service method and does nothing else. The method is on
 * its domain's service, or on a controller daemon use case when the operation
 * reaches a runner. The one thing a handler adds is what the service layer
 * must not do: it converts any failure that is not one of the contract's
 * errors, such as a database error or a bug, into `internal`. So the errors
 * on the wire stay the contract's fixed set, while the service keeps its
 * precise error types.
 *
 * Every group is handled here, because Effect's HttpApi builds routes for a
 * whole API or for none.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  api,
  createInternalError,
  isApiError,
  type ApiError,
  type Internal,
} from "@hercule/contract";
import { AgentService, AgentServiceLayer } from "../agents";
import { AssistantResponderLayer, AssistantService, AssistantServiceLayer } from "../assistants";
import { AttachmentService, AttachmentServiceLayer } from "../attachments";
import { Auth, AuthLayer } from "../auth";
import { LiveTopicsLayer, WsTickets, WsTicketsLayer } from "../live";
import { ApiKeys, ApiKeysLayer } from "../credentials";
import { EventKinds, EventKindsLayer, EventService, EventServiceLayer } from "../events";
import { ConnectionService } from "../connections";
import {
  ConversationMessagesLayer,
  ConversationService,
  ConversationServiceLayer,
} from "../conversations";
import { Controller, ControllerLayer } from "../controller";
import {
  BindableOperationsLayer,
  ArrivalLayer,
  AssistantSessionsLayer,
  DispatchLayer,
  InboundLayer,
  Live,
  LiveLayer,
  Enrichment,
  EnrichmentLayer,
  EventRouterLayer,
  PipelineLayer,
  Placement,
  PlacementLayer,
  ProfileRemoval,
  ProfileRemovalLayer,
  Provisioning,
  ProvisioningLayer,
  Retirement,
  RetirementLayer,
  RunExecutorLayer,
  RunServiceReferenceFill,
  RunTargetsLayer,
  TriggeredRunsLayer,
  WorkflowRunsLayer,
  WorkspaceStepsLayer,
} from "../daemon";
import { NotificationService, NotificationServiceLayer } from "../notifications";
import { Profiles, ProfilesLayer } from "../permissions";
import { EventKindCatalogLayer, Plugins } from "../plugins";
import { Secret, SecretLayer } from "../secrets";
import { SessionService } from "../sessions";
import { SubscriptionService, SubscriptionServiceLayer } from "../subscriptions";
import { SettingsOperations, SettingsOperationsLayer } from "../settings";
import { ProjectService, ProjectServiceLayer } from "../projects";
import { ResourceService, ResourceServiceLayer } from "../resources";
import { WorkspaceService } from "../workspaces";
import { ProviderService } from "../providers";
import { RunnerJoinLayer, RunnerService, RunnerServiceLayer } from "../runners";
import { RunService, RunServiceLayer } from "../runs";
import { Setup, SetupLayer } from "../setup";
import { TaskService, TaskServiceLayer } from "../tasks";
import { User, UserLayer } from "../users";
import {
  CronTriggerSchedulerLayer,
  TriggerEffectsLayer,
  TriggerHealthLayer,
  WorkflowService,
  WorkflowServiceLayer,
} from "../workflows";
import { buildAttachmentResponse } from "./attachment-response";

/**
 * Wraps a handler's service call: the contract's errors pass through, and
 * every other failure is logged and becomes `internal`.
 */
export const withApiErrors = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, Extract<E, ApiError> | Internal, R> =>
  Effect.catch(self, (error): Effect.Effect<never, Extract<E, ApiError> | Internal> =>
    isApiError(error)
      ? Effect.fail(error as Extract<E, ApiError>)
      : Effect.andThen(
          Effect.logError("An operation failed with something the caller cannot act on", error),
          Effect.fail(createInternalError("something went wrong")),
        ),
  );

const setupRoutes = HttpApiBuilder.group(api, "setup", (handlers) =>
  Effect.gen(function* () {
    const setup = yield* Setup;
    return handlers
      .handle("read", () => withApiErrors(setup.state()))
      .handle("complete", ({ payload }) => withApiErrors(setup.complete(payload)));
  }),
);

const authRoutes = HttpApiBuilder.group(api, "auth", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const tickets = yield* WsTickets;
    return handlers
      .handle("login", ({ payload }) => withApiErrors(auth.login(payload)))
      .handle("logout", () => withApiErrors(auth.logout()))
      .handle("wsTicket", () =>
        withApiErrors(Effect.map(tickets.issue(), (ticket) => ({ ticket }))),
      );
  }),
);

const apiKeyRoutes = HttpApiBuilder.group(api, "apiKey", (handlers) =>
  Effect.gen(function* () {
    const apiKeys = yield* ApiKeys;
    return handlers
      .handle("query", ({ query }) => withApiErrors(apiKeys.query(query)))
      .handle("create", ({ payload }) => withApiErrors(apiKeys.create(payload)))
      .handle("revoke", ({ params }) => withApiErrors(apiKeys.revoke(params)));
  }),
);

const userRoutes = HttpApiBuilder.group(api, "user", (handlers) =>
  Effect.gen(function* () {
    const user = yield* User;
    return handlers
      .handle("read", () => withApiErrors(user.read()))
      .handle("setPassword", ({ payload }) => withApiErrors(user.setPassword(payload)));
  }),
);

const settingsRoutes = HttpApiBuilder.group(api, "settings", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* SettingsOperations;
    return handlers
      .handle("read", () => withApiErrors(settings.read()))
      .handle("update", ({ payload }) => withApiErrors(settings.update(payload)));
  }),
);

const profileRoutes = HttpApiBuilder.group(api, "profile", (handlers) =>
  Effect.gen(function* () {
    const profiles = yield* Profiles;
    // A profile can be deleted only when no session or agent still uses it.
    // Both are other domains' rows, so the delete is a controller daemon use
    // case.
    const removal = yield* ProfileRemoval;
    return handlers
      .handle("query", ({ query }) => withApiErrors(profiles.query(query)))
      .handle("read", ({ params }) => withApiErrors(profiles.read(params)))
      .handle("create", ({ payload }) => withApiErrors(profiles.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(profiles.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(removal.deleteProfile(params)));
  }),
);

const secretRoutes = HttpApiBuilder.group(api, "secret", (handlers) =>
  Effect.gen(function* () {
    const secret = yield* Secret;
    return handlers
      .handle("query", ({ query }) => withApiErrors(secret.query(query)))
      .handle("set", ({ params, payload }) =>
        withApiErrors(secret.set({ ...params, value: payload.value })),
      )
      .handle("delete", ({ params }) => withApiErrors(secret.delete(params)));
  }),
);

/**
 * The connection service is not in `operationLayers`: it reads the plugin
 * host, and a request must see the host instance that the boot registered
 * plugins into.
 */
const connectionRoutes = HttpApiBuilder.group(api, "connection", (handlers) =>
  Effect.gen(function* () {
    const connections = yield* ConnectionService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(connections.query(query)))
      .handle("read", ({ params }) => withApiErrors(connections.read(params.id)))
      .handle("create", ({ payload }) => withApiErrors(connections.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(connections.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(connections.delete(params.id)))
      .handle("setCredentials", ({ params, payload }) =>
        withApiErrors(connections.setCredentials({ id: params.id, ...payload })),
      )
      .handle("startOAuth", ({ payload }) => withApiErrors(connections.startOAuth(payload)))
      .handle("startDeviceFlow", ({ payload }) =>
        withApiErrors(connections.startDeviceFlow(payload)),
      )
      .handle("pollDeviceFlow", ({ payload }) =>
        withApiErrors(connections.pollDeviceFlow(payload)),
      );
  }),
);

const taskRoutes = HttpApiBuilder.group(api, "task", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(tasks.query(query)))
      .handle("read", ({ params }) => withApiErrors(tasks.read(params.id)))
      .handle("create", ({ payload }) => withApiErrors(tasks.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(tasks.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(tasks.delete(params.id)));
  }),
);

const notificationRoutes = HttpApiBuilder.group(api, "notification", (handlers) =>
  Effect.gen(function* () {
    const notifications = yield* NotificationService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(notifications.query(query)))
      .handle("read", ({ params }) => withApiErrors(notifications.read(params.id)))
      .handle("create", ({ payload }) => withApiErrors(notifications.create(payload)))
      .handle("withdraw", ({ params, payload }) =>
        withApiErrors(notifications.withdraw({ id: params.id, ...payload })),
      )
      .handle("act", ({ params, payload }) =>
        withApiErrors(notifications.act({ id: params.id, ...payload })),
      );
  }),
);

const agentRoutes = HttpApiBuilder.group(api, "agent", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* AgentService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(agents.query(query)))
      .handle("read", ({ params }) => withApiErrors(agents.read(params.id)))
      .handle("create", ({ payload }) => withApiErrors(agents.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(agents.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(agents.delete(params.id)));
  }),
);

const assistantRoutes = HttpApiBuilder.group(api, "assistant", (handlers) =>
  Effect.gen(function* () {
    const assistants = yield* AssistantService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(assistants.query(query)))
      .handle("read", ({ params }) => withApiErrors(assistants.read(params.id)))
      .handle("create", ({ payload }) => withApiErrors(assistants.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(assistants.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(assistants.delete(params.id)));
  }),
);

const conversationRoutes = HttpApiBuilder.group(api, "conversation", (handlers) =>
  Effect.gen(function* () {
    const conversations = yield* ConversationService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(conversations.query(query)))
      .handle("read", ({ params }) => withApiErrors(conversations.read(params.id)))
      .handle("queryMessages", ({ params, query }) =>
        withApiErrors(conversations.queryMessages({ conversationId: params.id, ...query })),
      )
      .handle("send", ({ params, payload }) =>
        withApiErrors(conversations.send({ conversationId: params.id, ...payload })),
      );
  }),
);

const projectRoutes = HttpApiBuilder.group(api, "project", (handlers) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(projects.query(query)))
      .handle("read", ({ params }) => withApiErrors(projects.read(params.id)))
      .handle("create", ({ payload }) => withApiErrors(projects.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(projects.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(projects.delete(params.id)));
  }),
);

const resourceRoutes = HttpApiBuilder.group(api, "resource", (handlers) =>
  Effect.gen(function* () {
    const resources = yield* ResourceService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(resources.query(query)))
      .handle("read", ({ params }) => withApiErrors(resources.read(params.id)))
      .handle("create", ({ payload }) => withApiErrors(resources.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(resources.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(resources.delete(params.id)));
  }),
);

const workspaceRoutes = HttpApiBuilder.group(api, "workspace", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceService;
    // Provisioning and disposing of a workspace do more than write rows: the
    // runner holding the directory has to be told.
    const provisioning = yield* Provisioning;
    return handlers
      .handle("query", ({ query }) => withApiErrors(workspaces.query(query)))
      .handle("read", ({ params }) => withApiErrors(workspaces.read(params.id)))
      .handle("provision", ({ payload }) => withApiErrors(provisioning.provisionWorkspace(payload)))
      .handle("attach", ({ payload }) => withApiErrors(provisioning.attachWorkspace(payload)))
      .handle("inspect", ({ params }) => withApiErrors(provisioning.inspectWorkspace(params.id)))
      .handle("dispose", ({ params, payload }) =>
        withApiErrors(provisioning.disposeWorkspace(params.id, payload)),
      )
      .handle("detach", ({ params }) => withApiErrors(provisioning.detachWorkspace(params.id)));
  }),
);

const eventRoutes = HttpApiBuilder.group(api, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventService;
    const enrichment = yield* Enrichment;
    return handlers
      .handle("query", ({ query }) => withApiErrors(events.query(query)))
      .handle("read", ({ params }) => withApiErrors(events.read(params.id)))
      .handle("emit", ({ payload }) => withApiErrors(events.emit(payload)))
      .handle("enrich", ({ params, payload }) =>
        withApiErrors(enrichment.enrichEvent({ id: params.id, ...payload })),
      );
  }),
);

const subscriptionRoutes = HttpApiBuilder.group(api, "subscription", (handlers) =>
  Effect.gen(function* () {
    const subscriptions = yield* SubscriptionService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(subscriptions.query(query)))
      .handle("create", ({ payload }) => withApiErrors(subscriptions.create(payload)))
      .handle("cancel", ({ params }) => withApiErrors(subscriptions.cancel(params.id)));
  }),
);

const workflowRoutes = HttpApiBuilder.group(api, "workflow", (handlers) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(workflows.query(query)))
      .handle("read", ({ params }) => withApiErrors(workflows.read(params.id)))
      .handle("create", ({ payload }) => withApiErrors(workflows.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(workflows.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(workflows.delete(params.id)))
      .handle("validate", ({ payload }) => withApiErrors(workflows.validate(payload)));
  }),
);

const runRoutes = HttpApiBuilder.group(api, "run", (handlers) =>
  Effect.gen(function* () {
    const runs = yield* RunService;
    return handlers
      .handle("start", ({ payload }) => withApiErrors(runs.start(payload)))
      .handle("rerun", ({ params, payload }) => withApiErrors(runs.rerun(params.id, payload)))
      .handle("query", ({ query }) => withApiErrors(runs.query(query)))
      .handle("read", ({ params }) => withApiErrors(runs.read(params.id)))
      .handle("cancel", ({ params, payload }) => withApiErrors(runs.cancel(params.id, payload)));
  }),
);

/**
 * A trigger is declared in its workflow's YAML, and its row is written together
 * with the workflow, so the workflow service lists, pauses and resumes
 * triggers. The routes are a separate group only because the operations are
 * `trigger.*`.
 */
const triggerRoutes = HttpApiBuilder.group(api, "trigger", (handlers) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(workflows.queryTriggers(query)))
      .handle("pause", ({ params }) => withApiErrors(workflows.pauseTrigger(params)))
      .handle("resume", ({ params }) => withApiErrors(workflows.resumeTrigger(params)));
  }),
);

/**
 * The action catalog belongs to the plugins domain, because plugins and the
 * core register their actions into it at boot. The routes are a separate group
 * only because the operation is `workflowAction.query`.
 */
const workflowActionRoutes = HttpApiBuilder.group(api, "workflowAction", (handlers) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins;
    return handlers.handle("query", () => withApiErrors(plugins.queryWorkflowActions()));
  }),
);

const eventKindRoutes = HttpApiBuilder.group(api, "eventKind", (handlers) =>
  Effect.gen(function* () {
    const eventKinds = yield* EventKinds;
    return handlers.handle("query", () => withApiErrors(eventKinds.query()));
  }),
);

const runnerRoutes = HttpApiBuilder.group(api, "runner", (handlers) =>
  Effect.gen(function* () {
    const runners = yield* RunnerService;
    // Two of this group's operations are about a runner's provider instances,
    // which belong to the provider service, not the runner service.
    const providers = yield* ProviderService;
    // Retiring a runner does more than update its row: the sessions it hosted
    // and the workspaces it held end with it, and the runner is told.
    const retirement = yield* Retirement;
    return handlers
      .handle("query", ({ query }) => withApiErrors(runners.query(query)))
      .handle("read", ({ params }) => withApiErrors(runners.read(params.id)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(runners.update({ id: params.id, ...payload })),
      )
      .handle("drain", ({ params }) => withApiErrors(runners.drain(params.id)))
      .handle("undrain", ({ params }) => withApiErrors(runners.undrain(params.id)))
      .handle("retire", ({ params, payload }) =>
        withApiErrors(retirement.retireRunner({ id: params.id, ...payload })),
      )
      .handle("refreshFacts", ({ params }) => withApiErrors(runners.refreshFacts(params.id)))
      .handle("probe", ({ params, payload }) =>
        withApiErrors(providers.probe({ runnerId: params.id, ...payload })),
      )
      .handle("installHarness", ({ params, payload }) =>
        withApiErrors(providers.installHarness({ runnerId: params.id, ...payload })),
      )
      .handle("createJoinToken", () => withApiErrors(runners.createJoinToken()))
      .handle("queryJoinTokens", () => withApiErrors(runners.queryJoinTokens()))
      .handle("revokeJoinToken", ({ params }) => withApiErrors(runners.revokeJoinToken(params.id)));
  }),
);

const pluginRoutes = HttpApiBuilder.group(api, "plugin", (handlers) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins;
    return handlers
      .handle("query", () => withApiErrors(plugins.query()))
      .handle("read", ({ params }) => withApiErrors(plugins.read(params.id)))
      .handle("enable", ({ params }) => withApiErrors(plugins.enable(params.id)))
      .handle("disable", ({ params }) => withApiErrors(plugins.disable(params.id)))
      .handle("retry", ({ params }) => withApiErrors(plugins.retry(params.id)))
      .handle("resetState", ({ params }) => withApiErrors(plugins.resetState(params.id)))
      .handle("configure", ({ params, payload }) =>
        withApiErrors(plugins.configure(params.id, payload)),
      );
  }),
);

const providerRoutes = HttpApiBuilder.group(api, "provider", (handlers) =>
  Effect.gen(function* () {
    const providers = yield* ProviderService;
    return handlers
      .handle("query", () => withApiErrors(providers.query()))
      .handle("read", ({ params }) => withApiErrors(providers.read(params.id)))
      .handle("create", ({ payload }) => withApiErrors(providers.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(providers.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(providers.delete(params.id)))
      .handle("login", ({ params, payload }) =>
        withApiErrors(providers.login({ id: params.id, ...payload })),
      )
      .handle("submitLoginCode", ({ params, payload }) =>
        withApiErrors(providers.submitLoginCode({ id: params.id, ...payload })),
      );
  }),
);

const sessionRoutes = HttpApiBuilder.group(api, "session", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    // Spawning a session does more than write its row: what it runs under,
    // which runner hosts it and which workspace it starts in are decided by a
    // controller daemon use case.
    const placement = yield* Placement;
    // So is every operation that reaches the session's runner, and
    // `session.update`, whose model selection goes out with the next frame
    // and whose options are validated against that runner's model catalog.
    const live = yield* Live;
    return handlers
      .handle("query", ({ query }) => withApiErrors(sessions.query(query)))
      .handle("read", ({ params }) => withApiErrors(sessions.read(params.id)))
      .handle("querySubagents", ({ params, query }) =>
        withApiErrors(sessions.querySubagents({ id: params.id, ...query })),
      )
      .handle("spawn", ({ payload }) => withApiErrors(placement.placeSession(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(live.update({ id: params.id, ...payload })),
      )
      .handle("input", ({ params, payload }) =>
        withApiErrors(live.input({ id: params.id, ...payload })),
      )
      .handle("interrupt", ({ params, payload }) =>
        withApiErrors(live.interrupt({ id: params.id, ...payload })),
      )
      .handle("respondToApprovalRequest", ({ params, payload }) =>
        withApiErrors(live.respondToApprovalRequest({ id: params.id, ...payload })),
      )
      .handle("respondToQuestion", ({ params, payload }) =>
        withApiErrors(live.respondToQuestion({ id: params.id, ...payload })),
      )
      .handle("stop", ({ params }) => withApiErrors(live.stop(params.id)))
      .handle("continue", ({ params, payload }) =>
        withApiErrors(placement.continueSession({ id: params.id, ...payload })),
      );
  }),
);

/**
 * A session's inputs are part of the session's state, so the session service
 * serves them; the group is separate because the operations are `input.*`.
 * Steering is the exception: it sends a row to the runner, which is the
 * controller daemon's job.
 */
const inputRoutes = HttpApiBuilder.group(api, "input", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const live = yield* Live;
    return handlers
      .handle("query", ({ params, query }) =>
        withApiErrors(sessions.queryInputs({ id: params.id, ...query })),
      )
      .handle("update", ({ params, payload }) =>
        withApiErrors(sessions.updateInput({ ...params, ...payload })),
      )
      .handle("cancel", ({ params }) =>
        withApiErrors(sessions.cancelInput(params.id, params.inputId)),
      )
      .handle("steer", ({ params }) => withApiErrors(live.steer(params.id, params.inputId)));
  }),
);

/**
 * The images a user attaches to an input. The content is streamed from its
 * file (`buildAttachmentResponse`).
 */
const attachmentRoutes = HttpApiBuilder.group(api, "attachment", (handlers) =>
  Effect.gen(function* () {
    const attachments = yield* AttachmentService;
    return handlers
      .handle("create", ({ query, payload }) =>
        withApiErrors(attachments.create({ name: query.name, bytes: payload })),
      )
      .handle("readContent", ({ params }) =>
        withApiErrors(Effect.flatMap(attachments.readContent(params.id), buildAttachmentResponse)),
      )
      .handle("delete", ({ params }) => withApiErrors(attachments.delete(params.id)));
  }),
);

/**
 * A transcript is the session's own stream, so the session service serves
 * it; the group is separate because the operation is `transcript.read`.
 */
const transcriptRoutes = HttpApiBuilder.group(api, "transcript", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    return handlers.handle("read", ({ params, query }) =>
      withApiErrors(sessions.transcript({ id: params.id, ...query })),
    );
  }),
);

const controllerRoutes = HttpApiBuilder.group(api, "controller", (handlers) =>
  Effect.gen(function* () {
    const controller = yield* Controller;
    return handlers
      .handle("read", () => withApiErrors(controller.read()))
      .handle("update", ({ payload }) => withApiErrors(controller.update(payload)));
  }),
);

/**
 * Builds the `EventKinds` service. The events domain lists the event kinds that
 * the plugins domain registered. The plugins domain already imports the events
 * domain to append to the event log, so the events domain cannot import the
 * plugins domain. The two are wired together here, where the whole controller
 * is assembled.
 */
const EventKindsOperationLayer = EventKindsLayer.pipe(Layer.provide(EventKindCatalogLayer));

/**
 * The workflows domain's services: the workflow service, the trigger health,
 * and the rule the Scheduler applies to cron triggers.
 *
 * - The workflow service validates each trigger against the same list of
 *   event kinds that `eventKind.query` returns, and asks the runs domain,
 *   through the controller daemon, whether a workflow still has an unfinished
 *   run.
 * - The Scheduler records a trigger it cannot schedule on the trigger's
 *   health. The event router records there too, so the trigger health is
 *   merged next to the other two.
 *
 * The domain's trigger effects start runs, so they are built above the run
 * domain instead (see the event pipeline below).
 */
const WorkflowDomainLayer = Layer.mergeAll(
  WorkflowServiceLayer.pipe(
    Layer.provide(EventKindsOperationLayer),
    Layer.provide(WorkflowRunsLayer),
  ),
  CronTriggerSchedulerLayer,
).pipe(Layer.provideMerge(TriggerHealthLayer));

/**
 * The run service with the services it is built from.
 *
 * - The run service reads workflows and calls the task service from its
 *   steps, so both domains are provided to it rather than merged next to it.
 * - A run's execution is carried out by the controller daemon's Run Executor,
 *   apart from any request, so the live topics' listener is provided to the
 *   service as well.
 * - A run's workspace steps reach their runners through the controller
 *   daemon's Workspace Steps, which opens and stops the sessions of agent
 *   steps through placement and `Live`.
 *
 * Several groups below are provided this one layer. A layer is built once
 * however many times it is provided, so they all share one run service, and
 * Workspace Steps shares placement, `Live` and dispatch with the group that
 * serves sessions.
 */
const RunDomainLayer = RunServiceLayer.pipe(
  Layer.provideMerge(WorkflowDomainLayer),
  Layer.provideMerge(TaskServiceLayer),
  Layer.provideMerge(RunExecutorLayer),
  Layer.provideMerge(
    WorkspaceStepsLayer.pipe(
      Layer.provide(Layer.mergeAll(PlacementLayer, LiveLayer).pipe(Layer.provide(DispatchLayer))),
    ),
  ),
  Layer.provide(LiveTopicsLayer),
);

/**
 * Every service an operation uses, together with the controller daemon. The
 * listener starts the controller daemon's drivers, so they are built here
 * rather than a second time elsewhere. It is one list because otherwise a
 * controller could boot without a layer an operation needs, and nothing would
 * show it until a request used that operation.
 *
 * Six services are left out on purpose: `Plugins`, `ProviderService`,
 * `SessionService`, `WorkspaceService`, `RunnerConnections` and
 * `ProviderProbes`. They must be the instances the boot built. A second
 * instance would have no plugins, no connections and none of the state a
 * session's stream is coalesced in, and would write over the same rows the
 * drivers use. The handlers get them from the boot.
 */
export const operationLayers = Layer.mergeAll(
  AuthLayer,
  ApiKeysLayer,
  UserLayer,
  SecretLayer,
  ControllerLayer,
  SettingsOperationsLayer,
  // The controller daemon's profile removal uses the profile service, so the
  // profile service is provided to it rather than merged next to it.
  ProfileRemovalLayer.pipe(Layer.provideMerge(ProfilesLayer)),
  AgentServiceLayer,
  ProjectServiceLayer,
  ResourceServiceLayer,
  // The controller daemon's retirement uses the runner service, so the runner
  // service is provided to it rather than merged next to it. Retiring a runner
  // fails the runs pinned to it, so the run service is provided too.
  RetirementLayer.pipe(Layer.provideMerge(RunnerServiceLayer), Layer.provide(RunDomainLayer)),
  // A runner that connects is sent the workspace steps still running on it,
  // and wakes the runs waiting for a runner.
  ArrivalLayer.pipe(Layer.provide(RunDomainLayer)),
  RunnerJoinLayer,
  // The inbound driver uses both dispatch and `Live`, placement uses dispatch,
  // and matched inputs are delivered through `Live` too. Setup creates the
  // first assistant. So those are provided to the group rather than merged
  // next to it, each above what it uses:
  //
  // - an assistant's create makes its conversation;
  // - a conversation hands each sent message to the assistant's responder;
  // - the assistant's responder and its delete reach sessions through the
  //   controller daemon's `AssistantSessions`, which uses placement and `Live`;
  // - the responder writes the notice for a message it could not deliver
  //   through `ConversationMessages`, as a send appends. An assistant's
  //   replies and its other notices are written by the session service
  //   itself, through the sessions domain's `SessionObserver` port, which
  //   boot provides with the session service;
  // - placement and `Live` both use dispatch, which is provided last.
  //
  // The inbound driver hands a workspace step's result to the run service.
  // The notification service runs the operation of a chosen answer through
  // its `BindableOperations` port, which the controller daemon implements,
  // and the operation can be a task, run or live session operation. So the port gets the run layers,
  // which include the task service, and sits in this group, which provides
  // `Live`.
  Layer.mergeAll(
    InboundLayer.pipe(Layer.provide(RunDomainLayer)),
    NotificationServiceLayer.pipe(
      Layer.provide(BindableOperationsLayer.pipe(Layer.provide(RunDomainLayer))),
    ),
    SetupLayer,
    // The events service reads the registered event kinds from the plugins
    // domain. The plugins domain appends to the event log, so the events
    // domain cannot import it; the two are wired together here, where the
    // whole controller is assembled. Enrichment writes through the events
    // service, so the events service is provided to it rather than merged
    // next to it. The pipeline and enrichment share one router, so the router
    // is provided to both. Both record a start trigger's match as a trigger
    // effect, and its failed filter on its health. The pipeline also starts
    // the runs of the matches, and the trigger effects start them through
    // the run service (`TriggeredRunsLayer`), so the trigger effects are
    // provided above the run domain.
    Layer.mergeAll(
      PipelineLayer,
      EnrichmentLayer.pipe(
        Layer.provideMerge(EventServiceLayer.pipe(Layer.provide(EventKindCatalogLayer))),
      ),
    ).pipe(
      Layer.provideMerge(EventRouterLayer),
      Layer.provide(TriggerEffectsLayer.pipe(Layer.provide(TriggeredRunsLayer))),
      Layer.provide(RunDomainLayer),
    ),
  ).pipe(
    Layer.provideMerge(AssistantServiceLayer),
    Layer.provideMerge(ConversationServiceLayer),
    Layer.provideMerge(AssistantResponderLayer),
    Layer.provideMerge(AssistantSessionsLayer),
    Layer.provideMerge(PlacementLayer),
    Layer.provideMerge(LiveLayer),
    Layer.provideMerge(ConversationMessagesLayer),
    Layer.provideMerge(DispatchLayer),
  ),
  ProvisioningLayer,
  // The subscription service checks a run target through its Run Targets
  // port: the controller daemon answers it with RunService.read, which checks
  // that the run exists and that the caller may read it, and then tells
  // whether the run has ended.
  SubscriptionServiceLayer.pipe(Layer.provide(RunTargetsLayer), Layer.provide(RunDomainLayer)),
  EventKindsOperationLayer,
  RunDomainLayer,
  // The session service's observer fails an agent step through the run
  // service, which is built here, after the session service. So the observer
  // holds a reference that this layer sets once the run service is built.
  RunServiceReferenceFill.pipe(Layer.provide(RunDomainLayer)),
  LiveTopicsLayer,
  WsTicketsLayer,
  AttachmentServiceLayer,
);

/** The handlers of every group, which `HttpApiBuilder.layer(api)` needs to build routes. */
export const handlerLayers = Layer.mergeAll(
  setupRoutes,
  authRoutes,
  apiKeyRoutes,
  userRoutes,
  settingsRoutes,
  profileRoutes,
  secretRoutes,
  controllerRoutes,
  taskRoutes,
  notificationRoutes,
  agentRoutes,
  assistantRoutes,
  conversationRoutes,
  projectRoutes,
  resourceRoutes,
  workspaceRoutes,
  connectionRoutes,
  eventRoutes,
  subscriptionRoutes,
  workflowRoutes,
  triggerRoutes,
  workflowActionRoutes,
  eventKindRoutes,
  runRoutes,
  runnerRoutes,
  pluginRoutes,
  providerRoutes,
  sessionRoutes,
  inputRoutes,
  transcriptRoutes,
  attachmentRoutes,
);

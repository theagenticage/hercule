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
  CapExceeded,
  Conflict,
  Forbidden,
  createInternalError,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
  type ApiError,
} from "@hercule/contract";
import { AgentService, AgentServiceLayer } from "../agents";
import { Auth, AuthLayer } from "../auth";
import { LiveTopicsLayer, WsTickets, WsTicketsLayer } from "../live";
import { ApiKeys, ApiKeysLayer } from "../credentials";
import { EventKinds, EventKindsLayer, EventService, EventServiceLayer } from "../events";
import { ConnectionService } from "../connections";
import { Controller, ControllerLayer } from "../controller";
import {
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
} from "../daemon";
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
import { Setup, SetupLayer } from "../setup";
import { TaskService, TaskServiceLayer } from "../tasks";
import { User, UserLayer } from "../users";
import { WorkflowService, WorkflowServiceLayer } from "../workflows";

const API_ERRORS = [
  Unauthenticated,
  Forbidden,
  Validation,
  NotFound,
  Conflict,
  InvalidState,
  CapExceeded,
  Internal,
];

const isApiError = (error: unknown): error is ApiError =>
  API_ERRORS.some((constructor) => error instanceof constructor);

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
    return handlers.handle("setPassword", ({ payload }) =>
      withApiErrors(user.setPassword(payload)),
    );
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
      .handle("read", ({ params }) => withApiErrors(connections.read(params)))
      .handle("create", ({ payload }) => withApiErrors(connections.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(connections.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(connections.delete(params)))
      .handle("setCredentials", ({ params, payload }) =>
        withApiErrors(connections.setCredentials({ id: params.id, ...payload })),
      )
      .handle("startOAuth", ({ payload }) => withApiErrors(connections.startOAuth(payload)));
  }),
);

const taskRoutes = HttpApiBuilder.group(api, "task", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(tasks.query(query)))
      .handle("read", ({ params }) => withApiErrors(tasks.read(params)))
      .handle("create", ({ payload }) => withApiErrors(tasks.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(tasks.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(tasks.delete(params)));
  }),
);

const agentRoutes = HttpApiBuilder.group(api, "agent", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* AgentService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(agents.query(query)))
      .handle("read", ({ params }) => withApiErrors(agents.read(params)))
      .handle("create", ({ payload }) => withApiErrors(agents.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(agents.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(agents.delete(params)));
  }),
);

const projectRoutes = HttpApiBuilder.group(api, "project", (handlers) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(projects.query(query)))
      .handle("read", ({ params }) => withApiErrors(projects.read(params)))
      .handle("create", ({ payload }) => withApiErrors(projects.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(projects.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(projects.delete(params)));
  }),
);

const resourceRoutes = HttpApiBuilder.group(api, "resource", (handlers) =>
  Effect.gen(function* () {
    const resources = yield* ResourceService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(resources.query(query)))
      .handle("read", ({ params }) => withApiErrors(resources.read(params)))
      .handle("create", ({ payload }) => withApiErrors(resources.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(resources.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(resources.delete(params)));
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
      .handle("read", ({ params }) => withApiErrors(workspaces.read(params)))
      .handle("provision", ({ payload }) => withApiErrors(provisioning.provisionWorkspace(payload)))
      .handle("dispose", ({ params }) => withApiErrors(provisioning.disposeWorkspace(params)));
  }),
);

const eventRoutes = HttpApiBuilder.group(api, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventService;
    const enrichment = yield* Enrichment;
    return handlers
      .handle("query", ({ query }) => withApiErrors(events.query(query)))
      .handle("read", ({ params }) => withApiErrors(events.read(params)))
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
      .handle("cancel", ({ params }) => withApiErrors(subscriptions.cancel(params)));
  }),
);

const workflowRoutes = HttpApiBuilder.group(api, "workflow", (handlers) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowService;
    return handlers
      .handle("query", ({ query }) => withApiErrors(workflows.query(query)))
      .handle("read", ({ params }) => withApiErrors(workflows.read(params)))
      .handle("create", ({ payload }) => withApiErrors(workflows.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(workflows.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(workflows.delete(params)))
      .handle("validate", ({ payload }) => withApiErrors(workflows.validate(payload)));
  }),
);

/**
 * A trigger is declared in its workflow's YAML, and its row is written together
 * with the workflow, so the workflow service lists triggers. The routes are a
 * separate group only because the operation is `trigger.query`.
 */
const triggerRoutes = HttpApiBuilder.group(api, "trigger", (handlers) =>
  Effect.gen(function* () {
    const workflows = yield* WorkflowService;
    return handlers.handle("query", ({ query }) => withApiErrors(workflows.queryTriggers(query)));
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
      .handle("read", ({ params }) => withApiErrors(runners.read(params)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(runners.update({ id: params.id, ...payload })),
      )
      .handle("drain", ({ params }) => withApiErrors(runners.drain(params)))
      .handle("undrain", ({ params }) => withApiErrors(runners.undrain(params)))
      .handle("retire", ({ params, payload }) =>
        withApiErrors(retirement.retireRunner({ id: params.id, ...payload })),
      )
      .handle("refreshFacts", ({ params }) => withApiErrors(runners.refreshFacts(params)))
      .handle("probe", ({ params, payload }) =>
        withApiErrors(providers.probe({ runnerId: params.id, ...payload })),
      )
      .handle("installHarness", ({ params, payload }) =>
        withApiErrors(providers.installHarness({ runnerId: params.id, ...payload })),
      )
      .handle("createJoinToken", () => withApiErrors(runners.createJoinToken()))
      .handle("queryJoinTokens", () => withApiErrors(runners.queryJoinTokens()))
      .handle("revokeJoinToken", ({ params }) => withApiErrors(runners.revokeJoinToken(params)));
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
      .handle("read", ({ params }) => withApiErrors(providers.read(params)))
      .handle("create", ({ payload }) => withApiErrors(providers.create(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(providers.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => withApiErrors(providers.delete(params)))
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
      .handle("read", ({ params }) => withApiErrors(sessions.read(params)))
      .handle("spawn", ({ payload }) => withApiErrors(placement.placeSession(payload)))
      .handle("update", ({ params, payload }) =>
        withApiErrors(live.update({ id: params.id, ...payload })),
      )
      .handle("input", ({ params, payload }) =>
        withApiErrors(live.input({ id: params.id, ...payload })),
      )
      .handle("interrupt", ({ params }) => withApiErrors(live.interrupt(params)))
      .handle("respond", ({ params, payload }) =>
        withApiErrors(live.respond({ id: params.id, ...payload })),
      )
      .handle("stop", ({ params }) => withApiErrors(live.stop(params)))
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
      .handle("cancel", ({ params }) => withApiErrors(sessions.cancelInput(params)))
      .handle("steer", ({ params }) => withApiErrors(live.steer(params)));
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
 *
 * `EvaluationErrorNotifier` is left to the caller for a related reason: a
 * test checks what a routing table reported by passing in its own notifier,
 * which a layer provided here would prevent.
 */
export const operationLayers = Layer.mergeAll(
  SetupLayer,
  AuthLayer,
  ApiKeysLayer,
  UserLayer,
  SecretLayer,
  ControllerLayer,
  SettingsOperationsLayer,
  // The controller daemon's profile removal uses the profile service, so the
  // profile service is provided to it rather than merged next to it.
  ProfileRemovalLayer.pipe(Layer.provideMerge(ProfilesLayer)),
  TaskServiceLayer,
  AgentServiceLayer,
  ProjectServiceLayer,
  ResourceServiceLayer,
  // The controller daemon's retirement uses the runner service, so the runner
  // service is provided to it rather than merged next to it.
  RetirementLayer.pipe(Layer.provideMerge(RunnerServiceLayer)),
  RunnerJoinLayer,
  // The inbound driver uses both dispatch and `Live`, placement uses dispatch,
  // and matched inputs are delivered through `Live` too. So those are
  // provided to the group rather than merged next to it. `Live` also uses
  // dispatch, which is why dispatch is provided last, under `Live`.
  Layer.mergeAll(
    InboundLayer,
    PlacementLayer,
    // The events service reads the registered event kinds from the plugins
    // domain. The plugins domain appends to the event log, so the events
    // domain cannot import it; the two are wired together here, where the
    // whole controller is assembled. Enrichment writes through the events
    // service, so the events service is provided to it rather than merged
    // next to it. The pipeline and enrichment share one router, so the router
    // is provided to both.
    Layer.mergeAll(
      PipelineLayer,
      EnrichmentLayer.pipe(
        Layer.provideMerge(EventServiceLayer.pipe(Layer.provide(EventKindCatalogLayer))),
      ),
    ).pipe(Layer.provideMerge(EventRouterLayer)),
  ).pipe(Layer.provideMerge(LiveLayer), Layer.provideMerge(DispatchLayer)),
  ProvisioningLayer,
  SubscriptionServiceLayer,
  EventKindsOperationLayer,
  // The workflow service validates each trigger against the same list of event
  // kinds that `eventKind.query` returns.
  WorkflowServiceLayer.pipe(Layer.provide(EventKindsOperationLayer)),
  LiveTopicsLayer,
  WsTicketsLayer,
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
  agentRoutes,
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
  runnerRoutes,
  pluginRoutes,
  providerRoutes,
  sessionRoutes,
  inputRoutes,
  transcriptRoutes,
);

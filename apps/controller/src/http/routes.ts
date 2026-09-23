/**
 * The derived routes: one line per operation.
 *
 * A handler calls its service method - its domain's service, or a controller
 * daemon use case where carrying the operation out reaches a machine - and does
 * nothing else. What it does add is the one thing the service layer must not:
 * turning a failure that is not one of the contract's errors - a database that
 * will not answer, a bug - into `internal`, so the error channel on the wire
 * stays the closed enum while the service keeps its honest one.
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
 * What a handler wraps its service call in: the contract's errors pass through
 * and everything else becomes a logged `internal`.
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
    // A profile is deleted only once no session and no agent still holds it,
    // and both of those are other domains' rows, so the delete is a layer up.
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
 * The connection service is not in `operationLayers`: it reads the plugin host,
 * and the host a request must see is the one the boot registered into.
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
    // Making a working area and taking one away are more than their rows: the
    // machine holding the directory has to be told.
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
    // Two of this group's operations are about a machine's provider instances,
    // which are this service's, not the runner service's.
    const providers = yield* ProviderService;
    // Retiring a machine is more than its row: the sessions it was hosting and
    // the working areas it held go with it, and it is told so.
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
    // Opening a session is more than its row: what it runs under, which machine
    // hosts it and the working area it starts in are settled a layer up.
    const placement = yield* Placement;
    // So is everything whose effect reaches the machine holding it, and
    // `session.update`, whose selection rides the next frame and whose picks
    // are judged against that machine's own catalog.
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
 * A session's inputs are the session's own state, so they are served by the
 * session service; the group is separate because the operations are `input.*`.
 * Steering is the exception: it puts a row on the wire, which is the controller
 * daemon's.
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
 * A transcript is the session's own stream, so it is served by the session
 * service; the group is separate because the operation is `transcript.read`.
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
 * Every service an operation resolves, and the controller daemon beside them:
 * the listener forks the controller daemon's drivers, so they are built here
 * rather than a second time somewhere else. One list, because a controller
 * booting with a layer this list has and its own does not is a controller
 * missing an operation, and nothing would say so until a request asked for it.
 *
 * Six are deliberately absent. `Plugins`, `ProviderService`, `SessionService`,
 * `WorkspaceService`, `RunnerConnections` and `ProviderProbes` must be the
 * instances the boot built: a second one would hold no plugins, no connections,
 * none of the ingest state a session's stream is coalesced in, and would write
 * over the same rows the drivers act on. They reach the handlers from there.
 *
 * `EvaluationErrorNotifier` is left to the caller for the same reason from the
 * other side: a test reads what a routing table reported by handing over a
 * listener of its own, which a layer provided in here could not be replaced by.
 */
export const operationLayers = Layer.mergeAll(
  SetupLayer,
  AuthLayer,
  ApiKeysLayer,
  UserLayer,
  SecretLayer,
  ControllerLayer,
  SettingsOperationsLayer,
  // The controller daemon's profile-removal use case reaches the profile
  // service, so that one is layered under it rather than merged beside it.
  ProfileRemovalLayer.pipe(Layer.provideMerge(ProfilesLayer)),
  TaskServiceLayer,
  AgentServiceLayer,
  ProjectServiceLayer,
  ResourceServiceLayer,
  // The controller daemon's retirement use case reaches the runner service, so
  // that one is layered under it rather than merged beside it.
  RetirementLayer.pipe(Layer.provideMerge(RunnerServiceLayer)),
  RunnerJoinLayer,
  // The inbound driver reaches both dispatch and the live channel, placement
  // reaches dispatch, and the delivery of what a routing table matched goes out
  // through that same live channel, so those three are layered under the group
  // rather than merged beside it. The live channel reaches dispatch too, which
  // is why it is provided first.
  Layer.mergeAll(
    InboundLayer,
    PlacementLayer,
    // The events service reads what kinds exist from the plugins domain, which
    // appends to the event log and so may not be imported by it; the two meet
    // here, where the whole controller is assembled. The controller daemon's
    // enrichment use case writes through that same service, so it is layered
    // over it rather than merged beside it. The clock and the enrichment both
    // hand their work to one router, so the router is provided to the pair.
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

/** Every group's handlers. What `HttpApiBuilder.layer(api)` needs to build routes. */
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

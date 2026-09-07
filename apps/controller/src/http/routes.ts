/**
 * The derived routes: one line per operation.
 *
 * A handler calls its service method and does nothing else. What it does add is
 * the one thing the service layer must not: turning a failure that is not one
 * of the contract's errors - a database that will not answer, a bug - into
 * `internal`, so the error channel on the wire stays the closed enum while the
 * service keeps its honest one.
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
  internal,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
  type ApiError,
} from "@hydra/contract";
import { Auth, AuthLayer } from "../auth";
import { LiveTopicsLayer, WsTickets, WsTicketsLayer } from "../live";
import { ApiKeys, ApiKeysLayer } from "../credentials";
import { EventService, EventServiceLayer } from "../events";
import { Controller, ControllerLayer } from "../controller";
import { Profiles, ProfilesLayer } from "../permissions";
import { Plugins } from "../plugins";
import { Secret, SecretLayer } from "../secrets";
import { SessionService } from "../sessions";
import { SettingsOperations, SettingsOperationsLayer } from "../settings";
import { ProjectService, ProjectServiceLayer } from "../projects";
import { ProviderService } from "../providers";
import { RunnerJoinLayer, RunnerService, RunnerServiceLayer } from "../runners";
import { Setup, SetupLayer } from "../setup";
import { TaskService, TaskServiceLayer } from "../tasks";
import { User, UserLayer } from "../users";

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
export const operation = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, Extract<E, ApiError> | Internal, R> =>
  Effect.catch(self, (error): Effect.Effect<never, Extract<E, ApiError> | Internal> =>
    isApiError(error)
      ? Effect.fail(error as Extract<E, ApiError>)
      : Effect.andThen(
          Effect.logError("An operation failed with something the caller cannot act on", error),
          Effect.fail(internal("something went wrong")),
        ),
  );

const setupRoutes = HttpApiBuilder.group(api, "setup", (handlers) =>
  Effect.gen(function* () {
    const setup = yield* Setup;
    return handlers
      .handle("read", () => operation(setup.state()))
      .handle("complete", ({ payload }) => operation(setup.complete(payload)));
  }),
);

const authRoutes = HttpApiBuilder.group(api, "auth", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const tickets = yield* WsTickets;
    return handlers
      .handle("login", ({ payload }) => operation(auth.login(payload)))
      .handle("logout", () => operation(auth.logout()))
      .handle("wsTicket", () => operation(Effect.map(tickets.issue(), (ticket) => ({ ticket }))));
  }),
);

const apiKeyRoutes = HttpApiBuilder.group(api, "apiKey", (handlers) =>
  Effect.gen(function* () {
    const apiKeys = yield* ApiKeys;
    return handlers
      .handle("query", ({ query }) => operation(apiKeys.query(query)))
      .handle("create", ({ payload }) => operation(apiKeys.create(payload)))
      .handle("revoke", ({ params }) => operation(apiKeys.revoke(params)));
  }),
);

const userRoutes = HttpApiBuilder.group(api, "user", (handlers) =>
  Effect.gen(function* () {
    const user = yield* User;
    return handlers.handle("setPassword", ({ payload }) => operation(user.setPassword(payload)));
  }),
);

const settingsRoutes = HttpApiBuilder.group(api, "settings", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* SettingsOperations;
    return handlers
      .handle("read", () => operation(settings.read()))
      .handle("update", ({ payload }) => operation(settings.update(payload)));
  }),
);

const profileRoutes = HttpApiBuilder.group(api, "profile", (handlers) =>
  Effect.gen(function* () {
    const profiles = yield* Profiles;
    return handlers
      .handle("query", ({ query }) => operation(profiles.query(query)))
      .handle("read", ({ params }) => operation(profiles.read(params)))
      .handle("create", ({ payload }) => operation(profiles.create(payload)))
      .handle("update", ({ params, payload }) =>
        operation(profiles.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => operation(profiles.delete(params)));
  }),
);

const secretRoutes = HttpApiBuilder.group(api, "secret", (handlers) =>
  Effect.gen(function* () {
    const secret = yield* Secret;
    return handlers
      .handle("query", ({ query }) => operation(secret.query(query)))
      .handle("set", ({ params, payload }) =>
        operation(secret.set({ ...params, value: payload.value })),
      )
      .handle("delete", ({ params }) => operation(secret.delete(params)));
  }),
);

const taskRoutes = HttpApiBuilder.group(api, "task", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    return handlers
      .handle("query", ({ query }) => operation(tasks.query(query)))
      .handle("read", ({ params }) => operation(tasks.read(params)))
      .handle("create", ({ payload }) => operation(tasks.create(payload)))
      .handle("update", ({ params, payload }) =>
        operation(tasks.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => operation(tasks.delete(params)));
  }),
);

const projectRoutes = HttpApiBuilder.group(api, "project", (handlers) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService;
    return handlers
      .handle("query", ({ query }) => operation(projects.query(query)))
      .handle("read", ({ params }) => operation(projects.read(params)))
      .handle("create", ({ payload }) => operation(projects.create(payload)))
      .handle("update", ({ params, payload }) =>
        operation(projects.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => operation(projects.delete(params)));
  }),
);

const eventRoutes = HttpApiBuilder.group(api, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventService;
    return handlers
      .handle("query", ({ query }) => operation(events.query(query)))
      .handle("read", ({ params }) => operation(events.read(params)));
  }),
);

const runnerRoutes = HttpApiBuilder.group(api, "runner", (handlers) =>
  Effect.gen(function* () {
    const runners = yield* RunnerService;
    // Two of this group's operations are about a machine's provider instances,
    // which are this service's, not the runner service's.
    const providers = yield* ProviderService;
    return handlers
      .handle("query", ({ query }) => operation(runners.query(query)))
      .handle("read", ({ params }) => operation(runners.read(params)))
      .handle("update", ({ params, payload }) =>
        operation(runners.update({ id: params.id, ...payload })),
      )
      .handle("drain", ({ params }) => operation(runners.drain(params)))
      .handle("undrain", ({ params }) => operation(runners.undrain(params)))
      .handle("retire", ({ params, payload }) =>
        operation(runners.retire({ id: params.id, ...payload })),
      )
      .handle("refreshFacts", ({ params }) => operation(runners.refreshFacts(params)))
      .handle("probe", ({ params, payload }) =>
        operation(providers.probe({ runnerId: params.id, ...payload })),
      )
      .handle("installHarness", ({ params, payload }) =>
        operation(providers.installHarness({ runnerId: params.id, ...payload })),
      )
      .handle("createJoinToken", () => operation(runners.createJoinToken()))
      .handle("queryJoinTokens", () => operation(runners.queryJoinTokens()))
      .handle("revokeJoinToken", ({ params }) => operation(runners.revokeJoinToken(params)));
  }),
);

const pluginRoutes = HttpApiBuilder.group(api, "plugin", (handlers) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins;
    return handlers
      .handle("query", () => operation(plugins.query()))
      .handle("read", ({ params }) => operation(plugins.read(params.id)))
      .handle("enable", ({ params }) => operation(plugins.enable(params.id)))
      .handle("disable", ({ params }) => operation(plugins.disable(params.id)))
      .handle("retry", ({ params }) => operation(plugins.retry(params.id)))
      .handle("resetState", ({ params }) => operation(plugins.resetState(params.id)))
      .handle("configure", ({ params, payload }) =>
        operation(plugins.configure(params.id, payload)),
      );
  }),
);

const providerRoutes = HttpApiBuilder.group(api, "provider", (handlers) =>
  Effect.gen(function* () {
    const providers = yield* ProviderService;
    return handlers
      .handle("query", () => operation(providers.query()))
      .handle("read", ({ params }) => operation(providers.read(params)))
      .handle("create", ({ payload }) => operation(providers.create(payload)))
      .handle("update", ({ params, payload }) =>
        operation(providers.update({ id: params.id, ...payload })),
      )
      .handle("delete", ({ params }) => operation(providers.delete(params)))
      .handle("login", ({ params, payload }) =>
        operation(providers.login({ id: params.id, ...payload })),
      )
      .handle("submitLoginCode", ({ params, payload }) =>
        operation(providers.submitLoginCode({ id: params.id, ...payload })),
      );
  }),
);

const sessionRoutes = HttpApiBuilder.group(api, "session", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    return handlers
      .handle("query", ({ query }) => operation(sessions.query(query)))
      .handle("read", ({ params }) => operation(sessions.read(params)))
      .handle("spawn", ({ payload }) => operation(sessions.spawn(payload)))
      .handle("input", ({ params, payload }) =>
        operation(sessions.input({ id: params.id, ...payload })),
      );
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
      operation(sessions.transcript({ id: params.id, ...query })),
    );
  }),
);

const controllerRoutes = HttpApiBuilder.group(api, "controller", (handlers) =>
  Effect.gen(function* () {
    const controller = yield* Controller;
    return handlers
      .handle("read", () => operation(controller.read()))
      .handle("update", ({ payload }) => operation(controller.update(payload)));
  }),
);

/**
 * Every service an operation resolves. One list, because a controller booting
 * with a layer this list has and its own does not is a controller missing an
 * operation, and nothing would say so until a request asked for it.
 *
 * Five are deliberately absent. `Plugins`, `ProviderService`, `SessionService`,
 * `RunnerPresence` and `ProviderProbes` must be the instances the boot built: a
 * second one would hold no plugins, no connections and none of the ingest state
 * a session's stream is coalesced in. They reach the handlers from there.
 */
export const operationLayers = Layer.mergeAll(
  SetupLayer,
  AuthLayer,
  ApiKeysLayer,
  UserLayer,
  SecretLayer,
  ControllerLayer,
  SettingsOperationsLayer,
  ProfilesLayer,
  TaskServiceLayer,
  ProjectServiceLayer,
  RunnerServiceLayer,
  RunnerJoinLayer,
  EventServiceLayer,
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
  projectRoutes,
  eventRoutes,
  runnerRoutes,
  pluginRoutes,
  providerRoutes,
  sessionRoutes,
  transcriptRoutes,
);

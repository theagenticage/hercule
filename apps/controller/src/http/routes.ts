/**
 * The derived routes: one line per operation (ADR 0031, spec 11 section 1.1).
 *
 * A handler calls its service method and does nothing else. What it does add is
 * the one thing the service layer must not: turning a failure that is not one
 * of the contract's errors - a database that will not answer, a bug - into
 * `internal`, so the error channel on the wire stays the closed enum while the
 * service keeps its honest one.
 *
 * The six groups whose services are not written yet are declared here failing
 * with `internal`, because Effect's HttpApi builds routes for a whole API or
 * for none. Each is one line, and the ticket that writes the service replaces
 * it with the same line pointing at a real method.
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
  type OperationId,
} from "@hydra/contract";
import { Auth } from "../auth";
import { ApiKeys } from "../credentials";
import { Setup } from "../setup";
import { User } from "../users";

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
 * and everything else becomes a logged `internal` (spec 11 section 1.5).
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

/** Not written yet. The route exists so the API is whole; the ticket named replaces it. */
const pending = (id: OperationId): Effect.Effect<never, Internal> =>
  Effect.fail(internal(`${id} is not implemented yet`));

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
    return handlers
      .handle("login", ({ payload }) => operation(auth.login(payload)))
      .handle("logout", () => operation(auth.logout()));
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

// TODO(#57 WP7): settings.read/update and profile.query/read/create/update/delete
const settingsRoutes = HttpApiBuilder.group(api, "settings", (handlers) =>
  handlers.handleAll({
    read: () => pending("settings.read"),
    update: () => pending("settings.update"),
  }),
);

const profileRoutes = HttpApiBuilder.group(api, "profile", (handlers) =>
  handlers.handleAll({
    query: () => pending("profile.query"),
    read: () => pending("profile.read"),
    create: () => pending("profile.create"),
    update: () => pending("profile.update"),
    delete: () => pending("profile.delete"),
  }),
);

// TODO(#57 WP8): secret.query/set/delete and controller.read
const secretRoutes = HttpApiBuilder.group(api, "secret", (handlers) =>
  handlers.handleAll({
    query: () => pending("secret.query"),
    set: () => pending("secret.set"),
    delete: () => pending("secret.delete"),
  }),
);

const controllerRoutes = HttpApiBuilder.group(api, "controller", (handlers) =>
  handlers.handleAll({ read: () => pending("controller.read") }),
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
);

/**
 * The derived routes: one line per operation (ADR 0031, spec 11 section 1.1).
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
import { Auth } from "../auth";
import { ApiKeys } from "../credentials";
import { Controller } from "../identity";
import { Profiles } from "../permissions";
import { Secret } from "../secrets";
import { SettingsOperations } from "../settings";
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

const controllerRoutes = HttpApiBuilder.group(api, "controller", (handlers) =>
  Effect.gen(function* () {
    const controller = yield* Controller;
    return handlers.handle("read", () => operation(controller.read()));
  }),
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

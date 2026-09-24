/**
 * The two credential gates, implemented.
 *
 * `Authenticated` resolves the bearer token to an actor and then runs the
 * static grant check for the operation, both before the derived route decodes
 * anything. That order is the point: a caller without the grant gets 403 rather
 * than 400 on a malformed body. A handler-side check cannot deliver that,
 * because the route decodes the body first. The check in the service method
 * stays as well; it is what binds in-process callers.
 *
 * The required grant is a static per-operation fact, so this is not operation
 * logic living in a handler: the middleware reads the contract's operation
 * table by joining the group and endpoint identifiers with a dot, which is the
 * operation id exactly, and one contract test keeps the join honest.
 *
 * `SetupToken` accepts the one-time setup token and nothing else.
 *
 * A repository failure inside a gate is a defect rather than a failure: the
 * middleware's declared errors are the two the contract names, and a database
 * that will not answer is not something the caller can act on. The envelope
 * wrapper turns it into a logged 500.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  Authenticated,
  createUnauthenticatedError,
  isOperationId,
  SetupToken,
  type OperationId,
} from "@hercule/contract";
import { CurrentActor, checkGrant, NO_CREDENTIAL, type Actor } from "../actor";
import { Credentials, hashToken } from "../credentials";
import { SessionTokens } from "../permissions";
import { Setup } from "../setup";

/** The operation a request is for: the group and endpoint identifiers, joined. */
export const buildOperationId = (options: {
  readonly group: HttpApiGroup.Top;
  readonly endpoint: HttpApiEndpoint.Top;
}): string => `${options.group.identifier}.${options.endpoint.identifier}`;

/**
 * The operation a route is, as the contract's table names it. An endpoint the
 * table does not name cannot happen - the contract test asserts the declaration
 * and the table are one-to-one - so it is a defect rather than an error with a
 * response.
 */
const parseOperationId = (id: string): Effect.Effect<OperationId> =>
  isOperationId(id)
    ? Effect.succeed(id)
    : Effect.die(`no operation named ${id} in the contract's table`);

/**
 * The live credential behind a presented token, whichever kind it is, with its
 * use recorded: a login bearer's 30-day window rolls forward and an API key's
 * `last_used_at` is stamped. The repository decides whether that use is worth
 * a write; on a busy connection most are not.
 *
 * A session's own token is tried first, because it is the one that is cached:
 * an agent - the chatty population, calling on every tool use - costs one
 * cached lookup rather than two indexed misses ahead of it, while a user pays
 * one cache miss before the lookup a human is waiting on.
 */
const resolveActor = (
  credentials: Credentials["Service"],
  sessions: SessionTokens["Service"],
  token: string,
): Effect.Effect<Option.Option<Actor>> =>
  Effect.gen(function* () {
    const tokenHash = hashToken(token);

    const session = yield* sessions.resolve(tokenHash);
    if (Option.isSome(session)) return session;

    const login = yield* credentials.findLoginToken(tokenHash);
    if (Option.isSome(login)) {
      yield* credentials.renewLoginToken(login.value);
      return Option.some<Actor>({
        _tag: "user",
        userId: login.value.userId,
        credential: { kind: "login", id: login.value.id, tokenHash },
      });
    }

    const apiKey = yield* credentials.findApiKey(tokenHash);
    if (Option.isSome(apiKey)) {
      yield* credentials.touchApiKey(apiKey.value);
      return Option.some<Actor>({
        _tag: "user",
        userId: apiKey.value.userId,
        credential: { kind: "apiKey", id: apiKey.value.id, tokenHash },
      });
    }

    return Option.none();
  }).pipe(Effect.orDie);

/** Any credential of any kind, plus the operation's static grant check. */
export const AuthenticatedLayer: Layer.Layer<Authenticated, never, Credentials | SessionTokens> =
  Layer.effect(Authenticated)(
    Effect.gen(function* () {
      const credentials = yield* Credentials;
      const sessions = yield* SessionTokens;
      return {
        bearer: (httpEffect, options) =>
          Effect.gen(function* () {
            const token = Redacted.value(options.credential);
            if (token === "") return yield* Effect.fail(createUnauthenticatedError(NO_CREDENTIAL));

            const actor = yield* resolveActor(credentials, sessions, token);
            if (Option.isNone(actor))
              return yield* Effect.fail(createUnauthenticatedError(NO_CREDENTIAL));

            const operation = yield* parseOperationId(buildOperationId(options));
            const refused = checkGrant(operation, actor.value);
            if (refused !== undefined) return yield* Effect.fail(refused);

            return yield* Effect.provideService(httpEffect, CurrentActor, actor.value);
          }),
      };
    }),
  );

/** The one-time setup token, matched against the hash the boot wrote. */
export const SetupTokenLayer: Layer.Layer<SetupToken, never, Setup> = Layer.effect(SetupToken)(
  Effect.gen(function* () {
    const setup = yield* Setup;
    return {
      bearer: (httpEffect, options) =>
        Effect.gen(function* () {
          const token = Redacted.value(options.credential);
          const accepted = token !== "" && (yield* Effect.orDie(setup.matchesToken(token)));
          if (!accepted)
            return yield* Effect.fail(createUnauthenticatedError("the setup token is not valid"));
          return yield* httpEffect;
        }),
    };
  }),
);

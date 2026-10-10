/**
 * Implements the contract's two credential middlewares.
 *
 * `Authenticated` resolves the bearer token to an actor, then runs the
 * operation's static grant check, both before the derived route decodes
 * anything. That order matters: a caller without the grant gets 403 rather
 * than 400 for a malformed body. A check in the handler could not do that,
 * because the route decodes the body first. The service method still checks
 * the grant too, so in-process callers are checked as well.
 *
 * The required grant is fixed per operation, so this is not operation logic
 * in a handler. The middleware looks the operation up in the contract's
 * operation table by joining the group and endpoint identifiers with a dot,
 * which gives exactly the operation id. A contract test checks that the join
 * matches.
 *
 * `SetupToken` accepts the one-time setup token and nothing else.
 *
 * A repository failure inside a middleware is a defect rather than a failure:
 * the middleware can only fail with the errors the contract declares for it,
 * and a database error is nothing the caller can act on. The envelope turns
 * the defect into a logged 500.
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
import { PromotionState } from "../promotion";
import { Setup } from "../setup";

/** Builds the operation id of a request by joining the group and endpoint identifiers. */
export const buildOperationId = (options: {
  readonly group: HttpApiGroup.Top;
  readonly endpoint: HttpApiEndpoint.Top;
}): string => `${options.group.identifier}.${options.endpoint.identifier}`;

/**
 * Checks that `id` is an operation in the contract's table, and returns it
 * typed. Dies otherwise: a contract test checks that the API declaration and
 * the table match one to one, so an unknown id is a bug, not an error to
 * return to the caller.
 */
const parseOperationId = (id: string): Effect.Effect<OperationId> =>
  isOperationId(id)
    ? Effect.succeed(id)
    : Effect.die(`no operation named ${id} in the contract's table`);

/**
 * Resolves a token to its actor, whatever kind of credential it is, or
 * returns `none`. Records the use: a login token's 30-day window moves
 * forward, and an API key's `last_used_at` is updated. The repository decides
 * whether a use is worth a write; on a busy connection most are not.
 *
 * The use is recorded only while the controller is serving. A request that
 * only reads still runs while a promotion freezes the controller, and the
 * database then refuses every write. Skipping the record loses nothing that
 * matters: the copy the new machine receives holds the older values, and
 * this controller then agrees with it.
 *
 * Session tokens are tried first, because they are cached. Agents call the
 * API on every tool use, so they cost one cached lookup instead of two
 * database misses first. A user pays one cache miss, which a person does not
 * notice.
 */
const resolveActor = (
  credentials: Credentials["Service"],
  sessions: SessionTokens["Service"],
  promotion: PromotionState["Service"],
  token: string,
): Effect.Effect<Option.Option<Actor>> =>
  Effect.gen(function* () {
    const tokenHash = hashToken(token);

    const session = yield* sessions.resolve(tokenHash);
    if (Option.isSome(session)) return session;

    const login = yield* credentials.findLoginToken(tokenHash);
    if (Option.isSome(login)) {
      yield* promotion.runIfServing(credentials.renewLoginToken(login.value));
      return Option.some<Actor>({
        _tag: "user",
        userId: login.value.userId,
        credential: { kind: "login", id: login.value.id, tokenHash },
      });
    }

    const apiKey = yield* credentials.findApiKey(tokenHash);
    if (Option.isSome(apiKey)) {
      yield* promotion.runIfServing(credentials.touchApiKey(apiKey.value));
      return Option.some<Actor>({
        _tag: "user",
        userId: apiKey.value.userId,
        credential: { kind: "apiKey", id: apiKey.value.id, tokenHash },
      });
    }

    return Option.none();
  }).pipe(Effect.orDie);

/** Accepts a credential of any kind, then runs the operation's static grant check. */
export const AuthenticatedLayer: Layer.Layer<
  Authenticated,
  never,
  Credentials | SessionTokens | PromotionState
> = Layer.effect(Authenticated)(
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const sessions = yield* SessionTokens;
    const promotion = yield* PromotionState;
    return {
      bearer: (httpEffect, options) =>
        Effect.gen(function* () {
          const operation = yield* parseOperationId(buildOperationId(options));

          const token = Redacted.value(options.credential);
          if (token === "") return yield* Effect.fail(createUnauthenticatedError(NO_CREDENTIAL));

          const actor = yield* resolveActor(credentials, sessions, promotion, token);
          if (Option.isNone(actor))
            return yield* Effect.fail(createUnauthenticatedError(NO_CREDENTIAL));

          const refused = checkGrant(operation, actor.value);
          if (refused !== undefined) return yield* Effect.fail(refused);

          return yield* Effect.provideService(httpEffect, CurrentActor, actor.value);
        }),
    };
  }),
);

/** Accepts only the one-time setup token, compared with the hash written at boot. */
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

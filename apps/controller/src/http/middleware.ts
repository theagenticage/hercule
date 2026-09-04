/**
 * The two credential gates, implemented (spec 11 sections 1.5 and 5, spec 13
 * sections 4 and 6.3).
 *
 * `Authenticated` resolves the bearer token to an actor and then runs the
 * static grant check for the operation, both before the derived route decodes
 * anything. That order is the point: a caller without the grant gets 403 rather
 * than 400 on a malformed body, which is what spec 11 section 1.5 requires and
 * what a handler-side check cannot deliver. The check in the service method
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
  forbidden,
  isOperationId,
  OPERATIONS,
  SetupToken,
  unauthenticated,
  type Grant,
  type Requirement,
} from "@hydra/contract";
import { CurrentActor, type Actor } from "../actor";
import { Credentials, hashToken } from "../credentials";
import { Setup } from "../setup";

/** What a caller with no usable credential is told; never why (spec 13 section 4). */
const NO_CREDENTIAL = "this operation needs a credential";

/** The operation a request is for: the group and endpoint identifiers, joined. */
export const operationIdOf = (options: {
  readonly group: HttpApiGroup.Top;
  readonly endpoint: HttpApiEndpoint.Top;
}): string => `${options.group.identifier}.${options.endpoint.identifier}`;

/**
 * Whether this actor may reach an operation with this requirement.
 *
 * The user actor has full parity: no profile applies, so it passes every grant
 * (spec 13 section 6.3). Session actors are checked against their profile and
 * run and plugin actors are ungated - neither exists yet, and both are a branch
 * here rather than a rewrite when they do.
 */
export const grantCheck = (requirement: Requirement, actor: Actor): Grant | undefined => {
  switch (requirement) {
    case "unauthenticated":
    case "setup-token":
    case "authenticated":
      return undefined;
    default:
      return actor._tag === "user" ? undefined : requirement;
  }
};

/**
 * The requirement for one operation. An endpoint the table does not name cannot
 * happen - the contract test asserts the declaration and the table are
 * one-to-one - so it is a defect rather than an error with a response.
 */
const requirementFor = (id: string): Effect.Effect<Requirement> =>
  isOperationId(id)
    ? Effect.succeed(OPERATIONS[id].requires)
    : Effect.die(`no operation named ${id} in the contract's table`);

/**
 * The live credential behind a presented token, whichever kind it is, with its
 * use recorded: a login bearer's 30-day window rolls forward and an API key's
 * `last_used_at` is stamped (spec 13 sections 4.2 and 4.3).
 */
const resolve = (
  credentials: Credentials["Service"],
  token: string,
): Effect.Effect<Option.Option<Actor>> =>
  Effect.gen(function* () {
    const tokenHash = hashToken(token);

    const login = yield* credentials.findLoginToken(tokenHash);
    if (Option.isSome(login)) {
      yield* credentials.renewLoginToken(login.value.id);
      return Option.some<Actor>({
        _tag: "user",
        userId: login.value.userId,
        credential: { kind: "login", id: login.value.id, tokenHash },
      });
    }

    const apiKey = yield* credentials.findApiKey(tokenHash);
    if (Option.isSome(apiKey)) {
      yield* credentials.touchApiKey(apiKey.value.id);
      return Option.some<Actor>({
        _tag: "user",
        userId: apiKey.value.userId,
        credential: { kind: "apiKey", id: apiKey.value.id, tokenHash },
      });
    }

    return Option.none();
  }).pipe(Effect.orDie);

/** Any credential of any kind, plus the operation's static grant check. */
export const AuthenticatedLayer: Layer.Layer<Authenticated, never, Credentials> = Layer.effect(
  Authenticated,
)(
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    return {
      bearer: (httpEffect, options) =>
        Effect.gen(function* () {
          const token = Redacted.value(options.credential);
          if (token === "") return yield* Effect.fail(unauthenticated(NO_CREDENTIAL));

          const actor = yield* resolve(credentials, token);
          if (Option.isNone(actor)) return yield* Effect.fail(unauthenticated(NO_CREDENTIAL));

          const requirement = yield* requirementFor(operationIdOf(options));
          const missing = grantCheck(requirement, actor.value);
          if (missing !== undefined) return yield* Effect.fail(forbidden(missing));

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
          if (!accepted) return yield* Effect.fail(unauthenticated("the setup token is not valid"));
          return yield* httpEffect;
        }),
    };
  }),
);

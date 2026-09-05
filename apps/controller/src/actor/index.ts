/**
 * Who is making the current request.
 *
 * The transport resolves the presented credential once and puts the result
 * here; service methods read it rather than taking it as a parameter, so a
 * signature never carries request context and an in-process caller provides the
 * same reference. It is a `Context.Reference` with a default, which keeps
 * `CurrentActor` out of every handler's requirement type.
 *
 * v1 authenticates one population: the user, through a login bearer token or an
 * API key. Session, run and plugin actors will widen this union later; nothing
 * here is restructured when they do.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  forbidden,
  OPERATIONS,
  unauthenticated,
  type Forbidden,
  type Grant,
  type OperationId,
  type Requirement,
  type Unauthenticated,
} from "@hydra/contract";

/** What a caller with no usable credential is told; never why. */
export const NO_CREDENTIAL = "this operation needs a credential";

/** Which user credential was presented, and the hash that resolved it. */
export interface PresentedCredential {
  readonly kind: "login" | "apiKey";
  /** The credential row's id, for stamping and revocation. */
  readonly id: string;
  /** The SHA-256 hash the token resolved through; the plaintext is not kept. */
  readonly tokenHash: string;
}

/** The user actor: full parity with the API, no profile applies. */
export interface UserActor {
  readonly _tag: "user";
  readonly userId: string;
  readonly credential: PresentedCredential;
}

/** Nobody has been resolved: an unauthenticated route, or an in-process caller. */
export interface NoActor {
  readonly _tag: "none";
}

export type Actor = UserActor | NoActor;

const NONE: NoActor = { _tag: "none" };

/** The actor behind the current request. Request-scoped, defaulting to nobody. */
export const CurrentActor = Context.Reference<Actor>("hydra/controller/actor/CurrentActor", {
  defaultValue: () => NONE,
});

/**
 * How a mutation by the user is stamped in the event log.
 * The user is the bare word; which credential it presented is not part of its
 * identity, and the other actor kinds carry their id (`session:<id>`).
 */
export const USER_ACTOR = "user";

/**
 * How a mutation Hydra made on nobody's behalf is stamped. Enlisting a machine
 * that presented a join token, and everything that machine reports about itself
 * afterwards, are changes with no credential behind them and still have to say
 * who made them.
 *
 * It is a stamp and never an actor: nothing carrying it reaches an operation,
 * so `grantCheck` never sees it and the union above gains no member.
 */
export const SYSTEM_ACTOR = "system";

/**
 * Whether this actor may reach an operation with this requirement, and which
 * grant it is missing if it may not.
 *
 * The user actor has full parity: no profile applies, so it passes every grant.
 * Session actors are checked against their profile and run and plugin actors are
 * ungated - neither exists yet, and both are a branch here rather than a rewrite
 * when they do.
 *
 * The transport middleware runs this before the payload is decoded and the
 * service method runs it again for in-process callers, which is why it lives
 * beside the actor rather than inside either.
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
 * The static grant check as a service method runs it: enforcement lives inside
 * the method, not in the handler. Answers with the current actor, which is
 * what the method stamps its mutation with.
 *
 * v1 authenticates one population, so an in-process caller with no actor is
 * told it needs a credential rather than acting as somebody.
 */
export const requireGrant = (id: OperationId): Effect.Effect<Actor, Forbidden> =>
  Effect.flatMap(CurrentActor, (actor) => {
    const missing = grantCheck(OPERATIONS[id].requires, actor);
    return missing === undefined ? Effect.succeed(actor) : Effect.fail(forbidden(missing));
  });

/**
 * The same check for an operation that acts on the caller's own rows, and so
 * needs a user rather than an actor of any kind.
 */
export const currentUser = (
  id: OperationId,
): Effect.Effect<UserActor, Forbidden | Unauthenticated> =>
  Effect.flatMap(requireGrant(id), (actor) =>
    actor._tag === "user" ? Effect.succeed(actor) : Effect.fail(unauthenticated(NO_CREDENTIAL)),
  );

/**
 * Who is making the current request.
 *
 * The transport resolves the presented credential once and puts the result
 * here; service methods read it rather than taking it as a parameter, so a
 * signature never carries request context and an in-process caller provides the
 * same reference. It is a `Context.Reference` with a default, which keeps
 * `CurrentActor` out of every handler's requirement type.
 *
 * v1 authenticates two populations: the user, through a login bearer token or
 * an API key, and a session, through the token the controller minted for it.
 * Run and plugin actors will widen this union later; nothing here is
 * restructured when they do.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  createForbiddenError,
  createUnauthenticatedError,
  OPERATIONS,
  type Forbidden,
  type Grant,
  type OperationId,
  type Requirement,
  type Unauthenticated,
} from "@hercule/contract";

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

/**
 * An agent inside a session, calling on the token the controller minted for it.
 *
 * The grants are the session's permission profile as it stood when the token
 * was resolved, carried here rather than looked up again: the check runs before
 * the body is decoded and on every call, and a second read per request would be
 * a join on the request path for a set that changes only when the user edits
 * the profile.
 */
export interface SessionActor {
  readonly _tag: "session";
  readonly sessionId: string;
  readonly profileId: string;
  readonly grants: ReadonlyArray<Grant>;
}

/** Nobody has been resolved: an unauthenticated route, or an in-process caller. */
export interface NoActor {
  readonly _tag: "none";
}

export type Actor = UserActor | SessionActor | NoActor;

const NONE: NoActor = { _tag: "none" };

/** The actor behind the current request. Request-scoped, defaulting to nobody. */
export const CurrentActor = Context.Reference<Actor>("hercule/controller/actor/CurrentActor", {
  defaultValue: () => NONE,
});

/**
 * How a mutation by the user is stamped in the event log.
 * The user is the bare word; which credential it presented is not part of its
 * identity, and the other actor kinds carry their id (`session:<id>`).
 */
export const USER_ACTOR = "user";

/**
 * How a mutation Hercule made on nobody's behalf is stamped. Enlisting a machine
 * that presented a join token, and everything that machine reports about itself
 * afterwards, are changes with no credential behind them and still have to say
 * who made them.
 *
 * It is a stamp and never an actor: nothing carrying it reaches an operation,
 * so `grantCheck` never sees it and the union above gains no member.
 */
export const SYSTEM_ACTOR = "system";

/**
 * How an actor is stamped on what it changes: the session's own id for a
 * session, which is what a reader of the event log or of a task's provenance
 * follows back to the conversation that made the change, and the bare word for
 * the user.
 *
 * Nobody has no stamp, which is why it is not in the parameter: an operation
 * that mutates anything names a grant, and `requireGrant` refuses an actorless
 * caller that grant, so the only two that reach a write through a request are
 * the user and a session. A write with no request behind it names
 * `SYSTEM_ACTOR` for itself, explicitly, rather than passing nobody here.
 */
export const stampOf = (actor: UserActor | SessionActor): string =>
  actor._tag === "session" ? `session:${actor.sessionId}` : USER_ACTOR;

/**
 * How the actor behind the current request is stamped on what it changes. The
 * one place a mutation's `actor` comes from, so no service decides it.
 *
 * An actorless caller here is a defect, not a failure: it means a write reached
 * stamping without the grant check that would have refused it, and stamping it
 * as the user would attribute the change to a person who made no request.
 */
export const currentStamp: Effect.Effect<string> = Effect.flatMap(CurrentActor, (actor) =>
  actor._tag === "none"
    ? Effect.die("a write reached stamping with no authenticated actor behind it")
    : Effect.succeed(stampOf(actor)),
);

/**
 * The grant an operation names, or `undefined` where its requirement is not a
 * grant at all.
 */
const grantOf = (requirement: Requirement): Grant | undefined => {
  switch (requirement) {
    case "unauthenticated":
    case "setup-token":
    case "authenticated":
      return undefined;
    default:
      return requirement;
  }
};

/**
 * Whether this actor may reach this operation, and the refusal to answer with
 * if it may not.
 *
 * The user actor has full parity: no profile applies, so it passes every grant.
 * A session passes exactly the grants its permission profile holds. Run and
 * plugin actors are ungated - neither exists yet, and both are a branch here
 * rather than a rewrite when they do.
 *
 * It answers with the whole refusal and not with the missing grant, so that a
 * caller is told what it lacks. It takes the operation and not the
 * operation's requirement, so that an operation with a rule of its own can be
 * told apart here.
 *
 * `session.spawn` has three such rules. All three are enforced in
 * `daemon/placement.ts` and not here, because each of them needs the decoded
 * payload, and this check runs before the decode. First: a spawn from an Agent
 * is open to every actor that holds the grant, a Thread is the user's own, and
 * the payload says which of the two the call asks for. Second: a session actor
 * may spawn only from an Agent whose permission profile grants nothing beyond
 * its own. Third: a session actor may spawn only at or below the access mode
 * the Agent names. The second rule and the third rule both need the Agent row
 * to be read first.
 */
export const grantCheck = (id: OperationId, actor: Actor): Forbidden | undefined => {
  const grant = grantOf(OPERATIONS[id].requires);
  if (grant === undefined) return undefined;
  switch (actor._tag) {
    case "user":
      return undefined;
    case "session":
      return actor.grants.includes(grant) ? undefined : createForbiddenError(grant);
    case "none":
      return createForbiddenError(grant);
  }
};

/**
 * The static grant check as a service method runs it: enforcement lives inside
 * the method, not in the handler. Answers with the current actor, which is
 * what the method stamps its mutation with.
 */
export const requireGrant = (id: OperationId): Effect.Effect<Actor, Forbidden> =>
  Effect.flatMap(CurrentActor, (actor) => {
    const refused = grantCheck(id, actor);
    return refused === undefined ? Effect.succeed(actor) : Effect.fail(refused);
  });

/**
 * Why an operation the caller holds the grant for is still the user's alone.
 * The grant on the refusal is the one the operation names, so the message has
 * to say that widening the profile is not the answer.
 */
const USER_ONLY = "only the user may make this call; no grant confers it";

/**
 * The same check for an operation that acts on the caller's own rows, and so
 * needs a user rather than an actor of any kind.
 *
 * A session that holds the grant is refused with it: the credential is good and
 * the profile allows the family, so the answer is 403 naming what was asked
 * for, never the 401 that would tell an agent its token had died. The 401 is
 * for an actorless caller, because nobody was resolved at all - which only
 * happens where the operation's requirement is `authenticated` rather than a
 * grant, since `requireGrant` refuses nobody a grant first.
 */
export const currentUser = (
  id: OperationId,
): Effect.Effect<UserActor, Forbidden | Unauthenticated> =>
  Effect.flatMap(requireGrant(id), (actor) => {
    if (actor._tag === "user") return Effect.succeed(actor);
    const grant = grantOf(OPERATIONS[id].requires);
    return Effect.fail(
      actor._tag === "session" && grant !== undefined
        ? createForbiddenError(grant, USER_ONLY)
        : createUnauthenticatedError(NO_CREDENTIAL),
    );
  });

/**
 * Who is making the current request.
 *
 * The transport resolves the presented credential once and stores the result
 * here. Service methods read it rather than taking it as a parameter, so no
 * signature carries request context, and an in-process caller provides the
 * same reference. It is a `Context.Reference` with a default, which keeps
 * `CurrentActor` out of every handler's requirement type.
 *
 * v1 authenticates two kinds of caller: the user, through a login bearer token
 * or an API key, and a session, through the token the controller created for
 * it. A third kind never arrives over the transport: the run engine calls the
 * services as a run while one of the run's action steps executes. Plugin
 * actors will be added to this union later, without restructuring anything
 * here.
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

/** The error message for a caller with no usable credential. It never says why. */
export const NO_CREDENTIAL = "this operation needs a credential";

/** Which user credential was presented, and the hash it was looked up by. */
export interface PresentedCredential {
  readonly kind: "login" | "apiKey";
  /** The credential row's id, for stamping and revocation. */
  readonly id: string;
  /** The SHA-256 hash the token was looked up by; the plaintext is not kept. */
  readonly tokenHash: string;
}

/** The user actor: may call every operation, and no profile applies. */
export interface UserActor {
  readonly _tag: "user";
  readonly userId: string;
  readonly credential: PresentedCredential;
}

/**
 * An agent inside a session, calling with the token the controller created for
 * it.
 *
 * The grants are those of the session's permission profile at the time the
 * token was resolved, stored here rather than looked up again. The check runs
 * on every call, before the body is decoded, and a second read per request
 * would add a join to every request for a set that changes only when the user
 * edits the profile.
 */
export interface SessionActor {
  readonly _tag: "session";
  readonly sessionId: string;
  readonly profileId: string;
  readonly grants: ReadonlyArray<Grant>;
}

/**
 * A run, while one of its built-in action steps executes. The step calls the
 * same service method its operation does, as this actor.
 *
 * A run passes every grant check, because the user gave the workflow its
 * steps by saving it, and the steps only do what the user could do. The
 * grants of whoever started the run do not apply to its steps.
 */
export interface RunActor {
  readonly _tag: "run";
  readonly runId: string;
  /** The step that is executing, for code that records which step made a change. */
  readonly stepId: string;
}

/** No caller was resolved: an unauthenticated route, or an in-process caller. */
export interface NoActor {
  readonly _tag: "none";
}

export type Actor = UserActor | SessionActor | RunActor | NoActor;

const NONE: NoActor = { _tag: "none" };

/** The actor behind the current request. Scoped to the request; defaults to no actor. */
export const CurrentActor = Context.Reference<Actor>("hercule/controller/actor/CurrentActor", {
  defaultValue: () => NONE,
});

/**
 * The actor stamp for a mutation by the user. The user is stamped as the bare
 * word, because the credential it presented is not part of its identity. The
 * other actor kinds include their id (`session:<id>`).
 */
export const USER_ACTOR = "user";

/**
 * The actor stamp for a mutation the controller made on nobody's behalf.
 * Enlisting a machine that presented a join token, and everything that machine
 * reports about itself afterwards, are changes with no credential behind them,
 * but they still need an actor stamp.
 *
 * It is only a stamp, never an actor: no request carries it into an operation,
 * so `checkGrant` never sees it and the `Actor` union has no member for it.
 */
export const SYSTEM_ACTOR = "system";

/**
 * Returns the actor stamp of the session with this id, `session:<id>`. A write
 * the session caused without a request of its own, such as the reply taken
 * from its turn, is stamped with it.
 */
export const buildSessionStamp = (sessionId: string): string => `session:${sessionId}`;

/**
 * Returns the actor stamp for an actor: `session:<id>` for a session,
 * `run:<id>` for a run, and the bare word `user` for the user. The id lets a
 * reader of the event log or of a task's provenance trace a change back to the
 * session or run that made it.
 *
 * `NoActor` has no stamp, which is why the parameter type leaves it out. Every
 * operation that mutates anything requires a grant, and `requireGrant` rejects
 * a caller with no actor, so only an actor with an identity can reach a write.
 * A write with no request behind it uses `SYSTEM_ACTOR` explicitly instead of
 * calling this function.
 */
export const buildActorStamp = (actor: UserActor | SessionActor | RunActor): string => {
  switch (actor._tag) {
    case "user":
      return USER_ACTOR;
    case "session":
      return buildSessionStamp(actor.sessionId);
    case "run":
      return `run:${actor.runId}`;
  }
};

/**
 * Returns the actor stamp for the actor behind the current request. This is
 * the only place a mutation's `actor` comes from, so no service decides it.
 *
 * Dies when there is no actor, because that is a bug, not a failure: a write
 * reached this point without the grant check that would have rejected it.
 * Stamping it as the user would attribute the change to a person who made no
 * request.
 */
export const currentStamp: Effect.Effect<string> = Effect.flatMap(CurrentActor, (actor) =>
  actor._tag === "none"
    ? Effect.die("a write reached stamping with no authenticated actor behind it")
    : Effect.succeed(buildActorStamp(actor)),
);

/**
 * Returns the actor stamp for the actor behind the current request, or
 * `SYSTEM_ACTOR` when there is none.
 *
 * Use it only for a write that may legitimately run with no request behind
 * it, such as work started by a runner's report or by boot. A write that only
 * an operation can reach uses `currentStamp`, which treats a missing actor as
 * a bug.
 */
export const currentStampOrSystem: Effect.Effect<string> = Effect.map(CurrentActor, (actor) =>
  actor._tag === "none" ? SYSTEM_ACTOR : buildActorStamp(actor),
);

/**
 * Returns the grant an operation requires, or `undefined` when its requirement
 * is not a grant.
 */
const findRequiredGrant = (requirement: Requirement): Grant | undefined => {
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
 * Checks whether an actor may call an operation. Returns `undefined` when it
 * may, and the `Forbidden` error to fail with when it may not.
 *
 * The user actor passes every grant, because no profile applies to it, and so
 * does a run, which acts for the user (see `RunActor`). A session passes
 * exactly the grants its permission profile holds. Plugin actors do not exist
 * yet; they will be one more case here.
 *
 * It returns the whole error rather than only the missing grant, so the caller
 * is told what it lacks. It takes the operation rather than the operation's
 * requirement, so an operation with a rule of its own can be recognised here.
 *
 * `session.spawn` has three such rules. All three are enforced in
 * `daemon/sessions/placement.ts` and not here, because each needs the decoded payload,
 * and this check runs before the decode:
 *
 * - any actor that holds the grant may spawn from an Agent, but only the user
 *   may start a Thread, and the payload decides which one the call is;
 * - a session actor may spawn only from an Agent whose permission profile
 *   grants nothing beyond its own;
 * - a session actor may spawn only at or below the Agent's access mode.
 *
 * The second and third rules both need the Agent row to be read first.
 */
export const checkGrant = (id: OperationId, actor: Actor): Forbidden | undefined => {
  const grant = findRequiredGrant(OPERATIONS[id].requires);
  if (grant === undefined) return undefined;
  switch (actor._tag) {
    case "user":
    case "run":
      return undefined;
    case "session":
      return actor.grants.includes(grant) ? undefined : createForbiddenError(grant);
    case "none":
      return createForbiddenError(grant);
  }
};

/**
 * Runs the grant check for an operation inside a service method, because
 * enforcement lives in the method, not in the handler. Returns the current
 * actor, which the method stamps its mutation with. Fails with `Forbidden`
 * when the actor lacks the grant.
 */
export const requireGrant = (id: OperationId): Effect.Effect<Actor, Forbidden> =>
  Effect.flatMap(CurrentActor, (actor) => {
    const refused = checkGrant(id, actor);
    return refused === undefined ? Effect.succeed(actor) : Effect.fail(refused);
  });

/**
 * The error message for a session that holds the grant for an operation only
 * the user may call. The `Forbidden` error includes the operation's grant, so
 * the message has to say that widening the profile will not help.
 */
const USER_ONLY = "only the user may make this call; no grant confers it";

/**
 * Runs the grant check for an operation that acts on the caller's own rows,
 * and so needs the user rather than any actor. Returns the user actor.
 *
 * Fails with:
 *
 * - `Forbidden` (403) for a session or a run, even one that holds the grant.
 *   The credential is valid and the profile allows the grant, so the error
 *   must not be a 401, which would tell an agent its token had expired.
 * - `Unauthenticated` (401) for a caller with no actor. That only happens
 *   when the operation's requirement is `authenticated` rather than a grant,
 *   because otherwise `requireGrant` has already rejected the caller.
 */
export const requireUserActor = (
  id: OperationId,
): Effect.Effect<UserActor, Forbidden | Unauthenticated> =>
  Effect.flatMap(requireGrant(id), (actor) => {
    if (actor._tag === "user") return Effect.succeed(actor);
    const grant = findRequiredGrant(OPERATIONS[id].requires);
    return Effect.fail(
      actor._tag !== "none" && grant !== undefined
        ? createForbiddenError(grant, USER_ONLY)
        : createUnauthenticatedError(NO_CREDENTIAL),
    );
  });

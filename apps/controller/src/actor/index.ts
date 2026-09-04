/**
 * Who is making the current request (spec 11 sections 1.1 and 3.1).
 *
 * The transport resolves the presented credential once and puts the result
 * here; service methods read it rather than taking it as a parameter, so a
 * signature never carries request context and an in-process caller provides the
 * same reference. It is a `Context.Reference` with a default, which keeps
 * `CurrentActor` out of every handler's requirement type.
 *
 * v1 authenticates one population: the user, through a login bearer token or an
 * API key (spec 13 section 4). Session, run and plugin actors arrive with their
 * tickets and widen this union; nothing here is restructured when they do.
 */
import * as Context from "effect/Context";

/** Which user credential was presented, and the hash that resolved it. */
export interface PresentedCredential {
  readonly kind: "login" | "apiKey";
  /** The credential row's id, for stamping and revocation. */
  readonly id: string;
  /** The SHA-256 hash the token resolved through; the plaintext is not kept. */
  readonly tokenHash: string;
}

/** The user actor: full parity with the API, no profile applies (spec 13 section 6.3). */
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
 * How a mutation by the user is stamped in the event log (spec 11 section 3.1).
 * The user is the bare word; which credential it presented is not part of its
 * identity, and the other actor kinds carry their id (`session:<id>`).
 */
export const USER_ACTOR = "user";

/**
 * Subscriptions as the API sees them: `subscription.create`, `query` and
 * `cancel`.
 *
 * A subscription is held by the session that registered it. The holder is
 * taken from the credential and never from the payload, so an agent cannot
 * make another session wait on something, and a user credential - which is
 * nobody's session - cannot register one at all.
 *
 * What is stored is the target as it was written and the condition it expands
 * into. The condition is checked before it is stored, because a condition the
 * evaluator refuses is a subscription that could never match and would say so
 * only from inside the event router, long after the caller had gone.
 *
 * A listing answers live subscriptions only: it is read to see what a session
 * is still waiting for, and to find the id to cancel.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DEFAULT_PAGE_LIMIT,
  Id,
  SUBSCRIPTION_SORT_FIELDS,
  SubscriptionCreateInput,
  SubscriptionHolder,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type SortDirection,
  type Subscription,
  type SubscriptionHealth,
  type SubscriptionTarget,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { checkExpression } from "../expressions";
import { expandTarget } from "./targets";
import { subscriptionRepository, type StoredSubscription } from "./repository";

const QueryInput = Schema.Struct({
  holder: Schema.optionalKey(SubscriptionHolder),
  ...pageInput(SUBSCRIPTION_SORT_FIELDS),
});

type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const Identified = Schema.Struct({ id: Id });

type Identified = Schema.Schema.Type<typeof Identified>;

const decodeCreate = Schema.decodeUnknownEffect(SubscriptionCreateInput);
const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

interface SubscriptionPage {
  readonly items: ReadonlyArray<Subscription>;
  readonly nextCursor?: string;
}

/** Newest first, as every other listing of what has been set up is read. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** What ends a subscription the holder asked to end. */
const CANCELLED = "cancelled";

/**
 * Why a subscription ended with the session that held it. The session is named
 * because a holder reading the row has several sessions and needs to know
 * which one this claim belonged to.
 *
 * It ends the inputs that subscription produced as well as the subscription
 * itself, so both rows carry one sentence and a reader never has to join them.
 */
export const buildHolderEndedReason = (sessionId: string): string =>
  `session ${sessionId}, which held this subscription, has exited and its transcript ` +
  `cannot be picked up again`;

/** Why a target this version cannot wait on is refused, one message per kind. */
const ABSENT_TARGET_REASON: Record<Exclude<SubscriptionTarget["kind"], "ref">, string> = {
  run: "no runs exist yet, so there is no run to wait on; wait on an External Ref instead",
  session:
    "no session.* platform events are emitted yet, so a session target would never match; " +
    "wait on an External Ref instead",
  request:
    "no Permission Requests exist yet, so there is no decision to wait for; " +
    "wait on an External Ref instead",
};

/**
 * Why a credential that is nobody's session cannot register one, and why a
 * user credential listing subscriptions has to say whose.
 *
 * Each is two sentences and not one: the refusal carries a line of its own and
 * a line on the field, and a reader shown the same sentence twice reads it
 * twice to find out what is different about it.
 */
const NEEDS_A_SESSION = "a subscription needs a session holder";

const NEEDS_A_SESSION_REPAIR =
  "a subscription is held by the session that registers it, and a user credential is no session; " +
  "call this with a session token";

const NEEDS_A_HOLDER = "a subscription listing needs a holder";

const NEEDS_A_HOLDER_REPAIR =
  "a user credential holds no subscriptions of its own; name whose to list, as holder=session:<id>";

const NO_SUCH_SUBSCRIPTION = "no live subscription has that id";

/** How a stored row reads as health: no evaluation error recorded is `ok`. */
const readHealth = (stored: StoredSubscription): SubscriptionHealth =>
  stored.healthErrorMessage === null || stored.healthErrorAt === null
    ? { state: "ok" }
    : { state: "error", message: stored.healthErrorMessage, at: stored.healthErrorAt };

/** The wake-up a restart cancelled, or null where none stands. */
const readLostWakeUp = (stored: StoredSubscription): Subscription["lostWakeUp"] =>
  stored.lostWakeUpEventId === null || stored.lostWakeUpAt === null
    ? null
    : { eventId: stored.lostWakeUpEventId, at: stored.lostWakeUpAt };

const composeRecord = (stored: StoredSubscription): Subscription => ({
  id: stored.id,
  target: stored.target,
  condition: stored.condition,
  holder: stored.holder,
  health: readHealth(stored),
  lostWakeUp: readLostWakeUp(stored),
  createdAt: stored.createdAt,
});

/** How every call here can fail before it reaches what it was asked to do. */
type CommonError = Unauthenticated | Forbidden | Validation | SqlError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const subscriptions = yield* subscriptionRepository;

  return {
    /** Registers what this session waits on, and answers which subscription that is. */
    create: (
      input: SubscriptionCreateInput,
    ): Effect.Effect<{ readonly subscriptionId: string }, CommonError | InvalidState> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("subscription.create");
        const { target } = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        if (actor._tag !== "session") {
          return yield* Effect.fail(
            createValidationError(
              [{ path: ["holder"], message: NEEDS_A_SESSION_REPAIR }],
              NEEDS_A_SESSION,
            ),
          );
        }
        if (target.kind !== "ref") {
          return yield* Effect.fail(createInvalidStateError(ABSENT_TARGET_REASON[target.kind]));
        }
        const condition = expandTarget(target);
        // A condition the evaluator refuses could never match, and the caller
        // is the only one who can still choose another target. No expansion
        // this version can produce is refused: every id it writes goes in as a
        // quoted string literal, so nothing a caller writes can reach the
        // grammar. The check stands for the sources a trigger stores later,
        // which are written by hand.
        yield* Effect.mapError(checkExpression(condition, "event"), (failure) =>
          createInvalidStateError(failure.message),
        );
        const subscriptionId = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            return yield* subscriptions.insert({
              holder: { kind: "session", id: actor.sessionId },
              target,
              condition,
              at,
              actor: yield* currentStamp,
            });
          }),
        );
        return { subscriptionId };
      }),

    /**
     * One page of a holder's live subscriptions. A session that names no
     * holder reads its own; a session that names another holder reads that
     * one, because a grant bounds an operation and not a row in v1.
     */
    query: (input: QueryInput): Effect.Effect<SubscriptionPage, CommonError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("subscription.query");
        const { holder, limit, cursor, sort } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const whose =
          holder ??
          (actor._tag === "session"
            ? ({ kind: "session", id: actor.sessionId } as const)
            : undefined);
        if (whose === undefined) {
          return yield* Effect.fail(
            createValidationError(
              [{ path: ["holder"], message: NEEDS_A_HOLDER_REPAIR }],
              NEEDS_A_HOLDER,
            ),
          );
        }
        const listing = yield* refuseCursor(
          subscriptions.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            holder: whose,
          }),
        );
        return {
          items: listing.items.map(composeRecord),
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * Stops one subscription waiting.
     *
     * A session ends its own subscriptions and no others: a claim belongs to
     * the session that made it, and another session's is not its to end. The
     * user ends any. Three cases answer alike - no such id, a subscription
     * already ended, and one another session holds - so a caller learns
     * nothing about what it may not reach, and each answer leaves it with
     * nothing left to do.
     */
    cancel: (input: Identified): Effect.Effect<Record<string, never>, CommonError | NotFound> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("subscription.cancel");
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        const heldBy =
          actor._tag === "session"
            ? ({ kind: "session", id: actor.sessionId } as const)
            : undefined;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const ended = yield* subscriptions.end({
              id,
              at: yield* nowIso,
              reason: CANCELLED,
              actor: yield* currentStamp,
              ...(heldBy === undefined ? {} : { heldBy }),
            });
            if (!ended) return yield* Effect.fail(createNotFoundError(NO_SUCH_SUBSCRIPTION));
          }),
        );
        return {};
      }),
  };
});

/** The subscription service. */
export class SubscriptionService extends Context.Service<
  SubscriptionService,
  Effect.Success<typeof make>
>()("hercule/controller/subscriptions/SubscriptionService") {}

export const SubscriptionServiceLayer: Layer.Layer<
  SubscriptionService,
  never,
  SqlClient.SqlClient
> = Layer.effect(SubscriptionService)(make);

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
 * only from inside the matcher, long after the caller had gone.
 *
 * A listing answers live subscriptions only: it is read to see what a session
 * is still waiting for, and to find the id to cancel.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DEFAULT_PAGE_LIMIT,
  Id,
  SUBSCRIPTION_SORT_FIELDS,
  SubscriptionCreateInput,
  SubscriptionHolder,
  invalidState,
  notFound,
  validation,
  validationOf,
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
import { CurrentActor, requireGrant, stampOf } from "../actor";
import { nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { checkExpression } from "../expressions";
import { expandTarget } from "./targets";
import { subscriptionRepository, type StoredSubscription } from "./repository";

const QueryInput = Schema.Struct({
  holder: Schema.optionalKey(SubscriptionHolder),
  ...pageInput(SUBSCRIPTION_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeCreate = Schema.decodeUnknownEffect(SubscriptionCreateInput);
const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

export interface SubscriptionPage {
  readonly items: ReadonlyArray<Subscription>;
  readonly nextCursor?: string;
}

/** Newest first, as every other listing of what has been set up is read. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** What ends a subscription the holder asked to end. */
const CANCELLED = "cancelled";

/** Why a target this version cannot wait on is refused, one message per subject. */
const ABSENT_SUBJECT: Record<Exclude<SubscriptionTarget["kind"], "ref">, string> = {
  run: "no runs exist yet, so there is no run to wait on; wait on an External Ref instead",
  session:
    "no session.* platform events are emitted yet, so a session target would never match; " +
    "wait on an External Ref instead",
  request:
    "no Permission Requests exist yet, so there is no decision to wait for; " +
    "wait on an External Ref instead",
};

/** Why a credential that is nobody's session cannot register one. */
const NEEDS_A_SESSION =
  "a subscription is held by the session that registers it, and a user credential is no session; " +
  "call this with a session token";

/** Why a user credential listing subscriptions has to say whose. */
const NEEDS_A_HOLDER =
  "a user credential holds no subscriptions of its own; name whose to list, as holder=session:<id>";

const NO_SUCH_SUBSCRIPTION = "no live subscription has that id";

/** How a stored row reads as health: no failure recorded is `ok`. */
const readHealth = (stored: StoredSubscription): SubscriptionHealth =>
  stored.healthErrorMessage === null || stored.healthErrorAt === null
    ? { state: "ok" }
    : { state: "error", message: stored.healthErrorMessage, at: stored.healthErrorAt };

const composeRecord = (stored: StoredSubscription): Subscription => ({
  id: stored.id,
  target: stored.target,
  condition: stored.condition,
  holder: stored.holder,
  health: readHealth(stored),
  createdAt: stored.createdAt,
  ...(stored.endedAt === null ? {} : { endedAt: stored.endedAt }),
});

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const subscriptions = yield* subscriptionRepository;

  return {
    /** Registers what this session waits on, and answers which subscription that is. */
    create: (
      input: SubscriptionCreateInput,
    ): Effect.Effect<{ readonly subscriptionId: string }, ReadError | InvalidState> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("subscription.create");
        const { target } = yield* Effect.mapError(decodeCreate(input), validationOf);
        if (actor._tag !== "session") {
          return yield* Effect.fail(
            validation([{ path: [], message: NEEDS_A_SESSION }], NEEDS_A_SESSION),
          );
        }
        if (target.kind !== "ref") {
          return yield* Effect.fail(invalidState(ABSENT_SUBJECT[target.kind]));
        }
        const condition = expandTarget(target);
        // The expansion is this domain's own text with the caller's subject
        // quoted into it. A refusal here is therefore about the subject, and
        // the caller is the only one who can correct it.
        yield* Effect.mapError(checkExpression(condition), (failure) =>
          validation([{ path: ["target"], message: failure.message }]),
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
              actor: stampOf(actor),
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
    query: (input: QueryInput): Effect.Effect<SubscriptionPage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("subscription.query");
        const { holder, limit, cursor, sort } = yield* Effect.mapError(
          decodeQuery(input),
          validationOf,
        );
        const actor = yield* CurrentActor;
        const whose =
          holder ??
          (actor._tag === "session"
            ? ({ kind: "session", id: actor.sessionId } as const)
            : undefined);
        if (whose === undefined) {
          return yield* Effect.fail(
            validation([{ path: ["holder"], message: NEEDS_A_HOLDER }], NEEDS_A_HOLDER),
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
     * Stops one subscription waiting. A subscription that has already ended is
     * not there to be cancelled, and answers like an id that names nothing:
     * both leave the caller with nothing left to do.
     */
    cancel: (input: Identified): Effect.Effect<Record<string, never>, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("subscription.cancel");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            // Read inside the write set: a sweep that ends the same row
            // between a read outside and the update would report a cancel that
            // did not happen.
            const live = yield* subscriptions.readLive(id);
            if (Option.isNone(live)) return yield* Effect.fail(notFound(NO_SUCH_SUBSCRIPTION));
            yield* subscriptions.end(id, at, CANCELLED);
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

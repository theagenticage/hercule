/**
 * The subscription operations: `subscription.create`, `query` and `cancel`.
 *
 * A subscription is held by the session that registered it. The holder is
 * taken from the credential and never from the payload, so an agent cannot
 * make another session wait on something, and a user credential - which is
 * nobody's session - cannot register one at all.
 *
 * What is stored is the target as it was written and the condition it expands
 * into. The condition is validated before it is stored. A condition the
 * evaluator rejects could never match, and the error would otherwise appear
 * only inside the event router, long after the caller has gone.
 *
 * `subscription.query` returns live subscriptions only: it is used to see what
 * a session is still waiting for, and to find the id to cancel.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
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
  type RunStatus,
  type SortDirection,
  type Subscription,
  type SubscriptionHealth,
  type SubscriptionTarget,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant } from "../actor";
import { nowIso, buildPageInputFields, refuseCursor, withTransaction } from "../db";
import { validateExpression } from "../expressions";
import { isUnfinished, RunService } from "../runs";
import { expandTarget } from "./targets";
import { subscriptionRepository, type StoredSubscription } from "./repository";

const QueryInput = Schema.Struct({
  holder: Schema.optionalKey(SubscriptionHolder),
  ...buildPageInputFields(SUBSCRIPTION_SORT_FIELDS),
});

type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeCreate = Schema.decodeUnknownEffect(SubscriptionCreateInput);
const decodeQuery = Schema.decodeUnknownEffect(QueryInput);

interface SubscriptionPage {
  readonly items: ReadonlyArray<Subscription>;
  readonly nextCursor?: string;
}

/** Newest first, like the other listings. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** The end reason of a subscription that its holder cancelled. */
const CANCELLED = "cancelled";

/**
 * Returns the end reason for a subscription whose holding session has exited
 * for good. The session is named because a reader of the row may have several
 * sessions and needs to know which one held this subscription.
 *
 * The same reason also cancels the undelivered inputs that the subscription
 * produced, so both rows carry the same sentence and a reader never has to
 * join them.
 */
export const buildHolderEndedReason = (sessionId: string): string =>
  `session ${sessionId}, which held this subscription, has exited and its transcript ` +
  `cannot be picked up again`;

/** The reason each target kind that this version cannot wait on is rejected. */
const ABSENT_TARGET_REASON: Record<Exclude<SubscriptionTarget["kind"], "ref" | "run">, string> = {
  session:
    "no session.* platform events are emitted yet, so a session target would never match; " +
    "wait on an External Ref instead",
  request:
    "no Permission Requests exist yet, so there is no decision to wait for; " +
    "wait on an External Ref instead",
};

/**
 * Returns the reason a run target is refused when its run has already ended.
 * A run emits one event, when it ends, so nothing would ever arrive.
 */
const buildEndedRunReason = (status: RunStatus): string =>
  `the run has already ended (${status}), so no event about it will arrive; ` +
  "read the run with run.read instead";

/**
 * The messages for two errors: a user credential registering a subscription,
 * and a user credential listing subscriptions without naming a holder.
 *
 * Each error has two different sentences: a summary, and a message on the
 * `holder` field. A reader shown the same sentence twice would read it twice
 * to find out what is different.
 */
const NEEDS_A_SESSION = "a subscription needs a session holder";

const NEEDS_A_SESSION_REPAIR =
  "a subscription is held by the session that registers it, and a user credential is not a session; " +
  "call this with a session token";

const NEEDS_A_HOLDER = "a subscription listing needs a holder";

const NEEDS_A_HOLDER_REPAIR =
  "a user credential has no subscriptions of its own; " +
  "name the holder whose subscriptions to list, as holder=session:<id>";

const NO_SUCH_SUBSCRIPTION = "no live subscription has that id";

/** Returns the subscription's health: `ok` unless an evaluation error is recorded. */
const readHealth = (stored: StoredSubscription): SubscriptionHealth =>
  stored.healthErrorMessage === null || stored.healthErrorAt === null
    ? { state: "ok" }
    : { state: "error", message: stored.healthErrorMessage, at: stored.healthErrorAt };

/** Returns the wake-up that a restart cancelled, or null if there is none. */
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

/** The errors every operation here can fail with before it does its work. */
type CommonError = Unauthenticated | Forbidden | Validation | SqlError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const subscriptions = yield* subscriptionRepository;
  const runs = yield* RunService;

  return {
    /**
     * Registers a subscription for the calling session and returns its id.
     * Fails with:
     *
     * - `Validation` if the caller is not a session;
     * - `InvalidState` for a session or a request target, which this version
     *   cannot wait on, and for a run target whose run has already ended;
     * - `NotFound` for a run target that names no run;
     * - `Forbidden` for a run target when the caller lacks `run.read`,
     *   because the events about a run describe the run.
     */
    create: (
      input: SubscriptionCreateInput,
    ): Effect.Effect<{ readonly subscriptionId: string }, CommonError | InvalidState | NotFound> =>
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
        if (target.kind === "session" || target.kind === "request") {
          return yield* Effect.fail(createInvalidStateError(ABSENT_TARGET_REASON[target.kind]));
        }
        const condition = expandTarget(target);
        // A condition the evaluator rejects could never match, and only the
        // caller can still choose another target. No expansion this version
        // produces is rejected: every id goes in as a quoted string literal, so
        // nothing a caller writes can change the expression's syntax. The
        // check stays as a safety net: if a change to `expandTarget` ever
        // produced an invalid expression, the caller would get an error here
        // instead of a subscription that silently never matches.
        yield* Effect.mapError(validateExpression(condition, "event"), (failure) =>
          createInvalidStateError(failure.message),
        );
        const subscriptionId = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Checked in the transaction that writes the subscription, so the
            // run cannot end, and emit its one event, between the check and
            // the write.
            if (target.kind === "run") {
              const run = yield* runs.read(target.runId);
              if (!isUnfinished(run.status)) {
                return yield* Effect.fail(createInvalidStateError(buildEndedRunReason(run.status)));
              }
            }
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
     * Returns one page of a holder's live subscriptions. A session that names
     * no holder gets its own. A session that names another holder gets that
     * holder's, because in v1 a grant covers an operation, not single rows.
     * Fails with `Validation` if a user credential names no holder.
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
     * Cancels one live subscription.
     *
     * A session can cancel only its own subscriptions, because a subscription
     * belongs to the session that registered it. The user can cancel any.
     * These three cases fail with the same `NotFound` error:
     *
     * - the id does not exist
     * - the subscription has already ended
     * - another session holds the subscription
     *
     * So a caller learns nothing about what it may not reach, and in each case
     * there is nothing left for it to cancel.
     */
    cancel: (
      id: Id,
    ): Effect.Effect<Record<string, never>, Exclude<CommonError | NotFound, Validation>> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("subscription.cancel");
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
  SqlClient.SqlClient | RunService
> = Layer.effect(SubscriptionService)(make);

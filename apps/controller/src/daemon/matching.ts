/**
 * The matcher's use cases: everything that decides who an event reaches.
 *
 * The matcher is a durable-cursor consumer of the event log. It polls rather
 * than listens, and it keeps how far it has read in the database, so a
 * controller that was killed and started again reads on from where it stopped
 * instead of waiting to be told about entries that arrived while it was gone.
 *
 * Enrichment is here rather than in the events domain because of what it owes
 * the matcher: amending an event gives the matcher one more look at that one
 * event, and what that look writes are rows in the sessions domain. A write
 * across domains comes from above, so the whole of it sits in this layer. The
 * amendment itself is the events domain's own write, made through its service.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  EnrichPayload,
  EventId,
  validationOf,
  type Event,
  type Forbidden,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireGrant, SYSTEM_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import {
  advanceConsumerCursor,
  EventService,
  headOfLog,
  readConsumerPosition,
  readPipelineEvent,
  readPipelineEventsAfter,
} from "../events";
import { evaluateExpression } from "../expressions";
import { SessionService, sessionRepository } from "../sessions";
import {
  EvaluationErrorNotifier,
  subscriptionRepository,
  type StoredSubscription,
} from "../subscriptions";
import { absorbing, forking } from "./absorbing";
import { Live } from "./live";

/** One event named by its position in the log, and what is to be amended on it. */
const EnrichInput = Schema.Struct({ id: EventId, ...EnrichPayload.fields });

type EnrichInput = Schema.Schema.Type<typeof EnrichInput>;

const decodeEnrich = Schema.decodeUnknownEffect(EnrichInput, { errors: "all" });

/** The matcher's name in the cursor table. It is the only consumer today. */
const MATCHER = "matcher";

/**
 * How many entries one pass reads.
 *
 * This is the only bound the pass has, and it bounds the entry count alone.
 * The subscriptions a pass evaluates are read whole and unpaged, and the
 * wall-clock guard on one evaluation reports an overrun after the fact
 * rather than stopping it, so the time one pass takes is bounded by nothing:
 * it grows with the number of live subscriptions and with what one expression
 * does. The only hard bound anywhere is the parse-time limit on the source of
 * an expression. A pass holds the database's one write lock the whole time it
 * runs, so everything else writing waits behind it. Real evaluations take
 * microseconds; a full pass over a hundred subscriptions is milliseconds.
 */
const EVENTS_PER_PASS = 100;

/** How often the matcher looks for entries it has not read. */
const EVENT_MATCH_INTERVAL: Duration.Duration = Duration.seconds(1);

/** Tests hand over an interval they can wait out. */
export const EventMatchInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/EventMatchInterval",
  { defaultValue: (): Duration.Duration => EVENT_MATCH_INTERVAL },
);

/** Why a subscription was ended, for the row and for the inputs it produced. */
const buildHolderEndedReason = (sessionId: string): string =>
  `session ${sessionId}, which held this subscription, has exited and its transcript ` +
  `cannot be picked up again`;

/** The title the payload's subject carries, where it carries one. */
const readSubjectTitle = (payload: Readonly<Record<string, unknown>>): string | undefined => {
  const subject: unknown = payload["subject"];
  if (typeof subject !== "object" || subject === null) return undefined;
  const title: unknown = (subject as Record<string, unknown>)["title"];
  return typeof title === "string" && title !== "" ? title : undefined;
};

/**
 * What a matched event reads like as a session's input: one line saying what
 * happened, then the payload as JSON the agent can act on without another
 * call.
 *
 * A field the event does not carry is left out rather than written as the word
 * a template produces for a missing value. This text opens an agent's turn,
 * and a line reading "undefined" is a fact the agent did not learn from the
 * event.
 */
export const renderEventInput = (event: Event): string => {
  const title = readSubjectTitle(event.payload);
  const line = [event.kind, title, event.url ?? undefined].filter(
    (part): part is string => part !== undefined,
  );
  return `${line.join(" - ")}\n\n\`\`\`json\n${JSON.stringify(event.payload, null, 2)}\n\`\`\``;
};

/**
 * The envelope a condition is evaluated against. The original payload the
 * source system sent is left out: a condition is written against the fields
 * Hercule normalizes, and a condition reading an unnormalized field would
 * break the moment the source changed its own shape.
 */
const buildEvaluationContext = (event: Event): Record<string, unknown> => {
  const envelope: Record<string, unknown> = { ...event };
  delete envelope["raw"];
  return { event: envelope };
};

/** One subscription whose condition failed, and what the evaluator said. */
interface EvaluationFailure {
  readonly subscriptionId: string;
  readonly message: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventService;
  const sessions = yield* SessionService;
  const sessionRows = yield* sessionRepository;
  const subscriptions = yield* subscriptionRepository;
  const notifier = yield* EvaluationErrorNotifier;
  const live = yield* Live;

  /**
   * Ends every subscription whose holder session has ended for good, and
   * answers which subscriptions those were.
   *
   * It is the first thing a pass does, so an event is never evaluated against
   * a claim nobody is left to answer. A process that merely exited ends
   * nothing: a session whose transcript can still be picked up is woken by a
   * match like an idle one. Joins the caller's transaction.
   */
  const endSubscriptionsOfEndedHolders = (
    standing: ReadonlyArray<StoredSubscription>,
  ): Effect.Effect<ReadonlySet<string>, SqlError> =>
    Effect.gen(function* () {
      const holders = [...new Set(standing.map((one) => one.holder.id))];
      const gone = new Set(yield* sessionRows.listEndedForGood(holders));
      const ended = new Set<string>();
      for (const one of standing.filter((subscription) => gone.has(subscription.holder.id))) {
        const reason = buildHolderEndedReason(one.holder.id);
        // Nobody asked for this end, so the system is what stamps it.
        yield* subscriptions.end({
          id: one.id,
          at: yield* nowIso,
          reason,
          actor: SYSTEM_ACTOR,
        });
        // An input this subscription produced that nothing has delivered
        // yet is waiting for a session that will never take it.
        yield* sessions.cancelMatchedInputs(one.id, reason);
        ended.add(one.id);
      }
      return ended;
    });

  /**
   * Evaluates these events against these subscriptions and stores an input row
   * for every match, answering the failures that began a run of failures.
   *
   * Joins the caller's transaction and waits on nothing but SQL and this
   * thread's own CPU: the evaluator is synchronous and reaches nothing outside
   * the context it is given.
   *
   * A condition that cannot be evaluated is a no-match for its own
   * subscription and nothing else: every other subscription is still
   * evaluated, and the failure is recorded on the row where a caller reads it.
   */
  const matchEvents = (
    standing: ReadonlyArray<StoredSubscription>,
    batch: ReadonlyArray<Event>,
  ): Effect.Effect<ReadonlyArray<EvaluationFailure>, SqlError> =>
    Effect.gen(function* () {
      const newFailures: Array<EvaluationFailure> = [];
      /** Which subscriptions were in a run of failures when this pass began. */
      const failing = new Map(
        standing.map((one) => [one.id, one.healthErrorMessage !== null] as const),
      );
      for (const event of batch) {
        const context = buildEvaluationContext(event);
        const text = renderEventInput(event);
        for (const subscription of standing) {
          const answer = yield* Effect.result(evaluateExpression(subscription.condition, context));
          if (Result.isFailure(answer)) {
            const message = answer.failure.message;
            const began = yield* subscriptions.recordEvaluationFailure(
              subscription.id,
              message,
              yield* nowIso,
            );
            if (began) newFailures.push({ subscriptionId: subscription.id, message });
            failing.set(subscription.id, true);
            continue;
          }
          if (failing.get(subscription.id) === true) {
            yield* subscriptions.clearEvaluationFailure(subscription.id);
            failing.set(subscription.id, false);
          }
          // Only a condition that answers true has matched. A condition
          // answering a string or a number has not said yes to anything.
          if (answer.success !== true) continue;
          yield* sessions.takeMatchedInput({
            sessionId: subscription.holder.id,
            subscriptionId: subscription.id,
            eventId: event.id,
            actor: SYSTEM_ACTOR,
            text,
            at: yield* nowIso,
          });
        }
      }
      return newFailures;
    });

  /** Tells whoever is to hear that these subscriptions cannot be evaluated. */
  const reportFailures = (failures: ReadonlyArray<EvaluationFailure>): Effect.Effect<void> =>
    Effect.forEach(
      failures,
      (failure) => notifier.notifyEvaluationError(failure.subscriptionId, failure.message),
      { discard: true },
    );

  /**
   * Gets every input a match has produced and nothing has sent yet to the
   * session it was stored for.
   *
   * It reads the rows rather than remembering what the pass just wrote, so a
   * row that outlived the attempt to deliver it - a controller killed between
   * the commit and the send, a machine that refused the frame, a session that
   * was busy and whose transition to idle was missed - is picked up by the
   * next pass instead of waiting for ever.
   *
   * One fiber per session: a delivery waits on a machine, and a machine that
   * is slow to answer must not hold up the sessions behind it or the next
   * pass. The fibers are children of the pass's own driver, which lives as
   * long as the controller does.
   */
  const deliverWaitingMatches: Effect.Effect<void, SqlError> = Effect.gen(function* () {
    for (const sessionId of yield* sessions.listSessionsAwaitingMatches()) {
      yield* forking(
        "A session could not be given what it was waiting for",
        live.deliverQueuedInput(sessionId),
      );
    }
  });

  /**
   * One pass: the sweep, the subscriptions still waiting, the entries past the
   * cursor, and then what the pass owes the world outside the database.
   *
   * Everything the pass decides is one transaction, so a pass that fails part
   * way writes nothing at all, and a subscription created or cancelled while
   * the pass runs is either wholly before it or wholly after it - never half
   * seen, which is how an event could be walked past for a subscription that
   * existed all along. Nothing in that transaction waits on anything but SQL
   * and CPU: reading the entries and storing the rows are SQL, and evaluating
   * a condition is this thread's own work. Telling a session, which waits on a
   * machine, happens after the commit.
   *
   * The cursor moves even where nothing matched, and even where the batch came
   * back empty - to the end of the log as it stood inside the transaction - so
   * a log full of entries nothing waits for is walked once rather than read
   * again on every pass.
   */
  const matchNewEvents: Effect.Effect<void, SqlError> = Effect.gen(function* () {
    const failures = yield* withTransaction(
      sql,
      Effect.gen(function* () {
        const waiting = yield* subscriptions.listLive();
        const ended = yield* endSubscriptionsOfEndedHolders(waiting);
        const standing = waiting.filter((one) => !ended.has(one.id));
        const position = yield* readConsumerPosition(sql, MATCHER);
        const batch = yield* readPipelineEventsAfter(sql, position, EVENTS_PER_PASS);
        const failures = yield* matchEvents(standing, batch);
        const reached = batch.at(-1)?.id ?? (yield* headOfLog(sql));
        if (reached > position) yield* advanceConsumerCursor(sql, MATCHER, reached);
        return failures;
      }),
    );
    yield* reportFailures(failures);
    yield* deliverWaitingMatches;
  });

  /**
   * One more look at one event, for a subscription that may have been created,
   * or a ref that may have been added, since the matcher walked past it.
   *
   * The cursor is not touched: this is not a step through the log, and moving
   * it would either skip entries or read them again. The input rows are unique
   * per subscription and event, so whatever matched the first time gets
   * nothing a second time. Joins the caller's transaction, and writes rows
   * only: the next pass of the matcher sends them, within one interval.
   */
  const rematchEvent = (
    eventId: number,
  ): Effect.Effect<ReadonlyArray<EvaluationFailure>, SqlError> =>
    Effect.gen(function* () {
      const standing = yield* subscriptions.listLive();
      if (standing.length === 0) return [];
      const event = yield* readPipelineEvent(sql, eventId);
      if (Option.isNone(event)) return [];
      return yield* matchEvents(standing, [event.value]);
    });

  return {
    /**
     * Amends what an event is about, and hands the matcher the amended event.
     *
     * The amendment and that second look are one transaction, so two
     * enrichments of one event cannot each drop the other's refs, and a look
     * that writes cannot be separated from the write it read. What the look
     * writes reaches its session on the matcher's next pass.
     */
    enrichEvent: (
      input: EnrichInput,
    ): Effect.Effect<Event, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        // Amending the log is writing to it, which is the grant an emit needs.
        yield* requireGrant("event.enrich");
        const decoded = yield* Effect.mapError(decodeEnrich(input), validationOf);

        const { amended, failures } = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const amended = yield* events.amend(decoded);
            // A ref added here may be what a subscription has been waiting
            // for, so the matcher looks at this one event again. The rows that
            // look writes are sent by the next pass of the matcher, within one
            // interval: this call runs on a request's own fiber, which is gone
            // the moment the answer is written, and a delivery started on it
            // would be cut off half way.
            return { amended, failures: yield* rematchEvent(decoded.id) };
          }),
        );
        yield* reportFailures(failures);
        return amended;
      }),

    /**
     * What the matcher does on its own: it reads the entries nothing has
     * matched yet, on its own interval. A pass that fails is logged and the
     * next one runs, because one bad pass must not stop the pipeline every
     * later wake-up rides on.
     */
    driving: Effect.gen(function* () {
      const interval = yield* EventMatchInterval;
      while (true) {
        yield* Effect.sleep(interval);
        yield* absorbing("One pass of the event matcher failed", matchNewEvents);
      }
    }),
  };
});

/** The matcher, and the enrichment that gives it a second look at one event. */
export class Matcher extends Context.Service<Matcher, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Matcher",
) {}

export const MatcherLayer: Layer.Layer<
  Matcher,
  never,
  SqlClient.SqlClient | EventService | SessionService | EvaluationErrorNotifier | Live
> = Layer.effect(Matcher)(make);

/**
 * The repository for a session's inputs. Inputs belong to a session, so this
 * lives beside the session repository rather than in a domain of its own.
 *
 * Nothing here decides whether an input is sent or held; the service does.
 * The queue is simply the rows whose status is still `queued`.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AttachmentReference, Delivery } from "@hercule/protocol";
import type { InputSource, InputStatus, SortDirection } from "@hercule/contract";
import {
  decodeCursor,
  encodeCursor,
  buildKeyset,
  mintUuid,
  buildPage,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";
import { listInputAttachments } from "../attachments";
import { buildResumableClause } from "./repository";

export interface StoredInput {
  readonly id: string;
  readonly sessionId: string;
  readonly source: InputSource;
  readonly actor: string;
  readonly text: string;
  /** The images the input carries, in the order the user attached them. */
  readonly attachments: ReadonlyArray<AttachmentReference>;
  readonly status: InputStatus;
  readonly delivery: Delivery | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  /**
   * When the input was sent, while the runner has not answered: on a `queued`
   * row on its way to the runner, and on a `sent` row. Null otherwise.
   */
  readonly sentAt: string | null;
  /** Why a delivery failed, on a row still queued or cancelled because of it; null otherwise. */
  readonly reason: string | null;
  /**
   * The iteration of the agent step this input is the prompt for; null for
   * any input that is not a step's prompt. The step's run and step id are on
   * the session.
   */
  readonly stepIteration: number | null;
}

export interface NewInput {
  readonly sessionId: string;
  readonly source: InputSource;
  readonly actor: string;
  readonly text: string;
  readonly at: string;
  /**
   * Set to claim the row in the same insert, for an input sent to an idle
   * session. No separate claim can lose a race, because nothing else can see
   * the row before this transaction commits.
   */
  readonly sentAt?: string;
  /** Set for the prompt of an agent step's iteration; see `StoredInput.stepIteration`. */
  readonly stepIteration?: number;
  /**
   * Set when the input is the delivery of a Subscription match. The row then
   * records the subscription and the event, like one `insertMatched` writes,
   * so the match is stored once and a cancelled subscription cancels it.
   */
  readonly match?: SubscriptionMatch;
}

/** The Subscription and the event in the log that together made one input. */
export interface SubscriptionMatch {
  readonly subscriptionId: string;
  /** The position in the log of the event that matched. */
  readonly eventId: number;
}

/** What `cancelQueued` cancelled. */
export interface CancelledInputs {
  /** How many inputs were cancelled. */
  readonly count: number;
  /** The iteration of each agent step prompt among them, which no runner ever saw. */
  readonly stepIterations: ReadonlyArray<number>;
}

/** A wake-up that was sent, never acknowledged, and cannot be stored again. */
export interface LostWakeUp {
  readonly subscriptionId: string;
  readonly eventId: number;
}

/** An input created by a subscription match, with the subscription and event it came from. */
export interface NewMatchedInput {
  readonly sessionId: string;
  readonly subscriptionId: string;
  /** The position in the log of the event that matched. */
  readonly eventId: number;
  readonly actor: string;
  readonly text: string;
  readonly at: string;
}

export interface InputPageRequest {
  readonly sessionId: string;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

interface InputRow {
  readonly id: Uint8Array;
  readonly session_id: Uint8Array;
  readonly source: string;
  readonly actor: string;
  readonly text: string;
  readonly status: string;
  readonly delivery: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly sent_at: string | null;
  readonly reason: string | null;
  readonly step_iteration: number | null;
}

/** The reason stored on a flush that never ran, because its session exited first. */
const UNRAN_FLUSH =
  "the session exited before it could record its memory, and the conversation goes on in a new session";

/**
 * Builds the SQL condition that holds when the `session_inputs` row named by
 * `alias` may be sent to its session. A retired session is given only its
 * flush (source `rotation`); every other input waits there until the session
 * has exited and the conversation's next session takes it over.
 */
const buildGivableClause = (alias: string): string =>
  `(${alias}.source = 'rotation' OR NOT EXISTS (SELECT 1 FROM sessions ` +
  `WHERE sessions.id = ${alias}.session_id AND sessions.retired_at IS NOT NULL))`;

const COLUMNS =
  "id, session_id, source, actor, text, status, delivery, created_at, delivered_at, sent_at, reason, " +
  "step_iteration";

const toInput = (row: InputRow, attachments: ReadonlyArray<AttachmentReference>): StoredInput => ({
  id: uuidToString(row.id),
  sessionId: uuidToString(row.session_id),
  source: row.source as InputSource,
  actor: row.actor,
  text: row.text,
  attachments,
  status: row.status as InputStatus,
  delivery: row.delivery as Delivery | null,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  sentAt: row.sent_at,
  reason: row.reason,
  stepIteration: row.step_iteration,
});

/**
 * Builds the cursor scope for one session's input list. The list is per
 * session, so the session id is part of the scope. Without it, a cursor from
 * one session's list would silently skip rows on another session's list.
 */
const buildCursorScope = (sessionId: string, direction: SortDirection): CursorScope => ({
  op: "input.query",
  sort: [{ field: `createdAt:${sessionId}`, direction }],
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Builds the inputs from their rows, reading the images of all of them in one query. */
  const buildInputs = (
    rows: ReadonlyArray<InputRow>,
  ): Effect.Effect<ReadonlyArray<StoredInput>, SqlError> =>
    rows.length === 0
      ? Effect.succeed([])
      : listInputAttachments(rows.map((row) => uuidToString(row.id))).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.map((byInput) =>
            rows.map((row) => toInput(row, byInput.get(uuidToString(row.id)) ?? [])),
          ),
        );

  /**
   * Builds the condition that selects the rows to take over for a
   * conversation. See `takeOverWaitingInput`.
   */
  const buildTakeOverFilter = (conversationId: string, refusedSessionId: string | undefined) => sql`
    status IN ('queued', 'sent') AND source <> 'rotation'
    AND session_id IN (
      SELECT id FROM sessions
      WHERE conversation_id = ${uuidFromString(conversationId)} AND status = 'exited'
        AND (retired_at IS NOT NULL OR NOT (${sql.literal(buildResumableClause("sessions"))})
          OR id = ${refusedSessionId === undefined ? null : uuidFromString(refusedSessionId)})
    )`;

  /** Builds the input from the first row, or returns `none` when there is no row. */
  const buildFirstInput = (
    rows: ReadonlyArray<InputRow>,
  ): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
    Effect.map(buildInputs(rows.slice(0, 1)), (found) => Option.fromNullishOr(found[0]));

  return {
    insert: (input: NewInput): Effect.Effect<StoredInput, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        const sentAt = input.sentAt ?? null;
        const stepIteration = input.stepIteration ?? null;
        yield* sql`
          INSERT INTO session_inputs
            (id, session_id, source, actor, text, status, created_at, sent_at, step_iteration,
             subscription_id, event_id)
          VALUES (${id}, ${uuidFromString(input.sessionId)}, ${input.source}, ${input.actor},
                  ${input.text}, 'queued', ${input.at}, ${sentAt}, ${stepIteration},
                  ${input.match === undefined ? null : uuidFromString(input.match.subscriptionId)},
                  ${input.match?.eventId ?? null})
        `;
        return {
          id: uuidToString(id),
          sessionId: input.sessionId,
          source: input.source,
          actor: input.actor,
          text: input.text,
          attachments: [],
          status: "queued",
          delivery: null,
          createdAt: input.at,
          deliveredAt: null,
          sentAt,
          reason: null,
          stepIteration,
        };
      }),

    /**
     * Stores the input created by one match. Returns `none` and writes nothing
     * when the same subscription and event already have a row.
     *
     * An event log consumer that committed its rows but stopped before saving
     * how far it had read will read those events again. So the unique
     * (subscription, event) pair, not the caller, guarantees one input per
     * match. The row is never claimed in the insert: the input is sent to the
     * session only after the write is durable.
     */
    insertMatched: (input: NewMatchedInput): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        const written = yield* sql<{ readonly id: Uint8Array }>`
          INSERT INTO session_inputs
            (id, session_id, source, actor, text, status, created_at, subscription_id, event_id)
          VALUES (${id}, ${uuidFromString(input.sessionId)}, 'subscription', ${input.actor},
                  ${input.text}, 'queued', ${input.at},
                  ${uuidFromString(input.subscriptionId)}, ${input.eventId})
          ON CONFLICT (subscription_id, event_id) WHERE subscription_id IS NOT NULL
            DO NOTHING
          RETURNING id
        `;
        if (written.length === 0) return Option.none();
        return Option.some({
          id: uuidToString(id),
          sessionId: input.sessionId,
          source: "subscription",
          actor: input.actor,
          text: input.text,
          attachments: [],
          status: "queued",
          delivery: null,
          createdAt: input.at,
          deliveredAt: null,
          sentAt: null,
          reason: null,
          stepIteration: null,
        });
      }),

    /**
     * Cancels every input from one subscription that is still waiting, with
     * the reason the subscription ended. Returns the ids of the sessions whose
     * inputs were cancelled. An input already sent is left alone, for the
     * reason given on `cancelQueued`.
     */
    cancelQueuedForSubscription: (
      subscriptionId: string,
      reason: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly session_id: Uint8Array }>`
          UPDATE session_inputs SET status = 'cancelled', reason = ${reason}
          WHERE subscription_id = ${uuidFromString(subscriptionId)}
            AND status = 'queued' AND sent_at IS NULL
          RETURNING session_id
        `,
        (rows) => [...new Set(rows.map((row) => uuidToString(row.session_id)))],
      ),

    /**
     * Returns the ids of the sessions that have a queued input not yet sent,
     * whoever created it. The rows record what still has to be sent, so
     * nothing needs to be remembered across a restart. The next caller picks
     * up both of these:
     *
     * - a row the controller stopped on between the commit and the send;
     * - a row whose session went idle without the controller noticing.
     *
     * This holds for a person's typed input as well as for a match's.
     *
     * A retired session is listed only once it has exited, so the delivery
     * pass can place the conversation's next session for the input that still
     * waits on it. While it is live, the input waiting on it is not for it to
     * receive, and listing it would make every pass look at it for nothing.
     * Its flush is listed like any input.
     *
     * A session that already has an input sent and unanswered is left out.
     * The runner takes one input per turn boundary, so a second input sent
     * before the first one's turn has started would have to be held by the
     * runner. A step prompt marked `sent` does not count as unanswered here
     * (see `holdsInputOnTheWire`).
     */
    listSessionsAwaitingInput: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly session_id: Uint8Array }>`
          SELECT DISTINCT waiting.session_id FROM session_inputs AS waiting
          WHERE waiting.status = 'queued' AND waiting.sent_at IS NULL
            AND (${sql.literal(buildGivableClause("waiting"))}
              OR EXISTS (SELECT 1 FROM sessions
                WHERE sessions.id = waiting.session_id AND sessions.status = 'exited'))
            AND NOT EXISTS (
              SELECT 1 FROM session_inputs AS onTheWire
              WHERE onTheWire.session_id = waiting.session_id
                AND onTheWire.status = 'queued' AND onTheWire.sent_at IS NOT NULL
            )
        `,
        (rows) => rows.map((row) => uuidToString(row.session_id)),
      ),

    /**
     * Checks whether this session has an input that was sent and not yet
     * answered.
     *
     * The runner takes one input per turn boundary. A second input sent before
     * the first one's turn has started would have to be held by the runner, so
     * a caller with an input still out sends nothing more until the runner
     * reports what happened to it.
     *
     * Only a `queued` row with `sentAt` set counts. A step prompt marked
     * `sent` no longer counts, even though the runner may still hold it, so
     * another input can be sent after it. An ordinary input put back to
     * waiting after no answer came leaves the same gap.
     */
    holdsInputOnTheWire: (sessionId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM session_inputs
          WHERE session_id = ${uuidFromString(sessionId)}
            AND status = 'queued' AND sent_at IS NOT NULL
          LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /** Returns an input by its id alone, or `none` when there is no such input. */
    read: (id: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.flatMap(
        sql<InputRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_inputs WHERE id = ${uuidFromString(id)}
        `,
        buildFirstInput,
      ),

    /** Returns one input of a session. An input id that belongs to another session returns `none`. */
    one: (sessionId: string, id: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.flatMap(
        sql<InputRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_inputs
          WHERE id = ${uuidFromString(id)} AND session_id = ${uuidFromString(sessionId)}
        `,
        buildFirstInput,
      ),

    list: (request: InputPageRequest): Effect.Effect<Page<StoredInput>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.sessionId, request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "created_at", direction: request.direction }],
          ["id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const rows = yield* sql<InputRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_inputs
          WHERE session_id = ${uuidFromString(request.sessionId)} AND ${keyset}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(rows, request.limit, buildInputs, (last) =>
          encodeCursor(scope, [last.createdAt], last.id),
        );
      }),

    /**
     * Returns the session's oldest input that is queued, not yet sent and may
     * be sent to it, or `none` when there is none. It is the next input any
     * send claims: a start, a flush at the end of a turn, or a resume. A
     * retired session is given only its flush, so the input waiting on it for
     * the next session is not returned.
     */
    oldestWaiting: (sessionId: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.flatMap(
        sql<InputRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_inputs
          WHERE session_id = ${uuidFromString(sessionId)} AND status = 'queued' AND sent_at IS NULL
            AND ${sql.literal(buildGivableClause("session_inputs"))}
          ORDER BY created_at, id LIMIT 1
        `,
        buildFirstInput,
      ),

    /**
     * Checks whether the session has any input queued and not yet sent,
     * including input that may not be sent to it, as on a retired session.
     * Used to tell that an exited session leaves something waiting.
     */
    hasWaiting: (sessionId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM session_inputs
          WHERE session_id = ${uuidFromString(sessionId)} AND status = 'queued'
            AND sent_at IS NULL LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Claims an input for one send, just before its frame goes out to the
     * runner: the row stays `queued` and records when it was sent.
     * Returns the row as the update found it, not a copy read earlier, which
     * an edit in between could have changed. Returns `none` when the input was
     * already sent, already answered, or already cancelled. A second caller
     * racing to claim the same input always gets `none`.
     *
     * An input of an exited session is never claimed, and returns `none`. A
     * caller that read the session as idle can race the runner's report that
     * it exited. The input then stays waiting, and the resume that follows
     * the exit sends it to the new process. Claimed, it would go to a process
     * that is gone.
     *
     * An input of a retired session is never claimed either, except its
     * flush: the rest waits for the conversation's next session, which takes
     * it over (`takeOverWaitingInput`).
     */
    claim: (id: string, at: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.flatMap(
        sql<InputRow>`
          UPDATE session_inputs SET sent_at = ${at}, reason = NULL
          WHERE id = ${uuidFromString(id)} AND status = 'queued' AND sent_at IS NULL
            AND ${sql.literal(buildGivableClause("session_inputs"))}
            AND EXISTS (
              SELECT 1 FROM sessions
              WHERE sessions.id = session_inputs.session_id AND sessions.status <> 'exited'
            )
          RETURNING ${sql.literal(COLUMNS)}
        `,
        buildFirstInput,
      ),

    /**
     * Claims the oldest input still waiting on an idle session, as `claim`
     * does for one input. Returns the claimed row, or `none` when:
     *
     * - no input is waiting;
     * - another input of the session is already sent and unanswered, where a
     *   step prompt marked `sent` does not count (see `holdsInputOnTheWire`);
     * - the session is not `idle`;
     * - the session is retired and its oldest input is not its flush.
     *
     * The runner takes one input per turn. A second input sent before the
     * first one's turn has started would have to be held by the runner. The
     * checks and the claim are one statement, so two callers that both read
     * the session as idle cannot each claim a different row.
     */
    claimOldestUnlessOneIsOnTheWire: (
      sessionId: string,
      at: string,
    ): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.flatMap(
        sql<InputRow>`
          UPDATE session_inputs SET sent_at = ${at}, reason = NULL
          WHERE id = (
              SELECT id FROM session_inputs
              WHERE session_id = ${uuidFromString(sessionId)}
                AND status = 'queued' AND sent_at IS NULL
                AND ${sql.literal(buildGivableClause("session_inputs"))}
              ORDER BY created_at, id LIMIT 1
            )
            AND NOT EXISTS (
              SELECT 1 FROM session_inputs
              WHERE session_id = ${uuidFromString(sessionId)}
                AND status = 'queued' AND sent_at IS NOT NULL
            )
            AND EXISTS (
              SELECT 1 FROM sessions
              WHERE sessions.id = ${uuidFromString(sessionId)} AND sessions.status = 'idle'
            )
          RETURNING ${sql.literal(COLUMNS)}
        `,
        buildFirstInput,
      ),

    /**
     * Records the delivery the runner reported for this input. Only a row
     * still `queued` or `sent` changes, because a caller may have cancelled it
     * while the frame was in flight. A `sent` row is an agent step's prompt
     * the controller stopped waiting for, and a late confirmation is still
     * true: the runner took the prompt.
     *
     * `sentAt` is when the send being answered claimed the row, and works as
     * for `requeue`: the row changes only while it still holds that claim. A
     * late answer to a send that was given up must not mark as delivered a
     * row that was sent again since.
     *
     * Returns whether the row changed, so the caller knows whether it was the
     * one that recorded the delivery.
     */
    markDelivered: (
      id: string,
      sentAt: string | null,
      delivery: Delivery,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE session_inputs SET status = 'delivered', delivery = ${delivery},
                                    delivered_at = ${at}, sent_at = NULL
          WHERE id = ${uuidFromString(id)} AND status IN ('queued', 'sent')
            AND sent_at IS ${sentAt}
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Puts a claimed input back to waiting, so the next send claims it again.
     * `reason` is stored for a reader to see why the input was not delivered.
     * It is `null` when nothing failed that a reader needs to know about, such
     * as a frame that never left the controller because the runner was not
     * connected.
     *
     * `sentAt` is when the send being undone claimed the row. The row changes
     * only while it still holds that claim: a row that was put back to waiting
     * in the meantime may have been sent again, and that newer send must not
     * be undone.
     */
    requeue: (
      id: string,
      sentAt: string | null,
      reason: string | null,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET sent_at = NULL, reason = ${reason}
        WHERE id = ${uuidFromString(id)} AND status = 'queued' AND sent_at IS ${sentAt}
      `),

    /**
     * Replaces the text of an input still waiting, and makes it the input of
     * the actor who wrote the new text: the actor is replaced, and the source
     * becomes `user`, even on an input a subscription created. The receiving
     * agent is told which session sent an input, and that sender is read from
     * a `user` input's actor. Keeping the old actor would let one caller's
     * text pass as another's, and keeping the `subscription` source would let
     * it pass as a subscription's notice, with no sender named.
     *
     * The subscription and event an input came from are kept, so the event
     * still cannot create a second input, and the input is still cancelled
     * when its subscription ends.
     */
    rewrite: (id: string, text: string, actor: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET text = ${text}, actor = ${actor}, source = 'user'
        WHERE id = ${uuidFromString(id)} AND status = 'queued' AND sent_at IS NULL
      `),

    cancel: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled'
        WHERE id = ${uuidFromString(id)} AND status = 'queued' AND sent_at IS NULL
      `),

    /**
     * Cancels an input whose session exited before the runner answered for it.
     * Nothing waits on a harness that has exited. The reason is stored so a
     * caller reading the input later can see why it was never delivered.
     * `sentAt` works as for `requeue`: the row changes only while it still
     * holds the failed send's claim.
     */
    cancelWithReason: (
      id: string,
      sentAt: string | null,
      reason: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled', sent_at = NULL, reason = ${reason}
        WHERE id = ${uuidFromString(id)} AND status = 'queued' AND sent_at IS ${sentAt}
      `),

    /**
     * Marks an agent step's prompt the runner never answered as `sent`, and
     * keeps when it was sent. The prompt left the controller and the runner
     * may have run it, so it is never sent again. Returns whether the row
     * changed. `sentAt` works as for `requeue`: the row changes only while it
     * still holds the unanswered send's claim.
     */
    markSent: (id: string, sentAt: string | null): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE session_inputs SET status = 'sent', reason = NULL
          WHERE id = ${uuidFromString(id)} AND status = 'queued' AND sent_at IS ${sentAt}
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Cancels the agent step prompts not yet sent to any session of a run,
     * exited sessions included, storing `reason` on them. Returns the ids of
     * the sessions that had one.
     */
    cancelStepPromptsOfRun: (
      runId: string,
      reason: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly session_id: Uint8Array }>`
          UPDATE session_inputs SET status = 'cancelled', reason = ${reason}
          WHERE status = 'queued' AND sent_at IS NULL AND step_iteration IS NOT NULL
            AND session_id IN (SELECT id FROM sessions WHERE run_id = ${uuidFromString(runId)})
          RETURNING session_id
        `,
        (rows) => [...new Set(rows.map((row) => uuidToString(row.session_id)))],
      ),

    /**
     * Cancels every input of a session that is still waiting, because nothing
     * waits on a harness that has exited, and returns what it cancelled. An
     * input already sent is left alone: the runner has its text, so
     * recording it as cancelled would be wrong.
     */
    cancelQueued: (sessionId: string, reason?: string): Effect.Effect<CancelledInputs, SqlError> =>
      Effect.map(
        sql<{ readonly step_iteration: number | null }>`
          UPDATE session_inputs SET status = 'cancelled', reason = COALESCE(${reason ?? null}, reason)
          WHERE session_id = ${uuidFromString(sessionId)} AND status = 'queued' AND sent_at IS NULL
          RETURNING step_iteration
        `,
        (rows) => ({
          count: rows.length,
          stepIterations: rows.flatMap((row) =>
            row.step_iteration === null ? [] : [row.step_iteration],
          ),
        }),
      ),

    /**
     * Cancels every queued input of every session that answers the
     * conversation, sent or not, with `reason`. Returns the ids of the
     * sessions whose inputs were cancelled.
     *
     * An input sent and unanswered is cancelled too. Its session has exited
     * by the time this runs, so no harness holds the text any more, and an
     * input left queued would bring the session back to run it.
     */
    cancelForConversation: (
      conversationId: string,
      reason: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly session_id: Uint8Array }>`
          UPDATE session_inputs SET status = 'cancelled', sent_at = NULL, reason = ${reason}
          WHERE status = 'queued'
            AND session_id IN (
              SELECT id FROM sessions WHERE conversation_id = ${uuidFromString(conversationId)}
            )
          RETURNING session_id
        `,
        (rows) => [...new Set(rows.map((row) => uuidToString(row.session_id)))],
      ),

    /**
     * Cancels every input that was sent but unanswered when the controller
     * restarted, except an agent step's prompt (`markStrandedStepPromptsSent`).
     * Nobody knows whether the harness received the input before the
     * connection dropped, so it is neither marked delivered nor sent again:
     * sending it again could deliver the message twice.
     *
     * Returns the wake-ups lost with those inputs. An input created by a match
     * stores the subscription and event it came from, and that pair can never
     * be stored again, so the caller needs to know which subscription lost a
     * wake-up.
     */
    cancelStranded: (reason: string): Effect.Effect<ReadonlyArray<LostWakeUp>, SqlError> =>
      Effect.map(
        sql<{
          readonly subscription_id: Uint8Array | null;
          readonly event_id: number | null;
        }>`
          UPDATE session_inputs SET status = 'cancelled', sent_at = NULL, reason = ${reason}
          WHERE status = 'queued' AND sent_at IS NOT NULL AND step_iteration IS NULL
          RETURNING subscription_id, event_id
        `,
        (rows) =>
          rows.flatMap((row) =>
            row.subscription_id === null || row.event_id === null
              ? []
              : [{ subscriptionId: uuidToString(row.subscription_id), eventId: row.event_id }],
          ),
      ),

    /**
     * Marks `sent` every agent step's prompt that was sent but unanswered when
     * the controller restarted, as `markSent` does for one prompt. The runner
     * may have run the prompt, so it is never sent again, and the runner's
     * answer about the step settles the step.
     */
    markStrandedStepPromptsSent: (): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'sent', reason = NULL
        WHERE status = 'queued' AND sent_at IS NOT NULL AND step_iteration IS NOT NULL
      `),

    /**
     * Returns the input that opened the session's most recent turn: the input
     * last delivered with delivery `opened`, or `none` before the first one.
     * An input steered into a running turn is delivered too, but it joins the
     * turn and does not say what the turn is for, so it is skipped.
     */
    latestOpened: (sessionId: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.flatMap(
        sql<InputRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_inputs
          WHERE session_id = ${uuidFromString(sessionId)} AND status = 'delivered'
            AND delivery = 'opened'
          ORDER BY delivered_at DESC, id DESC LIMIT 1
        `,
        buildFirstInput,
      ),

    /** Checks whether the session has had a turn: some input of it was delivered. */
    hasDelivered: (sessionId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM session_inputs
          WHERE session_id = ${uuidFromString(sessionId)} AND status = 'delivered' LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Cancels the flush of a session (source `rotation`) that was not
     * delivered, whether it is waiting or was sent and not yet answered. Used
     * when the session exits: it can no longer record anything, and the next
     * session starts with fresh memory, so it has nothing to flush. A flush
     * is never taken over for the same reason, which is why the exit cancels
     * it instead of leaving it for `takeOverWaitingInput` to skip. A flush
     * that was delivered is left alone.
     */
    cancelUnranFlush: (sessionId: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled', sent_at = NULL, reason = ${UNRAN_FLUSH}
        WHERE session_id = ${uuidFromString(sessionId)} AND source = 'rotation'
          AND status = 'queued'
      `),

    /**
     * Checks whether the session still has a flush that was not delivered:
     * waiting or sent and not yet answered. A retired session is stopped when
     * a turn of it ends and this is `false`.
     */
    hasUndeliveredFlush: (sessionId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM session_inputs
          WHERE session_id = ${uuidFromString(sessionId)} AND source = 'rotation'
            AND status IN ('queued', 'sent') LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Moves the input that waits for the conversation to `successorId`, the
     * conversation's next session, and returns how many inputs it moved.
     * That is every undelivered input (`queued` or `sent`) of the
     * conversation's sessions that have exited and can take no more input,
     * because they are retired or cannot be resumed. A flush is not moved.
     *
     * The stored row of a session shows only a resume that can never happen
     * (no native session, a retired runner). `refusedSessionId` names a
     * session the caller just found it cannot resume for another reason, such
     * as a draining runner or a lost provider login, so its input moves too.
     *
     * The inputs keep the times they were created, so the successor sends
     * them oldest first, ahead of an input it was placed with. A row that was
     * on its way to the old session's process is waiting again, because that
     * process will never answer it. Input waiting on a retired session that
     * has not exited stays there until it does.
     */
    takeOverWaitingInput: (
      conversationId: string,
      successorId: string,
      refusedSessionId: string | undefined,
    ): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE session_inputs SET session_id = ${uuidFromString(successorId)}, sent_at = NULL
          WHERE ${buildTakeOverFilter(conversationId, refusedSessionId)}
          RETURNING id
        `,
        (rows) => rows.length,
      ),

    /**
     * Checks whether input waits for the conversation to be taken over by a
     * next session. The same test as `takeOverWaitingInput`.
     */
    hasInputToTakeOver: (
      conversationId: string,
      refusedSessionId: string | undefined,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM session_inputs
          WHERE ${buildTakeOverFilter(conversationId, refusedSessionId)} LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Checks whether the subscription has already stored an input for the
     * event, whatever became of the input since. A caller that delivers a
     * match through a path that cannot skip a duplicate asks this first, so an
     * event the router reads twice is delivered once.
     */
    hasMatchedInput: (match: SubscriptionMatch): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`SELECT 1 FROM session_inputs
            WHERE subscription_id = ${uuidFromString(match.subscriptionId)}
              AND event_id = ${match.eventId} LIMIT 1`,
        (rows) => rows.length > 0,
      ),

    /**
     * Checks whether a Subscription delivered the event `eventId` to a
     * session, whatever became of the input since.
     */
    hasInputForEvent: (eventId: number): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`SELECT 1 FROM session_inputs WHERE event_id = ${eventId} LIMIT 1`,
        (rows) => rows.length > 0,
      ),
  };
});

export const inputRepository = make;

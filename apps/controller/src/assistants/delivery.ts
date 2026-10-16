/**
 * How input reaches an assistant's conversation, whoever sends it: the
 * owner's message, a Scheduled Wake, or the flush turn of a rotation. Every
 * one of them goes to the conversation's newest session when it can still
 * take input, and a new session is placed when it cannot. A session can still
 * take input when it is not retired and is live, or has exited and can be
 * resumed. A retired session that is still live stores the input and keeps it
 * until it exits.
 *
 * The responder and the controller daemon's Scheduler both use this service,
 * so the rule for where input goes is written once.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { InvalidState } from "@hercule/contract";
import type { Rotation } from "@hercule/contract";
import type { ContextUsage } from "@hercule/protocol";
import type { Forbidden, InputSource, Unauthenticated, Validation } from "@hercule/contract";
import { withTransaction } from "../db";
import type { GrantsError } from "../permissions";
import type { RotateOutcome } from "../conversations";
import { SessionService, sessionRepository, type SubscriptionMatch } from "../sessions";
import type { SettingError } from "../settings";
import { assistantRepository } from "./repository";
import { AssistantSessions } from "./sessions";

/**
 * The standing instruction of a rotation's flush turn. The session records
 * what it should not forget before the conversation moves to a fresh session.
 */
export const FLUSH_TEXT =
  "This conversation is about to move to a fresh session, which starts with your memory and " +
  "none of this conversation. Record what is durable that is not yet in memory. Do not reply " +
  "to anyone.";

/** Everything giving input to a conversation can fail with. */
export type DeliveryError =
  | Unauthenticated
  | Forbidden
  | Validation
  | InvalidState
  | GrantsError
  | SettingError
  | SqlError
  | Schema.SchemaError;

/**
 * Checks whether a session's context has reached the assistant's rotation
 * threshold: `contextFraction` of the context window, capped at
 * `maxContextTokens`. When the harness reports no window, only the cap
 * applies.
 */
export const hasReachedRotationThreshold = (rotation: Rotation, context: ContextUsage): boolean =>
  context.tokens >=
  Math.min(
    rotation.maxContextTokens,
    context.windowTokens === undefined
      ? Number.POSITIVE_INFINITY
      : rotation.contextFraction * context.windowTokens,
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sessionRepository;
  const sessions = yield* SessionService;
  const assistantSessions = yield* AssistantSessions;
  const assistants = yield* assistantRepository;

  const rotate = (conversationId: string): Effect.Effect<RotateOutcome, DeliveryError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const newest = yield* rows.newestInConversation(conversationId);
        if (Option.isNone(newest)) return "nothing" as const;
        const session = newest.value;
        if (session.retiredAt !== null) return "requested" as const;
        if (!(yield* sessions.hasHadTurn(session.id))) return "nothing" as const;
        // The flush is given before the session is retired, because a retired
        // session that has exited is never resumed, and the flush resumes an
        // exited session in place. A flush that cannot be given leaves the
        // session retired without it: the savepoint undoes the partial write
        // of a resume that was refused part way.
        yield* withTransaction(
          sql,
          assistantSessions.give({
            sessionId: session.id,
            text: FLUSH_TEXT,
            source: "rotation",
          }),
        ).pipe(
          Effect.catchIf(
            (error) => error instanceof InvalidState,
            () => Effect.void,
          ),
        );
        yield* sessions.retire(session.id);
        return "requested" as const;
      }),
    );

  return {
    /**
     * Gives `text`, from `source`, to the conversation by the rule of where a
     * conversation's input goes (spec 12 section 5.1):
     *
     * - the newest session takes it when it can still take input, and an
     *   exited one is resumed for it;
     * - a newest session that is retired and still live stores it, and the
     *   input waits there until the session has exited and the next session
     *   takes it over. A heartbeat is the exception: it is skipped, because
     *   the next heartbeat reaches the next session;
     * - otherwise a new session is placed with it, which also takes over any
     *   input waiting on the conversation's earlier sessions.
     *
     * A request that carries the Subscription `match` it delivers has the
     * stored input record it, whichever of these paths takes it. Returns
     * `skipped` for that heartbeat and `given` for everything else.
     * Runs in its own savepoint, joining the caller's transaction, so a
     * delivery that fails part way leaves nothing behind. The frames go out
     * after the commit.
     */
    deliver: (request: {
      readonly conversationId: string;
      readonly assistantId: string;
      readonly source: InputSource;
      readonly text: string;
      readonly match?: SubscriptionMatch;
    }): Effect.Effect<"given" | "skipped", DeliveryError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const newest = yield* rows.newestInConversation(request.conversationId);
          if (Option.isSome(newest)) {
            const retiredAndLive =
              newest.value.retiredAt !== null && newest.value.status !== "exited";
            if (retiredAndLive && request.source === "heartbeat") return "skipped" as const;
            const given = yield* assistantSessions.give({
              sessionId: newest.value.id,
              text: request.text,
              source: request.source,
              ...(request.match === undefined ? {} : { match: request.match }),
            });
            if (given === "given") return "given" as const;
          }
          yield* assistantSessions.start(request);
          return "given" as const;
        }),
      ),

    /**
     * Rotates the conversation's newest session: retires it and queues its
     * flush turn, in one transaction. The flush runs after any turn already
     * running, and the session is stopped when its turns end. An exited
     * session is resumed for the flush. A session that cannot be resumed, or
     * whose resume is refused (`invalid_state`), is retired without a flush.
     * Joins the caller's transaction. See `RotateOutcome` for what it
     * returns. A session that is already retired counts as `requested`: the
     * next input starts the fresh session either way.
     */
    rotate,

    /**
     * Rotates the conversation of the session that reported `context` at a
     * turn's end, when that context has reached its assistant's threshold
     * (`hasReachedRotationThreshold`). A session that answers no assistant's conversation,
     * or is not its conversation's newest, is left alone. Joins the caller's
     * transaction.
     */
    rotateWhenContextFull: (
      sessionId: string,
      context: ContextUsage,
    ): Effect.Effect<void, DeliveryError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const session = yield* rows.one(sessionId);
          if (Option.isNone(session)) return;
          const { conversationId, agentId } = session.value;
          if (conversationId === null || agentId === null) return;
          const newest = yield* rows.newestInConversation(conversationId);
          if (Option.isNone(newest) || newest.value.id !== sessionId) return;
          const assistant = yield* assistants.read(agentId);
          if (
            Option.isNone(assistant) ||
            !hasReachedRotationThreshold(assistant.value.rotation, context)
          ) {
            return;
          }
          yield* rotate(conversationId);
        }),
      ),
  };
});

export class ConversationDelivery extends Context.Service<
  ConversationDelivery,
  Effect.Success<typeof make>
>()("hercule/controller/assistants/ConversationDelivery") {}

export const ConversationDeliveryLayer: Layer.Layer<
  ConversationDelivery,
  never,
  SqlClient.SqlClient | SessionService | AssistantSessions
> = Layer.effect(ConversationDelivery)(make);

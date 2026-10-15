/**
 * How input reaches an assistant's conversation, whoever sends it: the
 * owner's message, a Scheduled Wake, or the flush turn of a rotation. Every
 * one of them goes to the conversation's newest session, and a new session is
 * placed when that session cannot take it.
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
import type { Rotation } from "@hercule/contract";
import type { ContextUsage } from "@hercule/protocol";
import type {
  Forbidden,
  InputSource,
  InvalidState,
  Unauthenticated,
  Validation,
} from "@hercule/contract";
import { withTransaction } from "../db";
import type { GrantsError } from "../permissions";
import { sessionRepository } from "../sessions";
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
export type WakeError =
  | Unauthenticated
  | Forbidden
  | Validation
  | InvalidState
  | GrantsError
  | SettingError
  | SqlError
  | Schema.SchemaError;

/**
 * What a rotation request did:
 *
 * - `requested`: the flush turn is queued, or, for a session that cannot run
 *   it, the session is rotated at once;
 * - `underway`: a rotation of the newest session is already underway or
 *   done, and the next input starts the fresh session;
 * - `nothing`: the conversation has no session, or its session has had no
 *   turn, so there is nothing to rotate.
 */
export type RotateOutcome = "requested" | "underway" | "nothing";

/**
 * Checks whether a session's context has reached the assistant's rotation
 * threshold: `contextFraction` of the context window, capped at
 * `maxContextTokens`. When the harness reports no window, only the cap
 * applies.
 */
export const isContextFull = (rotation: Rotation, context: ContextUsage): boolean =>
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
  const sessions = yield* AssistantSessions;
  const assistants = yield* assistantRepository;

  const rotate = (conversationId: string): Effect.Effect<RotateOutcome, WakeError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const newest = yield* rows.newestInConversation(conversationId);
        if (Option.isNone(newest)) return "nothing" as const;
        const session = newest.value;
        if (session.rotatedAt !== null || (yield* sessions.isRotating(session.id))) {
          return "underway" as const;
        }
        if (!(yield* sessions.hasHadTurn(session.id))) return "nothing" as const;
        const given = yield* sessions.give({
          sessionId: session.id,
          text: FLUSH_TEXT,
          source: "rotation",
        });
        if (given === "unresumable") yield* sessions.markRotated(session.id);
        return "requested" as const;
      }),
    );

  return {
    /**
     * Gives `text`, from `source`, to the conversation's newest session, or
     * places a new session with it when there is none or the newest cannot
     * take it, because it is rotated or cannot be resumed. Runs in its own
     * savepoint, joining the caller's transaction, so a delivery that fails
     * part way leaves nothing behind. The frames go out after the commit.
     */
    wake: (request: {
      readonly conversationId: string;
      readonly assistantId: string;
      readonly source: InputSource;
      readonly text: string;
    }): Effect.Effect<void, WakeError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const newest = yield* rows.newestInConversation(request.conversationId);
          if (Option.isSome(newest)) {
            const given = yield* sessions.give({
              sessionId: newest.value.id,
              text: request.text,
              source: request.source,
            });
            if (given === "given") return;
          }
          yield* sessions.start(request);
        }),
      ),

    /**
     * Rotates the conversation's newest session: queues the flush turn, which
     * runs after any turn already running, and the rotation completes when
     * it ends. A session that exited and cannot be resumed cannot run the
     * flush, so it is rotated at once. Joins the caller's transaction. See
     * `RotateOutcome` for what it returns.
     */
    rotate,

    /**
     * Rotates the conversation of the session that reported `context` at a
     * turn's end, when that context has reached its assistant's threshold
     * (`isContextFull`). A session that answers no assistant's conversation,
     * or is not its conversation's newest, is left alone. Joins the caller's
     * transaction.
     */
    rotateWhenContextFull: (
      sessionId: string,
      context: ContextUsage,
    ): Effect.Effect<void, WakeError> =>
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
          if (Option.isNone(assistant) || !isContextFull(assistant.value.rotation, context)) {
            return;
          }
          yield* rotate(conversationId);
        }),
      ),
  };
});

export class ConversationWakes extends Context.Service<
  ConversationWakes,
  Effect.Success<typeof make>
>()("hercule/controller/assistants/ConversationWakes") {}

export const ConversationWakesLayer: Layer.Layer<
  ConversationWakes,
  never,
  SqlClient.SqlClient | AssistantSessions
> = Layer.effect(ConversationWakes)(make);

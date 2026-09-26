/**
 * How an assistant answers a message sent in its conversation: it gives the
 * text to the conversation's newest session, or starts a new session with
 * it.
 *
 * This is the assistants domain's implementation of the conversations
 * domain's `ConversationResponder` port. It lives in a file of its own and
 * does not use `ConversationService`: the conversation service needs this
 * layer, so needing that service back would make the two layers need each
 * other.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError } from "effect/unstable/sql/SqlError";
import {
  createInternalError,
  Forbidden,
  InvalidState,
  Unauthenticated,
  Validation,
} from "@hercule/contract";
import { agentRepository } from "../agents";
import type { ConversationMessages } from "../conversations";
import { ConversationResponder, type ResponderError } from "../conversations";
import { withTransaction } from "../db";
import { sessionRepository } from "../sessions";
import { buildUnreachableText, makeNoticeWriter } from "./notices";
import { AssistantSessions } from "./sessions";

/**
 * Converts the errors of placement that the sender cannot act on, such as an
 * unreadable setting or permission profile, into `Internal`, after logging
 * the cause. The errors the API explains to the sender, and database errors,
 * which every operation reports the same way, pass through unchanged.
 */
const hideInternalErrors = <E>(
  effect: Effect.Effect<void, E>,
): Effect.Effect<void, ResponderError> =>
  Effect.catch(effect, (error): Effect.Effect<never, ResponderError> =>
    error instanceof Unauthenticated ||
    error instanceof Forbidden ||
    error instanceof Validation ||
    isSqlError(error)
      ? Effect.fail(error)
      : Effect.andThen(
          Effect.logError("An assistant could not answer a message", error),
          Effect.fail(createInternalError("the assistant could not take the message")),
        ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sessionRepository;
  const agents = yield* agentRepository;
  const sessions = yield* AssistantSessions;
  const { appendNotice } = yield* makeNoticeWriter;

  return ConversationResponder.of({
    // Runs in the send's transaction, so two sends at once see each other's
    // session and the conversation gets one, not two.
    messageSent: (conversation, message) =>
      hideInternalErrors(
        Effect.gen(function* () {
          // A savepoint, so a delivery that fails part way leaves nothing
          // behind, and the notice below is the only write besides the
          // message itself.
          const delivered = withTransaction(
            sql,
            Effect.gen(function* () {
              const newest = yield* rows.newestInConversation(conversation.id);
              if (Option.isSome(newest)) {
                const given = yield* sessions.give({
                  sessionId: newest.value.id,
                  text: message.text,
                });
                if (given === "given") return;
                // The session has exited and cannot be resumed, for example
                // because its runner is draining. It is left as history, and
                // a new session answers the message instead. Nothing was
                // stored for the old session, so the owner gets one answer
                // and no notice.
              }
              yield* sessions.start({
                conversationId: conversation.id,
                assistantId: conversation.assistantId,
                text: message.text,
              });
            }),
          );
          // The message is kept either way: it is the conversation's record
          // of what the owner said. When no session can take it, for example
          // because no runner is connected, the conversation says so, and
          // the owner sends it again once the cause is fixed.
          yield* Effect.catchIf(
            delivered,
            (error): error is InvalidState => error instanceof InvalidState,
            (error) =>
              Effect.gen(function* () {
                const agent = yield* agents.read(conversation.assistantId);
                // The send read the conversation in this transaction, and an
                // assistant's agent row goes in the same transaction as its
                // conversations.
                if (Option.isNone(agent))
                  return yield* Effect.die("a conversation has no assistant");
                yield* appendNotice({
                  conversationId: conversation.id,
                  name: agent.value.name,
                  text: buildUnreachableText(agent.value.name, error.error.message),
                });
              }),
          );
        }),
      ),
  });
});

/**
 * Provides the conversations domain's `ConversationResponder`: an assistant
 * answers each message sent in its conversation. Boot provides it to the
 * conversation service.
 */
export const AssistantResponderLayer: Layer.Layer<
  ConversationResponder,
  never,
  SqlClient.SqlClient | AssistantSessions | ConversationMessages
> = Layer.effect(ConversationResponder)(make);

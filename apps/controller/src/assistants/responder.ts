/**
 * How an assistant answers a message sent in its conversation, and a request
 * to start the conversation fresh. `ConversationWakes` does the work: it
 * gives the text to the conversation's newest session, or starts a new
 * session with it.
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
import type * as SqlClient from "effect/unstable/sql/SqlClient";
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
import { buildUnreachableText, makeNoticeWriter } from "./notices";
import { ConversationWakes } from "./wakes";

/**
 * Converts the errors of placement that the sender cannot act on, such as an
 * unreadable setting or permission profile, into `Internal`, after logging
 * the cause. The errors the API explains to the sender, and database errors,
 * which every operation reports the same way, pass through unchanged.
 */
const hideInternalErrors = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, ResponderError> =>
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
  const agents = yield* agentRepository;
  const wakes = yield* ConversationWakes;
  const { appendNotice } = yield* makeNoticeWriter;

  return ConversationResponder.of({
    // Runs in the send's transaction, so two sends at once see each other's
    // session and the conversation gets one, not two.
    messageSent: (conversation, message) =>
      hideInternalErrors(
        Effect.gen(function* () {
          // A session that cannot take the message, for example because
          // its runner is draining, is left as history, and a new session
          // answers it instead, so the owner gets one answer and no notice.
          // The wake runs in a savepoint, so the notice below is the only
          // write besides the message itself.
          const delivered = wakes.wake({
            conversationId: conversation.id,
            assistantId: conversation.assistantId,
            source: "user",
            text: message.text,
          });
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

    // An `InvalidState` is the reason the session cannot take the request,
    // which the caller shows, so it is kept out of `hideInternalErrors`.
    rotate: (conversation) =>
      Effect.catch(
        wakes.rotate(conversation.id),
        (error): Effect.Effect<never, InvalidState | ResponderError> =>
          error instanceof InvalidState
            ? Effect.fail(error)
            : hideInternalErrors(Effect.fail(error)),
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
  SqlClient.SqlClient | ConversationWakes | ConversationMessages
> = Layer.effect(ConversationResponder)(make);

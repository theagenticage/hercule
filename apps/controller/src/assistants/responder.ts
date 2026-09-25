/**
 * How an assistant answers a message sent in its conversation: it gives the
 * text to the conversation's current session, or starts a new session with
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
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError } from "effect/unstable/sql/SqlError";
import {
  createInternalError,
  Forbidden,
  InvalidState,
  Unauthenticated,
  Validation,
} from "@hercule/contract";
import { ConversationResponder, type ResponderError } from "../conversations";
import { sessionRepository } from "../sessions";
import { readCurrentSession } from "./current-session";
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
    error instanceof InvalidState ||
    isSqlError(error)
      ? Effect.fail(error)
      : Effect.andThen(
          Effect.logError("An assistant could not answer a message", error),
          Effect.fail(createInternalError("the assistant could not take the message")),
        ),
  );

const make = Effect.gen(function* () {
  const rows = yield* sessionRepository;
  const sessions = yield* AssistantSessions;

  return ConversationResponder.of({
    // Runs in the send's transaction, so two sends at once see each other's
    // session and the conversation gets one, not two.
    messageSent: (conversation, message) =>
      hideInternalErrors(
        Effect.gen(function* () {
          const current = yield* readCurrentSession(rows, conversation.id);
          if (Option.isSome(current)) {
            const given = yield* sessions.give({
              sessionId: current.value.id,
              text: message.text,
            });
            if (given === "given") return;
            // The session has exited and cannot be resumed, for example
            // because its runner is draining. It is left as history, and a
            // new session answers the message instead. Nothing was stored
            // for the old session, so the user gets one answer and no notice.
          }
          yield* sessions.start({
            conversationId: conversation.id,
            assistantId: conversation.assistantId,
            text: message.text,
          });
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
  SqlClient.SqlClient | AssistantSessions
> = Layer.effect(ConversationResponder)(make);

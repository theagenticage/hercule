/**
 * The port through which a conversation hands each sent message to whoever
 * answers it.
 *
 * It is declared here, in the conversations domain's own words ("a message
 * was sent in this conversation"), and implemented by the domain that
 * answers, so this domain never imports that domain. Boot provides the
 * implementation.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  Conversation,
  ConversationMessage,
  Forbidden,
  Internal,
  Unauthenticated,
  Validation,
} from "@hercule/contract";

/**
 * The errors a responder may refuse a sent message with. `Internal` stands
 * for a failure the sender cannot act on, such as an unreadable setting; the
 * responder logs the cause before it fails.
 */
export type ResponderError = Unauthenticated | Forbidden | Validation | Internal | SqlError;

/** The party that answers the messages sent in a conversation. */
export class ConversationResponder extends Context.Service<
  ConversationResponder,
  {
    /**
     * Hands a message that was just stored to the conversation's answering
     * party. It runs inside the send's transaction, after the insert, so a
     * failure rolls the message back. It must not wait on anything outside
     * the database: work that reaches a runner is scheduled after commit.
     */
    readonly messageSent: (
      conversation: Conversation,
      message: ConversationMessage,
    ) => Effect.Effect<void, ResponderError>;
  }
>()("hercule/controller/conversations/ConversationResponder") {}

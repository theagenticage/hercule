/**
 * The service that appends a message to a conversation. Every writer of a
 * message goes through it: the owner's send, an assistant's reply, and a
 * notice that an assistant was interrupted or can't be reached.
 *
 * This is a service of its own, apart from `ConversationService`, because
 * the writers of replies and notices sit below the conversation service in
 * the layer graph. The conversation service hands each sent message to the
 * responder, the responder reaches sessions through the controller daemon,
 * and the sessions domain reports a session's end, which may write a notice.
 * A notice written through the conversation service would make those layers
 * need each other.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ConversationMessage, ConversationSenderRole } from "@hercule/contract";
import { currentStampOrSystem } from "../actor";
import { announce, nowIso } from "../db";
import { messageRepository } from "./message-repository";

/** A message to append to a conversation. */
interface NewConversationMessage {
  readonly conversationId: string;
  readonly senderRole: ConversationSenderRole;
  /** The owner's username, or the assistant's name when the message is written. */
  readonly senderLabel: string;
  readonly text: string;
  /** The session that produced the message. Absent on an owner's message. */
  readonly sessionId?: string;
  /**
   * The turn that produced the message. Absent on an owner's message, and on
   * a notice about a session that ended with no turn open.
   */
  readonly turnId?: string;
  /**
   * The actor stamp to store on the message. When absent, the message is
   * stamped with the actor the caller runs as, or with the system when the
   * caller runs as no actor.
   */
  readonly actor?: string;
}

const make = Effect.gen(function* () {
  const messages = yield* messageRepository;

  return {
    /**
     * Appends a message at the conversation's next position, returns it, and
     * nudges the `conversation` topic. Joins the caller's transaction.
     *
     * The message is stamped with `message.actor` when it is given, and
     * otherwise with the actor the caller runs as. So the caller decides who
     * wrote the message, and this domain never has to know what a sender role
     * or a session means for the stamp.
     */
    append: (message: NewConversationMessage): Effect.Effect<ConversationMessage, SqlError> =>
      Effect.gen(function* () {
        const stored = yield* messages.insert({
          conversationId: message.conversationId,
          // Only the web channel exists, and it has no containers.
          containerKey: null,
          senderRole: message.senderRole,
          senderLabel: message.senderLabel,
          text: message.text,
          sessionId: message.sessionId ?? null,
          turnId: message.turnId ?? null,
          actor: message.actor ?? (yield* currentStampOrSystem),
          at: yield* nowIso,
        });
        yield* announce({
          _tag: "record",
          topic: "conversation",
          id: message.conversationId,
          kind: "updated",
        });
        return stored;
      }),
  };
});

/** Appends messages to conversations. Every writer of a message goes through it. */
export class ConversationMessages extends Context.Service<
  ConversationMessages,
  Effect.Success<typeof make>
>()("hercule/controller/conversations/ConversationMessages") {}

export const ConversationMessagesLayer: Layer.Layer<
  ConversationMessages,
  never,
  SqlClient.SqlClient
> = Layer.effect(ConversationMessages)(make);

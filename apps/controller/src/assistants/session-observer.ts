/**
 * The assistants domain's implementation of the sessions domain's
 * `SessionObserver` port: what an assistant's sessions write into its
 * conversation.
 *
 * - A report writes the replies the assistant's reply mode takes from it.
 * - An exit while a turn is running writes "<name> was interrupted: <why>".
 *   Any other exit writes nothing, an idle unload included: the session is
 *   resumed for whatever waits, and nobody was cut off.
 * - Input dropped because the session cannot be resumed writes "<name> can't
 *   be reached: <why>".
 *
 * A session that answers no conversation, or whose assistant is gone, writes
 * nothing, so a late report from a deleted assistant's session is ignored.
 *
 * It is not part of `AssistantService`, because the session service needs it
 * and the assistant service needs the session service. A reply is stamped
 * with the session that wrote it, and a notice with the system.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProviderEvent } from "@hercule/protocol";
import type { AssistantReply } from "@hercule/contract";
import { buildSessionStamp } from "../actor";
import type { ConversationMessages } from "../conversations";
import { readAssistantTexts, SessionObserver, type StoredSession } from "../sessions";
import { buildInterruptedText, buildUnreachableText, makeNoticeWriter } from "./notices";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { conversationMessages, readAnsweredConversation, appendNotice } = yield* makeNoticeWriter;

  /**
   * Returns the texts the reply mode turns into replies for one report, in
   * the order they are written:
   *
   * - `turn-end`, when the turn completes: the turn's last assistant text.
   *   The texts before it are the narration between tool calls, and the
   *   last one is the answer.
   * - `turn-end`, when the turn fails or is interrupted: every assistant text
   *   of the turn, in order, as one reply with a blank line between texts.
   *   A turn cut short has no answer, so its last text is just the fragment
   *   that happened to follow the last tool call. Showing all of it shows
   *   the owner everything the assistant said.
   * - `segments`: when an assistant message is completed, its text.
   *
   * A report of anything else, or with no assistant text, gives none. The
   * texts are read from the transcript rows the report has just written.
   */
  const readReplyTexts = (
    session: StoredSession,
    event: ProviderEvent,
    reply: AssistantReply,
  ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.gen(function* () {
      if (reply === "turn-end" && event._tag === "turn.completed") {
        const texts = (yield* readAssistantTexts(sql, session.id, event.turnId)).map(
          (item) => item.text,
        );
        if (event.state === "completed") return texts.slice(-1);
        const partialReply = texts.filter((text) => text !== "").join("\n\n");
        return partialReply === "" ? [] : [partialReply];
      }
      if (
        reply === "segments" &&
        event._tag === "item.completed" &&
        event.kind === "assistant_message" &&
        event.status === "completed"
      ) {
        const texts = yield* readAssistantTexts(sql, session.id, event.turnId, event.itemId);
        return texts.map((item) => item.text);
      }
      return [];
    });

  return SessionObserver.of({
    sessionReported: (session, event) =>
      Effect.gen(function* () {
        // Only a turn's end and a completed assistant message can produce a
        // reply, so every other report returns before anything is read.
        const mayProduceReplies =
          event._tag === "turn.completed" ||
          (event._tag === "item.completed" && event.kind === "assistant_message");
        if (!mayProduceReplies) return;
        const answered = yield* readAnsweredConversation(session);
        if (Option.isNone(answered)) return;
        for (const text of yield* readReplyTexts(session, event, answered.value.reply)) {
          if (text === "") continue;
          yield* conversationMessages.append({
            conversationId: answered.value.conversationId,
            senderRole: "assistant",
            senderLabel: answered.value.name,
            text,
            sessionId: session.id,
            turnId: event.turnId,
            actor: buildSessionStamp(session.id),
          });
        }
      }),

    sessionExited: (exit) =>
      Effect.gen(function* () {
        // Only a running turn has someone waiting on its reply. Whatever else
        // waits for the session is kept and goes to the resumed process, or
        // is dropped with its own notice when the session cannot be resumed.
        if (exit.session.status !== "busy") return;
        const answered = yield* readAnsweredConversation(exit.session);
        if (Option.isNone(answered)) return;
        yield* appendNotice({
          conversationId: answered.value.conversationId,
          name: answered.value.name,
          text: buildInterruptedText(answered.value.name, exit.reason, exit.message),
          sessionId: exit.session.id,
        });
      }),

    inputsDropped: (session, refusal) =>
      Effect.gen(function* () {
        const answered = yield* readAnsweredConversation(session);
        if (Option.isNone(answered)) return;
        yield* appendNotice({
          conversationId: answered.value.conversationId,
          name: answered.value.name,
          text: buildUnreachableText(
            answered.value.name,
            `its session could not be resumed (${refusal}); ` +
              "send the message again to start a new session",
          ),
          sessionId: session.id,
        });
      }),
  });
});

/**
 * Provides the sessions domain's `SessionObserver`: an assistant's sessions
 * write their replies and notices into its conversation. Boot provides it to
 * the session service.
 */
export const AssistantSessionObserverLayer: Layer.Layer<
  SessionObserver,
  never,
  SqlClient.SqlClient | ConversationMessages
> = Layer.effect(SessionObserver)(make);

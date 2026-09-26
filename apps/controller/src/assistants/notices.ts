/**
 * The notices an assistant's conversation gets, and the reader of the
 * conversation a session answers, shared by the two writers of notices: the
 * session observer and the responder.
 *
 * There are exactly two notices, and no caller writes the wording itself:
 *
 * - "<name> was interrupted: <why>", when a session exits while a turn is
 *   running, so a reply was cut off;
 * - "<name> can't be reached: <why>", when a message could not be delivered:
 *   no session could take it, or the session that held it ended and cannot
 *   be resumed.
 *
 * A notice is stamped with the system.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AssistantReply } from "@hercule/contract";
import { SYSTEM_ACTOR } from "../actor";
import { agentRepository } from "../agents";
import { ConversationMessages } from "../conversations";
import type { SessionEndReason, StoredSession } from "../sessions";
import { assistantRepository } from "./repository";

/** Why a session exited, as it reads after "was interrupted:" in a notice. */
const EXIT_REASON_TEXTS: Record<SessionEndReason, string> = {
  crash: "its session crashed",
  process_exit: "its harness process exited",
  stopped: "its session was stopped",
  idle_unload: "its session was unloaded while idle",
  runner_restart: "its runner restarted",
  inactivity_timeout: "its session timed out",
  absolute_timeout: "its session reached its time limit",
  workspace_failed: "its workspace could not be made",
  runner_retired: "its runner was retired",
  runner_lost: "its runner could not be reached",
};

/**
 * Builds the notice text for a turn cut off by a session's exit. `message` is
 * the runner's error, when it gave one.
 */
export const buildInterruptedText = (
  name: string,
  reason: SessionEndReason,
  message: string | undefined,
): string =>
  `${name} was interrupted: ${EXIT_REASON_TEXTS[reason]}${message === undefined ? "" : `: ${message}`}`;

/** Builds the notice text for a message that could not be delivered, for the reason `why`. */
export const buildUnreachableText = (name: string, why: string): string =>
  `${name} can't be reached: ${why}`;

/** The conversation a session answers, and its assistant's name and reply mode. */
export interface AnsweredConversation {
  readonly conversationId: string;
  readonly name: string;
  readonly reply: AssistantReply;
}

/**
 * Builds the reader of the conversation a session answers, and the append of
 * a notice to a conversation.
 */
export const makeNoticeWriter = Effect.gen(function* () {
  const agents = yield* agentRepository;
  const assistants = yield* assistantRepository;
  const conversationMessages = yield* ConversationMessages;

  /**
   * Returns the conversation the session answers and its assistant's name
   * and reply mode. Returns `none` for a session that answers no
   * conversation, or whose assistant is gone. An assistant's conversations
   * are deleted in the same transaction as the assistant, so an assistant
   * that is still there means its conversation is too.
   */
  const readAnsweredConversation = (
    session: StoredSession,
  ): Effect.Effect<Option.Option<AnsweredConversation>, SqlError> =>
    Effect.gen(function* () {
      if (session.conversationId === null || session.agentId === null) return Option.none();
      const agent = yield* agents.read(session.agentId);
      const fields = yield* assistants.read(session.agentId);
      if (Option.isNone(agent) || Option.isNone(fields)) return Option.none();
      return Option.some({
        conversationId: session.conversationId,
        name: agent.value.name,
        reply: fields.value.reply,
      });
    });

  /**
   * Appends a notice with `text` to the conversation, from the assistant
   * named `name`, stamped with the system. `sessionId` is the session the
   * notice is about, when there is one. Joins the caller's transaction.
   */
  const appendNotice = (notice: {
    readonly conversationId: string;
    readonly name: string;
    readonly text: string;
    readonly sessionId?: string;
  }): Effect.Effect<void, SqlError> =>
    Effect.asVoid(
      conversationMessages.append({
        conversationId: notice.conversationId,
        senderRole: "notice",
        senderLabel: notice.name,
        text: notice.text,
        ...(notice.sessionId === undefined ? {} : { sessionId: notice.sessionId }),
        actor: SYSTEM_ACTOR,
      }),
    );

  return { conversationMessages, readAnsweredConversation, appendNotice };
});

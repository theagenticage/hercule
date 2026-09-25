/**
 * The conversation messages an assistant's sessions produce: the replies its
 * reply mode takes from a turn, and the notices written when someone is left
 * waiting without an answer.
 *
 * Two services live here, and both write through `ConversationMessages`:
 *
 * - `AssistantMessages` writes what a runner's report produces, and the
 *   notice for input a session could not be resumed for. The controller
 *   daemon calls it.
 * - `AssistantSessionEndings` implements the sessions domain's
 *   `SessionEndings` port. The sessions domain calls it for every session
 *   that ends, whatever ended it, and it writes the notice when the session
 *   ended with someone still waiting.
 *
 * Neither is part of `AssistantService`, because their callers sit below the
 * assistant service in the layer graph. The assistant service needs the
 * controller daemon, through `AssistantSessions`, and the controller daemon
 * needs the sessions domain, so writing these messages there would make those
 * layers need each other.
 *
 * A reply is stamped with the session that wrote it, and a notice with the
 * system.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProviderEvent } from "@hercule/protocol";
import type { AssistantReply } from "@hercule/contract";
import { buildActorStamp, SYSTEM_ACTOR } from "../actor";
import { agentRepository } from "../agents";
import { ConversationMessages } from "../conversations";
import { withTransaction } from "../db";
import {
  readAssistantTexts,
  SessionEndings,
  SessionService,
  sessionRepository,
  type SessionEnding,
  type SessionEndReason,
  type StoredSession,
} from "../sessions";
import { assistantRepository } from "./repository";

/**
 * Why an assistant couldn't answer. A notice is built from it, and no caller
 * writes the wording itself:
 *
 * - `sessionEnded`: the session ended with someone waiting; `message` is the
 *   runner's error, for a workspace that could not be made;
 * - `turnFailed`: the turn failed, with the harness's error when it gave one;
 * - `turnInterrupted`: the turn was interrupted;
 * - `sessionUnresumable`: input was waiting for an unloaded session, and the
 *   session could not be resumed, for the reason in `refusal`.
 */
type Unanswered =
  | {
      readonly _tag: "sessionEnded";
      readonly reason: Exclude<SessionEndReason, "idle_unload">;
      readonly message?: string;
    }
  | { readonly _tag: "turnFailed"; readonly error?: string }
  | { readonly _tag: "turnInterrupted" }
  | { readonly _tag: "sessionUnresumable"; readonly refusal: string };

/** Why a session ended, as it reads after "couldn't answer:" in a notice. */
const SESSION_ENDED_TEXTS: Record<Exclude<SessionEndReason, "idle_unload">, string> = {
  crash: "its session crashed",
  process_exit: "its harness process exited",
  stopped: "its session was stopped",
  runner_restart: "its runner restarted",
  inactivity_timeout: "its session timed out",
  absolute_timeout: "its session reached its time limit",
  workspace_failed: "its workspace could not be made",
  runner_retired: "its runner was retired",
  runner_lost: "its runner could not be reached",
};

/** Builds the text of a notice that the assistant named `name` couldn't answer. */
const buildNoticeText = (name: string, unanswered: Unanswered): string => {
  const why = (() => {
    switch (unanswered._tag) {
      case "sessionEnded":
        return unanswered.message === undefined
          ? SESSION_ENDED_TEXTS[unanswered.reason]
          : `${SESSION_ENDED_TEXTS[unanswered.reason]}: ${unanswered.message}`;
      case "turnFailed":
        return unanswered.error ?? "the turn failed";
      case "turnInterrupted":
        return "the turn was interrupted";
      case "sessionUnresumable":
        return (
          `its session could not be resumed (${unanswered.refusal}); ` +
          "send the message again to start a new session"
        );
    }
  })();
  return `${name} couldn't answer: ${why}`;
};

/**
 * Returns why the assistant couldn't answer, for a session that ended with
 * someone still waiting, or `undefined` when nobody is left waiting. Someone
 * is waiting when:
 *
 * - the session was queued, starting or busy when it ended; or
 * - an input from the owner had no turn started from it: still queued, sent
 *   to the runner or not, or accepted by the runner before a turn started.
 *
 * An idle unload leaves nobody waiting, whatever was queued: the session is
 * resumed for its queued input.
 */
const findUnansweredEnding = (ending: SessionEnding): Unanswered | undefined => {
  if (ending.reason === "idle_unload") return undefined;
  const status = ending.session.status;
  const waiting =
    status === "queued" ||
    status === "starting" ||
    status === "busy" ||
    ending.unansweredInputs.some((input) => input.source === "user");
  if (!waiting) return undefined;
  return {
    _tag: "sessionEnded",
    reason: ending.reason,
    ...(ending.message === undefined ? {} : { message: ending.message }),
  };
};

/**
 * Returns why the assistant couldn't answer, for a turn that ended without an
 * answer, or `undefined` for any other report.
 */
const findUnansweredTurn = (event: ProviderEvent): Unanswered | undefined => {
  if (event._tag !== "turn.completed") return undefined;
  if (event.state === "failed") {
    return { _tag: "turnFailed", ...(event.error === undefined ? {} : { error: event.error }) };
  }
  if (event.state === "interrupted") return { _tag: "turnInterrupted" };
  return undefined;
};

/** The conversation a session answers, and its assistant's name and reply mode. */
interface AnsweredConversation {
  readonly conversationId: string;
  readonly name: string;
  readonly reply: AssistantReply;
}

/**
 * Builds the notice writer both services share: the reader of the
 * conversation a session answers, and the append of a notice.
 */
const makeNoticeWriter = Effect.gen(function* () {
  const agents = yield* agentRepository;
  const assistants = yield* assistantRepository;
  const conversationMessages = yield* ConversationMessages;

  /**
   * Returns the conversation the session answers and its assistant's name
   * and reply mode. Returns `none` for a session that answers no
   * conversation, or whose assistant is gone.
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

  /** Appends a notice that the assistant couldn't answer, stamped with the system. */
  const appendNotice = (
    session: StoredSession,
    answered: AnsweredConversation,
    unanswered: Unanswered,
    turnId: string | undefined,
  ): Effect.Effect<void, SqlError> =>
    Effect.asVoid(
      conversationMessages.append({
        conversationId: answered.conversationId,
        senderRole: "notice",
        senderLabel: answered.name,
        text: buildNoticeText(answered.name, unanswered),
        sessionId: session.id,
        ...(turnId === undefined ? {} : { turnId }),
        actor: SYSTEM_ACTOR,
      }),
    );

  return { conversationMessages, readAnsweredConversation, appendNotice };
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const sessionRows = yield* sessionRepository;
  const { conversationMessages, readAnsweredConversation, appendNotice } = yield* makeNoticeWriter;

  /**
   * Returns the texts the reply mode turns into replies for one report, in
   * the order they are written:
   *
   * - `turn-end`: when the turn ends, however it ends, the turn's last
   *   assistant text;
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
        const texts = yield* readAssistantTexts(sql, session.id, event.turnId);
        return texts.slice(-1).map((last) => last.text);
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

  return {
    /**
     * Writes the conversation messages one runner report produces: the
     * replies the assistant's reply mode gives, then a notice when a turn
     * failed or was interrupted. Only a turn's end and a completed assistant
     * message can produce any, so every other report returns at once, before
     * anything is read. A session's exit is not handled here: the sessions
     * domain reports every end through `SessionEndings`.
     *
     * Does nothing for a session that answers no conversation, or whose
     * assistant is gone. Joins the caller's transaction, which has already
     * written the report's transcript rows.
     */
    recordSessionReport: (
      session: StoredSession,
      event: ProviderEvent,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const mayProduceMessages =
          event._tag === "turn.completed" ||
          (event._tag === "item.completed" && event.kind === "assistant_message");
        if (!mayProduceMessages) return;
        const answered = yield* readAnsweredConversation(session);
        if (Option.isNone(answered)) return;
        const replyStamp = buildActorStamp({
          _tag: "session",
          sessionId: session.id,
          profileId: session.permissionProfileId,
          grants: [],
        });
        for (const text of yield* readReplyTexts(session, event, answered.value.reply)) {
          if (text === "") continue;
          yield* conversationMessages.append({
            conversationId: answered.value.conversationId,
            senderRole: "assistant",
            senderLabel: answered.value.name,
            text,
            sessionId: session.id,
            turnId: event.turnId,
            actor: replyStamp,
          });
        }
        const unanswered = findUnansweredTurn(event);
        if (unanswered === undefined) return;
        yield* appendNotice(session, answered.value, unanswered, event.turnId);
      }),

    /**
     * Handles the input waiting for an exited session that cannot be resumed.
     * `refusal` is the reason the resume was refused.
     *
     * - A session that answers no conversation, such as a Thread, keeps its
     *   input queued, where its reader can see it was not delivered and
     *   cancel it.
     * - A session that answers a conversation has its waiting input
     *   cancelled, and the conversation gets a notice that the assistant
     *   couldn't answer. Nobody reads that session's inputs: the owner reads
     *   the conversation, so input left queued there would vanish without a
     *   word. The owner's next message starts a new session.
     *
     * Runs in its own transaction, and reads the session again inside it, so
     * input that a resume by another caller is about to send is never
     * cancelled.
     */
    dropUnresumableInput: (
      session: StoredSession,
      refusal: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        if (session.conversationId === null) return;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const now = yield* sessionRows.one(session.id);
            if (Option.isNone(now) || now.value.status !== "exited") return;
            const cancelled = yield* sessions.cancelWaitingInputs(
              session.id,
              `the session could not be resumed: ${refusal}`,
            );
            if (cancelled === 0) return;
            const answered = yield* readAnsweredConversation(session);
            if (Option.isNone(answered)) return;
            yield* appendNotice(
              session,
              answered.value,
              { _tag: "sessionUnresumable", refusal },
              undefined,
            );
          }),
        );
      }),
  };
});

/** Writes the conversation messages an assistant's sessions produce. */
export class AssistantMessages extends Context.Service<
  AssistantMessages,
  Effect.Success<typeof make>
>()("hercule/controller/assistants/AssistantMessages") {}

export const AssistantMessagesLayer: Layer.Layer<
  AssistantMessages,
  never,
  SqlClient.SqlClient | ConversationMessages | SessionService
> = Layer.effect(AssistantMessages)(make);

/**
 * Implements the sessions domain's `SessionEndings` port: a session that
 * answers a conversation and ends with someone waiting leaves a notice in the
 * conversation. It does not need `SessionService`, because `SessionService`
 * needs it. Boot provides it to the session service.
 */
export const AssistantSessionEndingsLayer: Layer.Layer<
  SessionEndings,
  never,
  SqlClient.SqlClient | ConversationMessages
> = Layer.effect(SessionEndings)(
  Effect.gen(function* () {
    const { readAnsweredConversation, appendNotice } = yield* makeNoticeWriter;
    return SessionEndings.of({
      sessionEnded: (ending) =>
        Effect.gen(function* () {
          const unanswered = findUnansweredEnding(ending);
          if (unanswered === undefined) return;
          const answered = yield* readAnsweredConversation(ending.session);
          if (Option.isNone(answered)) return;
          yield* appendNotice(ending.session, answered.value, unanswered, undefined);
        }),
    });
  }),
);

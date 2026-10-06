/**
 * Conversations: one exchange with an assistant in one channel container.
 *
 * Every assistant has exactly one web conversation, created with it. The web
 * channel has no containers, so `containerKey` is null there; channels that
 * do have them, such as a Discord server's channels, arrive later.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { Prompt } from "./session";

/** The channels a conversation can be in. The web channel is the only one so far. */
export const ConversationChannel = Schema.Literal("web");

export type ConversationChannel = Schema.Schema.Type<typeof ConversationChannel>;

export const Conversation = Schema.Struct({
  id: Id,
  /** The assistant that answers here. */
  assistantId: Id,
  channel: ConversationChannel,
  /** The container within the channel, such as a Discord channel; null for the web channel. */
  containerKey: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
});

export type Conversation = Schema.Schema.Type<typeof Conversation>;

/** What a conversation listing may be sorted by. */
export const CONVERSATION_SORT_FIELDS = ["createdAt"] as const;

/** The filters of `conversation.query`. */
export const ConversationFilter = Schema.Struct({
  /** Only the conversations this assistant answers. */
  assistantId: Schema.optionalKey(Id),
});

/**
 * Who wrote a conversation message: the owner, the assistant that answers, or
 * the system telling the owner that the assistant could not answer.
 */
export const ConversationSenderRole = Schema.Literals(["owner", "assistant", "notice"]);

export type ConversationSenderRole = Schema.Schema.Type<typeof ConversationSenderRole>;

/** One message of a conversation: what the owner said, a reply, or a notice. */
export const ConversationMessage = Schema.Struct({
  id: Id,
  conversationId: Id,
  /** The container within the channel the message was sent in; null for the web channel. */
  containerKey: Schema.NullOr(Schema.String),
  /** The message's place in its conversation: 1 for the first, one higher for each after it. */
  position: Schema.Int,
  senderRole: ConversationSenderRole,
  /**
   * The owner's username on an owner message; the assistant's name, as it
   * was when the message was written, on a reply or a notice. A rename does
   * not rewrite old messages.
   */
  senderLabel: Schema.String,
  text: Schema.String,
  /** The session that produced a reply or a notice; null on an owner message. */
  sessionId: Schema.NullOr(Id),
  /**
   * The turn that produced a reply. Null on an owner message and on every
   * notice. In `segments` reply mode, every reply a turn produces carries
   * that turn's id.
   */
  turnId: Schema.NullOr(Schema.String),
  /** Who wrote the message: `user`, `session:<id>`, or the system's stamp. */
  actor: Schema.String,
  createdAt: Timestamp,
});

export type ConversationMessage = Schema.Schema.Type<typeof ConversationMessage>;

/** What a message listing may be sorted by. */
export const MESSAGE_SORT_FIELDS = ["position"] as const;

/** The payload of `conversation.send`: the same text `session.input` takes. */
export const ConversationSendInput = Schema.Struct({ text: Prompt });

export type ConversationSendInput = Schema.Schema.Type<typeof ConversationSendInput>;

export const conversation = HttpApiGroup.make("conversation")
  .add(
    HttpApiEndpoint.get("query", "/conversations", {
      query: Schema.Struct({
        ...ConversationFilter.fields,
        ...pageParams(CONVERSATION_SORT_FIELDS).fields,
      }),
      success: page(Conversation),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/conversations/:id", {
      params: { id: Id },
      success: Conversation,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.get("queryMessages", "/conversations/:id/messages", {
      params: { id: Id },
      query: pageParams(MESSAGE_SORT_FIELDS),
      success: page(ConversationMessage),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("send", "/conversations/:id/messages", {
      params: { id: Id },
      payload: ConversationSendInput,
      success: ConversationMessage,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);

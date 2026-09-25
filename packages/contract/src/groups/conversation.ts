/**
 * Conversations: one exchange with an assistant in one channel container.
 *
 * Every assistant has exactly one web conversation, created with it. The web
 * channel has no containers, so `containerKey` is null there; channels that
 * do have them, such as a chat's rooms, arrive later.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";

/** The channels a conversation can be in. The web chat is the only one so far. */
export const ConversationChannel = Schema.Literal("web");

export type ConversationChannel = Schema.Schema.Type<typeof ConversationChannel>;

export const Conversation = Schema.Struct({
  id: Id,
  /** The assistant that answers here. */
  assistantId: Id,
  channel: ConversationChannel,
  /** The container within the channel, such as a chat room; null for the web chat. */
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
  )
  .middleware(Authenticated);

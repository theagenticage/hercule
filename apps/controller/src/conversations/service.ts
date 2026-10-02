/**
 * The conversation operations (`conversation.query`, `read`, `queryMessages`
 * and `send`), and the conversation writes that the domain implementing
 * `ConversationResponder` makes when the answering party is created or
 * deleted. Appending a message is `ConversationMessages`, which `send` uses
 * too.
 *
 * A conversation is one exchange in one channel container. This domain is a
 * plain messenger: it stores what is said and hands each sent message to
 * whoever answers, through `ConversationResponder`. It knows the answering
 * party only as an id, `assistantId`, which it stores, filters on and passes
 * along. It never reads the assistant, so it does not depend on the
 * assistants domain.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  CONVERSATION_SORT_FIELDS,
  ConversationFilter,
  ConversationSendInput,
  DEFAULT_PAGE_LIMIT,
  Id,
  MESSAGE_SORT_FIELDS,
  createDecodeValidationError,
  createForbiddenError,
  createNotFoundError,
  type Conversation,
  type ConversationMessage,
  type Forbidden,
  type NotFound,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import {
  announce,
  buildPageInputFields,
  nowIso,
  refuseCursor,
  resolveSortDirection,
  withTransaction,
} from "../db";
import { Users } from "../users";
import { ConversationMessages } from "./conversation-messages";
import { messageRepository } from "./message-repository";
import { conversationRepository, type NewConversation } from "./repository";
import { ConversationResponder, type ResponderError } from "./responder";

const QueryInput = Schema.Struct({
  ...ConversationFilter.fields,
  ...buildPageInputFields(CONVERSATION_SORT_FIELDS),
});

export type ConversationQueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);

const MessageQueryInput = Schema.Struct({
  conversationId: Id,
  ...buildPageInputFields(MESSAGE_SORT_FIELDS),
});

export type ConversationMessageQueryInput = Schema.Schema.Type<typeof MessageQueryInput>;

const decodeMessageQuery = Schema.decodeUnknownEffect(MessageQueryInput);

const SendInput = Schema.Struct({ conversationId: Id, ...ConversationSendInput.fields });

const decodeSend = Schema.decodeUnknownEffect(SendInput);

export interface ConversationPage {
  readonly items: ReadonlyArray<Conversation>;
  readonly nextCursor?: string;
}

export interface ConversationMessagePage {
  readonly items: ReadonlyArray<ConversationMessage>;
  readonly nextCursor?: string;
}

/** Oldest first: a list of conversations is read in the order they began. */
const DEFAULT_DIRECTION: SortDirection = "asc";

/** Newest first: a conversation opens on its latest messages and pages back in time. */
const DEFAULT_MESSAGE_DIRECTION: SortDirection = "desc";

const NO_SUCH_CONVERSATION = "no such conversation";

/**
 * The refusal of a send by anyone but the user. The message is stored as the
 * owner's, so an agent that held the grant could otherwise speak for the user.
 */
const OWNER_ONLY =
  "conversation.send records the message as the owner's; only the user can send it";

/** The errors every operation can fail with. */
type ReadError = Unauthenticated | Forbidden | SqlError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const conversations = yield* conversationRepository;
  const messages = yield* messageRepository;
  const users = yield* Users;
  const responder = yield* ConversationResponder;
  const conversationMessages = yield* ConversationMessages;

  const readConversationOrFail = (id: string): Effect.Effect<Conversation, NotFound | SqlError> =>
    Effect.flatMap(conversations.read(id), (conversation) =>
      Option.isNone(conversation)
        ? Effect.fail(createNotFoundError(NO_SUCH_CONVERSATION))
        : Effect.succeed(conversation.value),
    );

  /** Records a change to the conversation for the live topic, once the transaction commits. */
  const nudge = (id: string, kind: "created" | "updated" | "deleted"): Effect.Effect<void> =>
    announce({ _tag: "record", topic: "conversation", id, kind });

  return {
    /**
     * Returns a page of conversations, oldest first by default. With
     * `assistantId`, returns only the conversations that assistant answers;
     * an id that names no assistant gives an empty page.
     */
    query: (
      input: ConversationQueryInput,
    ): Effect.Effect<ConversationPage, ReadError | Validation> =>
      Effect.gen(function* () {
        yield* requireGrant("conversation.query");
        const { limit, cursor, sort, assistantId } = yield* Effect.mapError(
          decodeQuery(input),
          createDecodeValidationError,
        );
        const listing = yield* refuseCursor(
          conversations.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, DEFAULT_DIRECTION),
            assistantId,
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /** Returns the conversation with this id. Fails with `NotFound` when there is none. */
    read: (id: string): Effect.Effect<Conversation, ReadError | NotFound> =>
      Effect.andThen(requireGrant("conversation.read"), readConversationOrFail(id)),

    /**
     * Returns a page of the conversation's messages, newest first by default.
     * Fails with `NotFound` for an unknown conversation, and with
     * `Validation` for a malformed request or a cursor from another listing.
     */
    queryMessages: (
      input: ConversationMessageQueryInput,
    ): Effect.Effect<ConversationMessagePage, ReadError | Validation | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("conversation.queryMessages");
        const { conversationId, limit, cursor, sort } = yield* Effect.mapError(
          decodeMessageQuery(input),
          createDecodeValidationError,
        );
        yield* readConversationOrFail(conversationId);
        const listing = yield* refuseCursor(
          messages.list({
            conversationId,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, DEFAULT_MESSAGE_DIRECTION),
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * Appends `text` as the owner's message, hands it to the responder, and
     * returns the stored message. Both happen in one transaction, so when the
     * responder refuses (for example, no runner can take a session) the
     * message is rolled back and the send fails with the responder's error.
     *
     * Fails with `Forbidden` for any actor but the user, and with `NotFound`
     * for an unknown conversation.
     */
    send: (
      input: ConversationSendInput & { readonly conversationId: string },
    ): Effect.Effect<ConversationMessage, ReadError | Validation | NotFound | ResponderError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("conversation.send");
        if (actor._tag !== "user") {
          return yield* Effect.fail(createForbiddenError("agent.write", OWNER_ONLY));
        }
        const { conversationId, text } = yield* Effect.mapError(
          decodeSend(input),
          createDecodeValidationError,
        );
        const user = yield* users.findById(actor.userId);
        if (Option.isNone(user)) {
          // The credential that resolved this actor belongs to the user row.
          return yield* Effect.die("the user behind the request has no user row");
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const conversation = yield* readConversationOrFail(conversationId);
            // Stamped as the user: the send runs as the actor behind the request.
            const message = yield* conversationMessages.append({
              conversationId,
              senderRole: "owner",
              senderLabel: user.value.username,
              text,
            });
            yield* responder.messageSent(conversation, message);
            return message;
          }),
        );
      }),

    /**
     * Creates a conversation, returns it, and nudges the `conversation` topic.
     * It is not an operation, so it checks no grant and opens no transaction:
     * its caller is an operation that has checked its own grant and runs it
     * inside its own transaction.
     */
    create: (input: Omit<NewConversation, "at">): Effect.Effect<Conversation, SqlError> =>
      Effect.flatMap(nowIso, (at) =>
        Effect.tap(conversations.insert({ ...input, at }), (conversation) =>
          nudge(conversation.id, "created"),
        ),
      ),

    /**
     * Returns every conversation the assistant answers, oldest first. It is
     * not an operation, so it checks no grant: its caller has checked its own.
     */
    listForAssistant: (assistantId: string): Effect.Effect<ReadonlyArray<Conversation>, SqlError> =>
      conversations.listForAssistant(assistantId),

    /**
     * Deletes the conversation and its messages, and nudges the
     * `conversation` topic. It is not an operation and joins the caller's
     * transaction.
     */
    delete: (conversationId: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* messages.deleteForConversation(conversationId);
        yield* conversations.delete(conversationId);
        yield* nudge(conversationId, "deleted");
      }),
  };
});

/** The conversation service. */
export class ConversationService extends Context.Service<
  ConversationService,
  Effect.Success<typeof make>
>()("hercule/controller/conversations/ConversationService") {}

export const ConversationServiceLayer: Layer.Layer<
  ConversationService,
  never,
  SqlClient.SqlClient | Users | ConversationResponder | ConversationMessages
> = Layer.effect(ConversationService)(make);

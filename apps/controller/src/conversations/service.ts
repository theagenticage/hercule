/**
 * The conversation operations, `conversation.query` and `conversation.read`,
 * and the create an assistant's create calls.
 *
 * A conversation is one exchange in one channel container. This domain knows
 * the party that answers a conversation only as an id, `assistantId`, which it
 * stores, filters on and passes along. It never reads the assistant, so it
 * does not depend on the assistants domain.
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
  DEFAULT_PAGE_LIMIT,
  createDecodeValidationError,
  createNotFoundError,
  type Conversation,
  type Forbidden,
  type NotFound,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { buildPageInputFields, refuseCursor } from "../db";
import { conversationRepository, type NewConversation } from "./repository";

const QueryInput = Schema.Struct({
  ...ConversationFilter.fields,
  ...buildPageInputFields(CONVERSATION_SORT_FIELDS),
});

export type ConversationQueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);

export interface ConversationPage {
  readonly items: ReadonlyArray<Conversation>;
  readonly nextCursor?: string;
}

/** Oldest first: a list of conversations is read in the order they began. */
const DEFAULT_DIRECTION: SortDirection = "asc";

/** The errors every operation can fail with. */
type ReadError = Unauthenticated | Forbidden | SqlError;

const make = Effect.gen(function* () {
  const conversations = yield* conversationRepository;

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
            direction: sort?.direction ?? DEFAULT_DIRECTION,
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
      Effect.gen(function* () {
        yield* requireGrant("conversation.read");
        const conversation = yield* conversations.read(id);
        if (Option.isNone(conversation)) {
          return yield* Effect.fail(createNotFoundError("no such conversation"));
        }
        return conversation.value;
      }),

    /**
     * Creates a conversation and returns it. It is not an operation, so it
     * checks no grant and opens no transaction: its caller is an operation
     * that has checked its own grant and runs it inside its own transaction.
     * `at` is the caller's time, so the conversation begins at the same
     * moment as whatever the caller creates with it.
     */
    create: (input: NewConversation): Effect.Effect<Conversation, SqlError> =>
      conversations.insert(input),
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
  SqlClient.SqlClient
> = Layer.effect(ConversationService)(make);

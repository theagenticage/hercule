/**
 * Conversation rows. This module only reads and writes them; who may read and
 * when a conversation is created are decided by the service.
 *
 * A listing pages with a keyset over `created_at` and the id, and may be
 * filtered to one assistant's conversations.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Conversation, ConversationChannel, SortDirection } from "@hercule/contract";
import {
  buildKeyset,
  buildPage,
  decodeCursor,
  encodeCursor,
  mintUuid,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** The fields of a new conversation row. The repository generates the id. */
export interface NewConversation {
  readonly assistantId: string;
  readonly channel: ConversationChannel;
  readonly containerKey: string | null;
  readonly at: string;
}

export interface ConversationPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  /** Only the conversations this assistant answers. */
  readonly assistantId: string | undefined;
}

interface ConversationRow {
  readonly id: Uint8Array;
  readonly assistant_id: Uint8Array;
  readonly channel: string;
  readonly container_key: string | null;
  readonly created_at: string;
}

const COLUMNS = "id, assistant_id, channel, container_key, created_at";

const toConversation = (row: ConversationRow): Conversation => ({
  id: uuidToString(row.id),
  assistantId: uuidToString(row.assistant_id),
  channel: row.channel as ConversationChannel,
  containerKey: row.container_key,
  createdAt: row.created_at,
});

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "conversation.query",
  field: "createdAt",
  direction,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    read: (id: string): Effect.Effect<Option.Option<Conversation>, SqlError> =>
      Effect.map(
        sql<ConversationRow>`
          SELECT ${sql.literal(COLUMNS)} FROM conversations WHERE id = ${uuidFromString(id)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toConversation),
      ),

    insert: (conversation: NewConversation): Effect.Effect<Conversation, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
          VALUES (${id}, ${uuidFromString(conversation.assistantId)}, ${conversation.channel},
                  ${conversation.containerKey}, ${conversation.at})
        `;
        return {
          id: uuidToString(id),
          assistantId: conversation.assistantId,
          channel: conversation.channel,
          containerKey: conversation.containerKey,
          createdAt: conversation.at,
        };
      }),

    list: (
      request: ConversationPageRequest,
    ): Effect.Effect<Page<Conversation>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = buildKeyset(
          sql,
          ["created_at", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const clauses = [keyset];
        if (request.assistantId !== undefined) {
          clauses.push(sql`assistant_id = ${uuidFromString(request.assistantId)}`);
        }
        const rows = yield* sql<ConversationRow>`
          SELECT ${sql.literal(COLUMNS)} FROM conversations WHERE ${sql.and(clauses)} ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toConversation)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),
  };
});

/** Everything the conversation service reads and writes. */
export const conversationRepository = make;

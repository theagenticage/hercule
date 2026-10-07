/**
 * The repository for conversation message rows. It only reads and writes
 * them. `ConversationService` decides who may read them, and every message is
 * written through `ConversationMessages.append`.
 *
 * A message's `position` numbers the messages of one conversation from 1. A
 * listing pages with a keyset over the position alone, because it is unique
 * within the conversation.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ConversationMessage, ConversationSenderRole, SortDirection } from "@hercule/contract";
import {
  buildKeyset,
  buildPage,
  decodeIntegerKeyCursor,
  encodeIntegerKeyCursor,
  mintUuid,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** The fields of a new message row. The repository generates the id and the position. */
export interface NewMessageRow {
  readonly conversationId: string;
  readonly containerKey: string | null;
  readonly senderRole: ConversationSenderRole;
  readonly senderLabel: string;
  readonly text: string;
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly itemId: string | null;
  readonly actor: string;
  readonly at: string;
}

export interface MessagePageRequest {
  readonly conversationId: string;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

interface MessageRow {
  readonly id: Uint8Array;
  readonly conversation_id: Uint8Array;
  readonly container_key: string | null;
  readonly position: number;
  readonly sender_role: string;
  readonly sender_label: string;
  readonly text: string;
  readonly session_id: Uint8Array | null;
  readonly turn_id: string | null;
  readonly item_id: string | null;
  readonly actor: string;
  readonly created_at: string;
}

const COLUMNS =
  "id, conversation_id, container_key, position, sender_role, sender_label, text, " +
  "session_id, turn_id, item_id, actor, created_at";

const toMessage = (row: MessageRow): ConversationMessage => ({
  id: uuidToString(row.id),
  conversationId: uuidToString(row.conversation_id),
  containerKey: row.container_key,
  position: row.position,
  senderRole: row.sender_role as ConversationSenderRole,
  senderLabel: row.sender_label,
  text: row.text,
  sessionId: row.session_id === null ? null : uuidToString(row.session_id),
  turnId: row.turn_id,
  itemId: row.item_id,
  actor: row.actor,
  createdAt: row.created_at,
});

/**
 * Builds the cursor scope for one conversation's messages. The cursor key is
 * the position, which is per conversation, so the conversation id is part of
 * the scope. Without it, a cursor from one conversation would silently skip
 * messages of another.
 */
const buildCursorScope = (conversationId: string, direction: SortDirection): CursorScope => ({
  op: "conversation.queryMessages",
  sort: [{ field: `position:${conversationId}`, direction }],
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Inserts a message at the conversation's next position and returns it.
     * The position is read and written in one statement, so two inserts in
     * one transaction still take consecutive places.
     */
    insert: (message: NewMessageRow): Effect.Effect<ConversationMessage, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        const conversationId = uuidFromString(message.conversationId);
        const rows = yield* sql<{ readonly position: number }>`
          INSERT INTO conversation_messages
            (id, conversation_id, container_key, position, sender_role, sender_label, text,
             session_id, turn_id, item_id, actor, created_at)
          SELECT ${id}, ${conversationId}, ${message.containerKey},
                 COALESCE(MAX(position), 0) + 1, ${message.senderRole}, ${message.senderLabel},
                 ${message.text},
                 ${message.sessionId === null ? null : uuidFromString(message.sessionId)},
                 ${message.turnId}, ${message.itemId}, ${message.actor}, ${message.at}
          FROM conversation_messages WHERE conversation_id = ${conversationId}
          RETURNING position
        `;
        return {
          id: uuidToString(id),
          conversationId: message.conversationId,
          containerKey: message.containerKey,
          position: rows[0]!.position,
          senderRole: message.senderRole,
          senderLabel: message.senderLabel,
          text: message.text,
          sessionId: message.sessionId,
          turnId: message.turnId,
          itemId: message.itemId,
          actor: message.actor,
          createdAt: message.at,
        };
      }),

    list: (
      request: MessagePageRequest,
    ): Effect.Effect<Page<ConversationMessage>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.conversationId, request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeIntegerKeyCursor(request.cursor, scope);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "position", direction: request.direction }],
          [],
          after === undefined ? undefined : [after],
        );
        const rows = yield* sql<MessageRow>`
          SELECT ${sql.literal(COLUMNS)} FROM conversation_messages
          WHERE ${sql.and([sql`conversation_id = ${uuidFromString(request.conversationId)}`, keyset])}
          ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toMessage)),
          (last) => encodeIntegerKeyCursor(scope, last.position),
        );
      }),

    /**
     * Returns the item ids of the replies one session's turn has stored in the
     * conversation, read in one query. A reply with no item id is left out.
     */
    listReplyItemIds: (turn: {
      readonly conversationId: string;
      readonly sessionId: string;
      readonly turnId: string;
    }): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly item_id: string }>`
          SELECT item_id FROM conversation_messages
          WHERE conversation_id = ${uuidFromString(turn.conversationId)}
            AND session_id = ${uuidFromString(turn.sessionId)}
            AND turn_id = ${turn.turnId}
            AND sender_role = 'assistant'
            AND item_id IS NOT NULL
        `,
        (rows) => rows.map((row) => row.item_id),
      ),

    /** Deletes every message of the conversation. */
    deleteForConversation: (conversationId: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`DELETE FROM conversation_messages WHERE conversation_id = ${uuidFromString(conversationId)}`,
      ),
  };
});

/** Everything the conversation service reads and writes about messages. */
export const messageRepository = make;

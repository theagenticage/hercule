/**
 * Assistant rows: what an assistant has beyond its agent row. This module only
 * reads and writes them; the service joins them with the agent rows and
 * decides who may write.
 *
 * A listing pages with a keyset over `created_at` and the agent id.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AssistantReply, Heartbeat, Rotation, SortDirection } from "@hercule/contract";
import {
  buildKeyset,
  buildPage,
  decodeCursor,
  encodeCursor,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** The assistant fields of an assistant, as stored beside its agent row. */
export interface StoredAssistantFields {
  /** The id of the assistant's agent row, which is also the assistant's id. */
  readonly agentId: string;
  readonly heartbeat: Heartbeat;
  readonly rotation: Rotation;
  readonly reply: AssistantReply;
  /**
   * The time the row was created. The listing is ordered by it; the
   * assistant's own `createdAt` and `updatedAt` come from the agent row.
   */
  readonly createdAt: string;
}

/** The fields of a new row. The agent row is written first, so its id is known. */
export interface NewAssistantFields extends Omit<StoredAssistantFields, "createdAt"> {
  /** The time the row is created. */
  readonly at: string;
}

/** The columns an edit may set. An absent column is left as it was. */
export type AssistantFieldsEdit = Partial<
  Pick<StoredAssistantFields, "heartbeat" | "rotation" | "reply">
>;

export interface AssistantPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

interface AssistantRow {
  readonly agent_id: Uint8Array;
  readonly heartbeat: string;
  readonly rotation: string;
  readonly reply: string;
  readonly created_at: string;
}

const COLUMNS = "agent_id, heartbeat, rotation, reply, created_at";

const toAssistantFields = (row: AssistantRow): StoredAssistantFields => ({
  agentId: uuidToString(row.agent_id),
  heartbeat: JSON.parse(row.heartbeat) as Heartbeat,
  rotation: JSON.parse(row.rotation) as Rotation,
  reply: row.reply as AssistantReply,
  createdAt: row.created_at,
});

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "assistant.query",
  sort: [{ field: "createdAt", direction }],
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    read: (agentId: string): Effect.Effect<Option.Option<StoredAssistantFields>, SqlError> =>
      Effect.map(
        sql<AssistantRow>`
          SELECT ${sql.literal(COLUMNS)} FROM assistants WHERE agent_id = ${uuidFromString(agentId)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toAssistantFields),
      ),

    insert: (fields: NewAssistantFields): Effect.Effect<StoredAssistantFields, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO assistants (agent_id, heartbeat, rotation, reply, created_at)
          VALUES (${uuidFromString(fields.agentId)}, ${JSON.stringify(fields.heartbeat)},
                  ${JSON.stringify(fields.rotation)}, ${fields.reply}, ${fields.at})
        `;
        const { at, ...stored } = fields;
        return { ...stored, createdAt: at };
      }),

    /**
     * Applies an edit. Only the columns the edit names are written, so the
     * caller must pass an edit that names at least one.
     */
    update: (agentId: string, edit: AssistantFieldsEdit): Effect.Effect<void, SqlError> => {
      const assignments = [];
      if (edit.heartbeat !== undefined) {
        assignments.push(sql`heartbeat = ${JSON.stringify(edit.heartbeat)}`);
      }
      if (edit.rotation !== undefined) {
        assignments.push(sql`rotation = ${JSON.stringify(edit.rotation)}`);
      }
      if (edit.reply !== undefined) assignments.push(sql`reply = ${edit.reply}`);
      return Effect.asVoid(
        sql`UPDATE assistants SET ${sql.csv(assignments)} WHERE agent_id = ${uuidFromString(agentId)}`,
      );
    },

    delete: (agentId: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM assistants WHERE agent_id = ${uuidFromString(agentId)}`),

    list: (
      request: AssistantPageRequest,
    ): Effect.Effect<Page<StoredAssistantFields>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "created_at", direction: request.direction }],
          ["agent_id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const rows = yield* sql<AssistantRow>`
          SELECT ${sql.literal(COLUMNS)} FROM assistants WHERE ${keyset} ${order}
          LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toAssistantFields)),
          (last) => encodeCursor(scope, [last.createdAt], last.agentId),
        );
      }),
  };
});

/** Everything the assistant service reads and writes in its own table. */
export const assistantRepository = make;

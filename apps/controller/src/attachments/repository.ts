/**
 * Reads and writes attachment rows and the references to them: the ones
 * inputs hold, and the ones session transcripts hold for tool results.
 * Nothing here decides policy: who may read an attachment, whether an input
 * may carry it, and when its file is removed are the service's decisions.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { AttachmentReference, ImageMimeType } from "@hercule/protocol";
import { uuidFromString, uuidToString } from "../db";

/** One attachment row. The bytes are a file named for `id`; see `service.ts`. */
export interface StoredAttachment extends AttachmentReference {
  /** The actor stamp of the uploader. */
  readonly actor: string;
  readonly createdAt: string;
}

/** The part of an unclaimed upload the quota reads. */
export interface UnclaimedUpload {
  readonly sizeBytes: number;
  readonly createdAt: string;
}

interface AttachmentRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly mime_type: ImageMimeType;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly actor: string;
  readonly created_at: string;
}

const COLUMNS = "a.id, a.name, a.mime_type, a.size_bytes, a.sha256, a.actor, a.created_at";

/**
 * Builds the SQL condition that is true when something references the
 * attachment `alias` names: an input carries it, or a session's transcript
 * holds it as a tool result's attachment. Every check of "referenced" uses this one
 * condition, so a new kind of reference cannot be counted in one query and
 * missed in another.
 */
const buildReferencedClause = (alias: string): string =>
  `(EXISTS (SELECT 1 FROM session_input_attachments r WHERE r.attachment_id = ${alias}.id) ` +
  `OR EXISTS (SELECT 1 FROM session_tool_result_attachments t WHERE t.attachment_id = ${alias}.id))`;

const toAttachment = (row: AttachmentRow): StoredAttachment => ({
  id: uuidToString(row.id),
  name: row.name,
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes,
  sha256: row.sha256,
  actor: row.actor,
  createdAt: row.created_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert = (attachment: StoredAttachment): Effect.Effect<void, SqlError> =>
    Effect.asVoid(sql`
      INSERT INTO attachments (id, name, mime_type, size_bytes, sha256, created_at, actor)
      VALUES (${uuidFromString(attachment.id)}, ${attachment.name}, ${attachment.mimeType},
              ${attachment.sizeBytes}, ${attachment.sha256}, ${attachment.createdAt},
              ${attachment.actor})
    `);

  return {
    /** Inserts a new attachment row. */
    insert,

    /**
     * Inserts a new attachment row and records it as a tool result's
     * attachment in the session's transcript. Run it inside a transaction, so both rows are
     * written or neither is.
     */
    insertToolResultAttachment: (
      attachment: StoredAttachment,
      sessionId: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* insert(attachment);
        yield* sql`
          INSERT INTO session_tool_result_attachments (attachment_id, session_id)
          VALUES (${uuidFromString(attachment.id)}, ${uuidFromString(sessionId)})
        `;
      }),

    /**
     * Returns the tool result's attachment in the session's transcript whose
     * bytes have that SHA-256 digest, and `None` when there is none.
     */
    findToolResultAttachment: (
      sessionId: string,
      sha256: string,
    ): Effect.Effect<Option.Option<StoredAttachment>, SqlError> =>
      Effect.map(
        sql<AttachmentRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_tool_result_attachments t
          JOIN attachments a ON a.id = t.attachment_id
          WHERE t.session_id = ${uuidFromString(sessionId)} AND a.sha256 = ${sha256}
          LIMIT 1
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toAttachment),
      ),

    /** Checks whether the session exists and is placed on the runner. */
    isSessionPlacedOn: (sessionId: string, runnerId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM sessions
          WHERE id = ${uuidFromString(sessionId)} AND runner_id = ${uuidFromString(runnerId)}
        `,
        (rows) => rows.length > 0,
      ),

    /** Returns the rows of the attachments with those ids that exist, in no particular order. */
    listByIds: (
      ids: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<StoredAttachment>, SqlError> =>
      ids.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<AttachmentRow>`SELECT ${sql.literal(COLUMNS)} FROM attachments a
                               WHERE a.id IN ${sql.in(ids.map(uuidFromString))}`,
            (rows) => rows.map(toAttachment),
          ),

    /**
     * Returns the attachment when something references it (an input, or a
     * session's transcript) or `actor` uploaded it, and `None` otherwise.
     */
    readVisible: (
      id: string,
      actor: string,
    ): Effect.Effect<Option.Option<StoredAttachment>, SqlError> =>
      Effect.map(
        sql<AttachmentRow>`
          SELECT ${sql.literal(COLUMNS)} FROM attachments a
          WHERE a.id = ${uuidFromString(id)}
            AND (a.actor = ${actor} OR ${sql.literal(buildReferencedClause("a"))})
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toAttachment),
      ),

    /**
     * Returns the attachment when an input of a session placed on the runner
     * references it, and `None` otherwise.
     */
    readForRunner: (
      id: string,
      runnerId: string,
    ): Effect.Effect<Option.Option<StoredAttachment>, SqlError> =>
      Effect.map(
        sql<AttachmentRow>`
          SELECT ${sql.literal(COLUMNS)} FROM attachments a
          WHERE a.id = ${uuidFromString(id)} AND EXISTS (
            SELECT 1 FROM session_input_attachments r
            JOIN session_inputs i ON i.id = r.input_id
            JOIN sessions s ON s.id = i.session_id
            WHERE r.attachment_id = a.id AND s.runner_id = ${uuidFromString(runnerId)})
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toAttachment),
      ),

    /** Makes `ids`, in that order, the whole list of attachments the input references. */
    replaceReferences: (
      inputId: string,
      ids: ReadonlyArray<string>,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const input = uuidFromString(inputId);
        yield* sql`DELETE FROM session_input_attachments WHERE input_id = ${input}`;
        yield* Effect.forEach(
          ids,
          (id, position) => sql`
            INSERT INTO session_input_attachments (input_id, attachment_id, position)
            VALUES (${input}, ${uuidFromString(id)}, ${position})
          `,
          { discard: true },
        );
      }),

    /**
     * Returns the attachments each input references, in the order it holds
     * them, keyed by input id. An input with none has no entry. One query
     * serves any number of inputs.
     */
    listReferences: (
      inputIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<StoredAttachment>>, SqlError> =>
      inputIds.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<AttachmentRow & { readonly input_id: Uint8Array }>`
              SELECT r.input_id, ${sql.literal(COLUMNS)} FROM session_input_attachments r
              JOIN attachments a ON a.id = r.attachment_id
              WHERE r.input_id IN ${sql.in(inputIds.map(uuidFromString))}
              ORDER BY r.input_id, r.position
            `,
            (rows) => {
              const byInput = new Map<string, Array<StoredAttachment>>();
              for (const row of rows) {
                const inputId = uuidToString(row.input_id);
                const list = byInput.get(inputId) ?? [];
                list.push(toAttachment(row));
                byInput.set(inputId, list);
              }
              return byInput;
            },
          ),

    /** Returns the id of every attachment, for the sweep to tell a stray file from a kept one. */
    listIds: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(sql<{ readonly id: Uint8Array }>`SELECT id FROM attachments`, (rows) =>
        rows.map((row) => uuidToString(row.id)),
      ),

    /**
     * Returns the size and upload time of each attachment `actor` uploaded at
     * or after `since` that nothing references yet, oldest first.
     */
    listUnclaimed: (
      actor: string,
      since: string,
    ): Effect.Effect<ReadonlyArray<UnclaimedUpload>, SqlError> =>
      Effect.map(
        sql<{ readonly size_bytes: number; readonly created_at: string }>`
          SELECT size_bytes, created_at FROM attachments a
          WHERE a.actor = ${actor} AND a.created_at >= ${since}
            AND NOT ${sql.literal(buildReferencedClause("a"))}
          ORDER BY a.created_at
        `,
        (rows) => rows.map((row) => ({ sizeBytes: row.size_bytes, createdAt: row.created_at })),
      ),

    /**
     * Deletes the attachment when `actor` uploaded it and nothing references
     * it, and returns whether it did.
     */
    deleteUnclaimed: (id: string, actor: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          DELETE FROM attachments
          WHERE id = ${uuidFromString(id)} AND actor = ${actor}
            AND NOT ${sql.literal(buildReferencedClause("attachments"))}
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Deletes every attachment created before `cutoff` that nothing
     * references, and returns their ids.
     */
    deleteUnreferenced: (cutoff: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          DELETE FROM attachments
          WHERE created_at < ${cutoff}
            AND NOT ${sql.literal(buildReferencedClause("attachments"))}
          RETURNING id
        `,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),
  };
});

/** The repository for attachment rows, used by the attachment service. */
export const attachmentRepository = make;

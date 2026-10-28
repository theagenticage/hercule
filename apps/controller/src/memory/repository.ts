/**
 * Memory document rows: an assistant's `core` and its topics. This module
 * only reads and writes them; the service decides who may write and what a
 * write may contain.
 *
 * Rows are written with INSERT, UPDATE and DELETE and never with REPLACE,
 * because the full-text index is kept current by triggers that a REPLACE
 * would skip (migration 0062).
 *
 * Every insert and update takes the document's new version from its
 * assistant's counter in `memory_versions`. The counter only goes up, so a
 * version names one state of one document: a topic deleted and created
 * again never comes back at a version an editor of the old one still holds.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { MEMORY_CORE, type MemoryDocument, type MemoryEntry } from "@hercule/contract";
import { uuidFromString } from "../db";

/**
 * A new document, or the new state of an existing one. It carries no version:
 * `insert` and `update` take the next one from the assistant's counter.
 */
export interface MemoryDocumentWrite {
  readonly assistantId: string;
  readonly name: string;
  readonly gist: string;
  readonly body: string;
  /** The body's length in characters, as `countCharacters` counts it. */
  readonly size: number;
  readonly at: string;
  /** The actor stamp of the write. */
  readonly actor: string;
}

/** A document that matched a search, with every hit in its body marked. */
export interface MemorySearchHit {
  readonly name: string;
  /** The body, with each hit wrapped in `HIT_START` and `HIT_END`. */
  readonly markedBody: string;
}

/** The characters `search` wraps each hit in. A body never needs them. */
export const HIT_START = "\u0002";
export const HIT_END = "\u0003";

interface DocumentRow {
  readonly name: string;
  readonly gist: string;
  readonly body: string;
  readonly size: number;
  readonly version: number;
  readonly updated_at: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Adds one to the assistant's version counter and returns the new value.
   * An assistant without a counter yet starts at 1.
   */
  const takeVersion = (assistantId: string): Effect.Effect<number, SqlError> =>
    Effect.map(
      sql<{ readonly last_version: number }>`
        INSERT INTO memory_versions (assistant_id, last_version)
        VALUES (${uuidFromString(assistantId)}, 1)
        ON CONFLICT (assistant_id) DO UPDATE SET last_version = last_version + 1
        RETURNING last_version
      `,
      (rows) => rows[0]!.last_version,
    );

  return {
    /** Returns the index of an assistant's memory: `core` first, then the topics by name. */
    list: (assistantId: string): Effect.Effect<ReadonlyArray<MemoryEntry>, SqlError> =>
      sql<MemoryEntry>`
        SELECT name, gist, size FROM memory_documents
        WHERE assistant_id = ${uuidFromString(assistantId)}
        ORDER BY name <> ${MEMORY_CORE}, name
      `,

    /** Returns one document, or none when the assistant has no document with this name. */
    read: (
      assistantId: string,
      name: string,
    ): Effect.Effect<Option.Option<MemoryDocument>, SqlError> =>
      Effect.map(
        sql<DocumentRow>`
          SELECT name, gist, body, size, version, updated_at FROM memory_documents
          WHERE assistant_id = ${uuidFromString(assistantId)} AND name = ${name}
        `,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row) => ({
            name: row.name,
            gist: row.gist,
            body: row.body,
            size: row.size,
            version: row.version,
            updatedAt: row.updated_at,
          })),
      ),

    /** Inserts a new document and returns the version it is stored at. */
    insert: (document: MemoryDocumentWrite): Effect.Effect<number, SqlError> =>
      Effect.gen(function* () {
        const version = yield* takeVersion(document.assistantId);
        yield* sql`
          INSERT INTO memory_documents
            (assistant_id, name, gist, body, size, version, updated_at, updated_by)
          VALUES (${uuidFromString(document.assistantId)}, ${document.name}, ${document.gist},
                  ${document.body}, ${document.size}, ${version}, ${document.at}, ${document.actor})
        `;
        return version;
      }),

    /**
     * Replaces the gist and the body of an existing document and returns the
     * version it is stored at.
     */
    update: (document: MemoryDocumentWrite): Effect.Effect<number, SqlError> =>
      Effect.gen(function* () {
        const version = yield* takeVersion(document.assistantId);
        yield* sql`
          UPDATE memory_documents
          SET gist = ${document.gist}, body = ${document.body}, size = ${document.size},
              version = ${version}, updated_at = ${document.at}, updated_by = ${document.actor}
          WHERE assistant_id = ${uuidFromString(document.assistantId)} AND name = ${document.name}
        `;
        return version;
      }),

    delete: (assistantId: string, name: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        DELETE FROM memory_documents
        WHERE assistant_id = ${uuidFromString(assistantId)} AND name = ${name}
      `),

    /**
     * Returns the assistant's documents that match an FTS5 `MATCH`
     * expression, best match first. A document matches on its name or its
     * body; only hits in the body are marked.
     */
    search: (
      assistantId: string,
      match: string,
    ): Effect.Effect<ReadonlyArray<MemorySearchHit>, SqlError> =>
      sql<MemorySearchHit>`
        SELECT d.name,
               highlight(memory_documents_fts, 1, ${HIT_START}, ${HIT_END}) AS markedBody
        FROM memory_documents_fts JOIN memory_documents d ON d.id = memory_documents_fts.rowid
        WHERE memory_documents_fts MATCH ${match}
          AND d.assistant_id = ${uuidFromString(assistantId)}
        ORDER BY bm25(memory_documents_fts), d.name
      `,
  };
});

/** Everything the memory domain reads and writes in its own table. */
export const memoryRepository = make;

/**
 * Memory document rows: an assistant's `core` and its topics. This module
 * only reads and writes them; the service decides who may write and what a
 * write may contain.
 *
 * Rows are written with INSERT, UPDATE and DELETE and never with REPLACE,
 * because the full-text index is kept current by triggers that a REPLACE
 * would skip (migration 0062).
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MEMORY_CORE, type MemoryDocument, type MemoryEntry } from "@hercule/contract";
import { uuidFromString } from "../db";

/**
 * A new document, or the new state of an existing one. It carries no version:
 * `insert` stores a new document at version 1 and `update` adds one.
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

    /** Inserts a new document at version 1. */
    insert: (document: MemoryDocumentWrite): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO memory_documents
          (assistant_id, name, gist, body, size, version, updated_at, updated_by)
        VALUES (${uuidFromString(document.assistantId)}, ${document.name}, ${document.gist},
                ${document.body}, ${document.size}, 1, ${document.at}, ${document.actor})
      `),

    /** Replaces the gist and the body of an existing document and adds one to its version. */
    update: (document: MemoryDocumentWrite): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE memory_documents
        SET gist = ${document.gist}, body = ${document.body}, size = ${document.size},
            version = version + 1, updated_at = ${document.at}, updated_by = ${document.actor}
        WHERE assistant_id = ${uuidFromString(document.assistantId)} AND name = ${document.name}
      `),

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

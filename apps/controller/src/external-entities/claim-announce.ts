/**
 * Announces a change to the claims between refs: the cards of the entities at
 * those refs, and the Tasks that link them, read again.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { uuidToString } from "../db";
import { announceEntityChanges } from "./announce";

/**
 * Builds a function that announces the entity at each of the given refs, when
 * there is one, and every live Task that links any of them.
 * `listTaskIdsLinkedTo` is the repository's read of those Tasks. The function
 * records the announcement for the transaction it runs in, so call it inside
 * the transaction that wrote the claims.
 */
export const makeRefsAnnouncer =
  (input: {
    readonly sql: SqlClient.SqlClient;
    readonly listTaskIdsLinkedTo: (
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, SqlError>;
  }) =>
  (refs: ReadonlyArray<string>): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const found = yield* input.sql<{ readonly id: Uint8Array }>`
        SELECT id FROM external_entities
        WHERE ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))`;
      yield* announceEntityChanges({
        entityIds: found.map((row) => uuidToString(row.id)),
        affectedTaskIds: yield* input.listTaskIdsLinkedTo(refs),
      });
    });

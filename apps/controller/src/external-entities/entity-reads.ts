/**
 * The batched reads of entity rows and observation rows that the repository
 * and the Inbox's reads both build on, each one statement however many refs
 * are asked for.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { EntityRow, ObservationRow } from "./entity-records";
import type { WorkflowOfferTarget } from "./workflow-offer-reads";

/** Groups rows by their `ref`, keeping the order of the rows within each group. */
export const groupByRef = <Row extends { readonly ref: string }>(rows: ReadonlyArray<Row>) => {
  const groups = new Map<string, Array<Row>>();
  for (const row of rows) {
    const group = groups.get(row.ref);
    if (group === undefined) groups.set(row.ref, [row]);
    else group.push(row);
  }
  return groups;
};

/** Returns the canonical remote of the repository an entity's work lands in, or none when its kind has no repository. */
export const readTargetRemote = (row: EntityRow): string | undefined =>
  row.repository === null
    ? undefined
    : (JSON.parse(String(row.repository)) as { target: { remote: string } }).target.remote;

/** Builds what the offers read needs of a full record of a work kind. */
export const buildWorkflowOfferTarget = (row: EntityRow): WorkflowOfferTarget => ({
  ref: row.ref,
  kind: row.kind as string,
  targetRemote: readTargetRemote(row),
});

/** Builds the batched row reads over `sql`. */
export const makeEntityRowReads = (sql: SqlClient.SqlClient) => ({
  /** Reads the entity rows of `refs` in one statement. */
  readEntities: (
    refs: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, EntityRow>, SqlError> =>
    refs.length === 0
      ? Effect.succeed(new Map())
      : Effect.map(
          sql<EntityRow>`
            SELECT * FROM external_entities
            WHERE ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))`,
          (rows) => new Map(rows.map((row) => [row.ref, row])),
        ),

  /**
   * Reads the observation rows of `refs`, every Connection's, in one
   * statement. Each row carries its Connection's status and plugin, and the
   * time that Connection last scanned the entity's kind completely.
   */
  readObservations: (
    refs: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<ObservationRow>>, SqlError> =>
    refs.length === 0
      ? Effect.succeed(new Map())
      : Effect.map(
          sql<ObservationRow>`
            SELECT o.ref, o.connection_id, o.concerns, o.listed, o.owned_by_you, o.access,
                   o.last_refreshed_at, o.next_attempt_at, o.attempt_count,
                   c.status AS connection_status, c.plugin_id, s.last_complete_at
            FROM external_entity_observations o
            JOIN connections c ON c.id = o.connection_id
            LEFT JOIN external_entities e ON e.ref = o.ref
            LEFT JOIN external_entity_scans s ON s.connection_id = o.connection_id AND s.kind = e.kind
            WHERE o.ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))`,
          groupByRef,
        ),
});

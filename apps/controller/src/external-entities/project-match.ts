/**
 * Finds the Project that a set of outside things points at, for the default
 * Project of the start-thread dialog.
 *
 * The evidence is a repository: the canonical remote that a thing's work lands
 * in is matched to the Resources that have it, and those to the Projects that
 * are not deleted (the rule of `findProjectOfRemote`, run over many things in
 * one statement). A thing's own repository counts first. Only when none of the
 * selected things' own repositories reaches a Project do the repositories of the
 * things linked to them, one link away, count.
 *
 * The statements are the same however many things are selected or linked, and
 * they count and pick in SQL, because the links of a thing are not bounded.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createNotFoundError,
  type EntityMention,
  type EntityProjectMatchInput,
  type NotFound,
  type ProjectMatch,
} from "@hercule/contract";
import { uuidFromString, uuidToString, withReadSnapshot } from "../db";
import { EFFECTIVE_LINK_SQL } from "./entity-links";
import { READABLE_RECORD_SQL } from "./inbox-relation";

/** The columns that name a thing as evidence: its id, identifier, and a title only a readable record shows. */
const MENTION_COLUMNS = `t.id AS id, t.identifier AS identifier,
  CASE WHEN ${READABLE_RECORD_SQL} THEN t.title END AS title`;

/** The remote of the repository the work of thing `t` lands in, or NULL when its kind has none. */
const TARGET_REMOTE_SQL = `json_extract(t.repository, '$.target.remote')`;

interface MentionRow {
  readonly id: Uint8Array;
  readonly identifier: string | null;
  readonly title: string | null;
}

/** What a statement that looks for evidence returns: its first row (the pick) and how many Projects the evidence names. */
interface EvidenceRow {
  readonly project_count: number;
  readonly resource_id: Uint8Array;
  readonly project_id: Uint8Array;
  readonly thing_ref: string;
  readonly id: Uint8Array | null;
  readonly identifier: string | null;
  readonly title: string | null;
}

const buildMention = (row: MentionRow): EntityMention => ({
  id: uuidToString(row.id),
  ...(row.identifier === null ? {} : { identifier: row.identifier }),
  ...(row.title === null ? {} : { title: row.title }),
});

/** Builds the project match read over `sql`. */
export const makeProjectMatcher = (sql: SqlClient.SqlClient) => {
  /**
   * Looks for the evidence of the things in `refs` with one statement. `pairs`
   * is a query of (pos, thing_ref, via_ref, remote) rows, one per repository
   * that counts. The pick is the first row in input order, then by the
   * ordering of the Resource and the Project, so the same input always gives
   * the same answer.
   */
  const findEvidence = (pairs: string, params: ReadonlyArray<string>) =>
    sql.unsafe<EvidenceRow>(
      `WITH pairs AS (${pairs}),
        evidence AS (
          SELECT pairs.pos, pairs.thing_ref, pairs.via_ref, r.id AS resource_id, pr.project_id
          FROM pairs
          JOIN resources r ON r.canonical_remote = pairs.remote
          JOIN project_resources pr ON pr.resource_id = r.id
          JOIN projects p ON p.id = pr.project_id AND p.deleted_at IS NULL)
       SELECT (SELECT COUNT(DISTINCT project_id) FROM evidence) AS project_count,
         e.resource_id, e.project_id, e.thing_ref, ${MENTION_COLUMNS}
       FROM evidence e LEFT JOIN external_entities t ON t.ref = e.via_ref
       ORDER BY e.pos, e.via_ref, e.resource_id, e.project_id LIMIT 1`,
      [...params],
    );

  /**
   * Reads the things of `ids` in one statement and returns them in the order
   * of `ids`, by ref. Fails with `NotFound` naming every id that has no
   * record.
   */
  const readSelected = (
    ids: ReadonlyArray<string>,
  ): Effect.Effect<
    ReadonlyArray<{ readonly ref: string; readonly mention: EntityMention }>,
    NotFound | SqlError
  > =>
    Effect.gen(function* () {
      const rows = yield* sql<MentionRow & { readonly ref: string }>`
        SELECT t.ref AS ref, ${sql.literal(MENTION_COLUMNS)}
        FROM external_entities t WHERE t.id IN ${sql.in(ids.map(uuidFromString))}`;
      const byId = new Map(rows.map((row) => [uuidToString(row.id), row]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        return yield* Effect.fail(
          createNotFoundError(`no such external entity: ${missing.join(", ")}`),
        );
      }
      return ids.map((id) => ({ ref: byId.get(id)!.ref, mention: buildMention(byId.get(id)!) }));
    });

  /**
   * Finds the Project the things point at, in one read snapshot. Fails with
   * `NotFound` naming the ids that are unknown. Returns `matched` when the
   * evidence of the first step that has any names exactly one Project, `none`
   * when no step has any, and `ambiguous` when it names several. The evidence
   * is named by the first selected thing in `input.ids` order that has it.
   */
  const matchProject = (
    input: EntityProjectMatchInput,
  ): Effect.Effect<ProjectMatch, NotFound | SqlError> =>
    withReadSnapshot(
      sql,
      Effect.gen(function* () {
        // A repeated id counts once.
        const selected = yield* readSelected([...new Set(input.ids)]);
        const refs = JSON.stringify(selected.map((thing) => thing.ref));
        const mentionOf = new Map(selected.map((thing) => [thing.ref, thing.mention]));

        const own = yield* findEvidence(
          `SELECT j.key AS pos, j.value AS thing_ref, NULL AS via_ref,
                  ${TARGET_REMOTE_SQL} AS remote
           FROM json_each(?) j JOIN external_entities t ON t.ref = j.value`,
          [refs],
        );
        const found =
          own.length > 0
            ? own
            : yield* findEvidence(
                `SELECT j.key AS pos, j.value AS thing_ref, t.ref AS via_ref,
                        ${TARGET_REMOTE_SQL} AS remote
                 FROM json_each(?) j
                 JOIN external_entity_relation_claims c
                   ON (c.from_ref = j.value OR c.to_ref = j.value) AND ${EFFECTIVE_LINK_SQL}
                 JOIN external_entities t
                   ON t.ref = CASE WHEN c.from_ref = j.value THEN c.to_ref ELSE c.from_ref END`,
                [refs],
              );
        const [pick] = found;
        if (pick === undefined) return { kind: "none" };
        if (pick.project_count > 1) return { kind: "ambiguous" };
        return {
          kind: "matched",
          projectId: uuidToString(pick.project_id),
          resourceId: uuidToString(pick.resource_id),
          thing: mentionOf.get(pick.thing_ref)!,
          ...(pick.id === null ? {} : { via: buildMention({ ...pick, id: pick.id }) }),
        };
      }),
    );

  return { matchProject };
};

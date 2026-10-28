/**
 * Reads and writes the Skill Library's rows: one per Skill in `skills`, one
 * per Skill Revision in `skill_revisions`. Nothing here decides policy: who
 * may write, which import result applies, what gets logged.
 *
 * A Skill record joins the Skill's row with its current and available
 * revisions and counts its proposed revisions, all in one statement, so a
 * list of the library never reads row by row.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";
import {
  SkillSource,
  type SkillApprovalEffects,
  type Skill,
  type SkillRevision,
  type SkillRevisionOrigin,
} from "@hercule/contract";
import { LibrarySkillRevision } from "@hercule/protocol";
import { mintUuid } from "../db";

/**
 * A library skill as a session gets it: the Skill's name, the hash of its
 * current Skill Revision, and the description from the revision's `SKILL.md`
 * frontmatter. A session records the list of these it got at its start.
 */
export const SessionLibrarySkill = Schema.Struct({
  ...LibrarySkillRevision.fields,
  description: Schema.String,
});

export type SessionLibrarySkill = typeof SessionLibrarySkill.Type;

/** A Skill record, with what its row holds that the API never shows. */
export interface StoredSkill {
  readonly id: Uint8Array;
  readonly skill: Skill;
  /**
   * The GitHub commit whose tree the last update check downloaded and
   * checked, or null. A check that finds the branch still at this commit
   * downloads nothing.
   */
  readonly upstreamCommit: string | null;
}

/** A Skill Revision record, with its `approvalEffects`, which the revision record leaves out. */
export interface SkillRevisionWithEffects {
  readonly revision: SkillRevision;
  readonly approvalEffects: SkillApprovalEffects;
}

/** What a finished update check records on its Skill. */
export interface SkillCheckRecord {
  /** When the check ended, which becomes `lastCheckedAt`. */
  readonly at: string;
  readonly checkError: string | null;
  readonly upstreamCommit: string | null;
}

/** What a new Skill Revision records. */
export interface NewSkillRevision {
  readonly hash: string;
  readonly origin: SkillRevisionOrigin;
  readonly fileCount: number;
  readonly sizeBytes: number;
  readonly description: string;
  readonly approvalEffects: SkillApprovalEffects;
  /** When the revision was stored and by whom. */
  readonly at: string;
  readonly actor: string;
}

/** One change to a Skill's row: when it happened and by whom. */
export interface SkillChange {
  readonly at: string;
  readonly actor: string;
}

interface SkillRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly source: string;
  readonly current_revision_hash: string | null;
  readonly current_allowed_tools: string | null;
  readonly current_hooks: string | null;
  readonly current_file_count: number | null;
  readonly current_size_bytes: number | null;
  readonly available_revision_hash: string | null;
  readonly available_allowed_tools: string | null;
  readonly available_hooks: string | null;
  readonly proposed_count: number;
  readonly last_checked_at: string | null;
  readonly check_error: string | null;
  readonly upstream_commit: string | null;
  readonly created_at: string;
  readonly created_by: string;
  readonly updated_at: string;
  readonly updated_by: string;
}

interface RevisionRow {
  readonly hash: string;
  readonly origin: SkillRevisionOrigin;
  readonly file_count: number;
  readonly size_bytes: number;
  readonly description: string;
  readonly created_at: string;
  readonly created_by: string;
  readonly applied_at: string | null;
  readonly applied_by: string | null;
  readonly includes_third_party_content: number;
}

interface RevisionWithEffectsRow extends RevisionRow {
  readonly allowed_tools: string | null;
  readonly hooks: string | null;
}

const SourceJson = Schema.fromJsonString(SkillSource);
const decodeSource = Schema.decodeUnknownSync(SourceJson);
const encodeSource = Schema.encodeSync(SourceJson);

const REVISION_COLUMNS =
  "hash, origin, file_count, size_bytes, description, created_at, created_by, applied_at, applied_by, includes_third_party_content";

/**
 * Returns the approval effects of a revision the Skill row joined, or null
 * when the hash is null and no revision was joined.
 */
const buildApprovalEffects = (
  hash: string | null,
  allowedTools: string | null,
  hooks: string | null,
): SkillApprovalEffects | null => (hash === null ? null : { allowedTools, hooks });

const toStoredSkill = (row: SkillRow): StoredSkill => ({
  id: row.id,
  skill: {
    name: row.name,
    // The column is written only by `encodeSource`, so a value that does not
    // decode is a corrupt database, which fails loudly as a defect.
    source: decodeSource(row.source),
    currentRevisionHash: row.current_revision_hash,
    currentApprovalEffects: buildApprovalEffects(
      row.current_revision_hash,
      row.current_allowed_tools,
      row.current_hooks,
    ),
    currentFileCount: row.current_file_count,
    currentSizeBytes: row.current_size_bytes,
    availableRevisionHash: row.available_revision_hash,
    availableApprovalEffects: buildApprovalEffects(
      row.available_revision_hash,
      row.available_allowed_tools,
      row.available_hooks,
    ),
    proposedCount: row.proposed_count,
    lastCheckedAt: row.last_checked_at,
    checkError: row.check_error,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  },
  upstreamCommit: row.upstream_commit,
});

const toRevision = (row: RevisionRow): SkillRevision => ({
  revisionHash: row.hash,
  origin: row.origin,
  fileCount: row.file_count,
  sizeBytes: row.size_bytes,
  description: row.description,
  createdAt: row.created_at,
  createdBy: row.created_by,
  appliedAt: row.applied_at,
  appliedBy: row.applied_by,
  includesThirdPartyContent: row.includes_third_party_content === 1,
});

/** The Skill Library's repository. Its methods run in the caller's transaction. */
export const skillRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Selects Skill records, each joined with its current and available revisions. */
  const selectSkills = (where: Fragment) => sql<SkillRow>`
    SELECT s.id, s.name, s.source,
           s.current_revision_hash, c.allowed_tools AS current_allowed_tools,
           c.hooks AS current_hooks, c.file_count AS current_file_count,
           c.size_bytes AS current_size_bytes,
           s.available_revision_hash, a.allowed_tools AS available_allowed_tools,
           a.hooks AS available_hooks,
           (SELECT count(*) FROM skill_revisions p
            WHERE p.skill_id = s.id AND p.origin = 'session' AND p.applied_at IS NULL)
             AS proposed_count,
           s.last_checked_at, s.check_error, s.upstream_commit,
           s.created_at, s.created_by, s.updated_at, s.updated_by
    FROM skills s
    LEFT JOIN skill_revisions c ON c.skill_id = s.id AND c.hash = s.current_revision_hash
    LEFT JOIN skill_revisions a ON a.skill_id = s.id AND a.hash = s.available_revision_hash
    WHERE ${where}
    ORDER BY s.name
  `;

  return {
    /** Returns every Skill record, sorted by name. */
    list: (): Effect.Effect<ReadonlyArray<Skill>, SqlError> =>
      Effect.map(selectSkills(sql`1 = 1`), (rows) => rows.map((row) => toStoredSkill(row).skill)),

    /** Returns every Skill with a GitHub source, sorted by name. */
    listGithubSkills: (): Effect.Effect<ReadonlyArray<StoredSkill>, SqlError> =>
      Effect.map(selectSkills(sql`json_extract(s.source, '$.kind') = 'github'`), (rows) =>
        rows.map(toStoredSkill),
      ),

    /**
     * Returns the Skills with these names, sorted by name, in one statement.
     * A name no Skill has is left out. `names` is never empty.
     */
    listByNames: (
      names: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<StoredSkill>, SqlError> =>
      Effect.map(selectSkills(sql`s.name IN ${sql.in(names)}`), (rows) => rows.map(toStoredSkill)),

    /** Returns the Skill with this name, if there is one. */
    findByName: (name: string): Effect.Effect<Option.Option<StoredSkill>, SqlError> =>
      Effect.map(selectSkills(sql`s.name = ${name}`), (rows) =>
        Option.map(Option.fromNullishOr(rows[0]), toStoredSkill),
      ),

    /** Returns how many Skills the library holds. */
    count: (): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly count: number }>`SELECT count(*) AS count FROM skills`,
        (rows) => rows[0]?.count ?? 0,
      ),

    /** Inserts a Skill with no current revision, and returns its id. */
    insert: (
      name: string,
      source: SkillSource,
      change: SkillChange,
    ): Effect.Effect<Uint8Array, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO skills (id, name, source, created_at, created_by, updated_at, updated_by)
          VALUES (${id}, ${name}, ${encodeSource(source)}, ${change.at}, ${change.actor},
                  ${change.at}, ${change.actor})
        `;
        return id;
      }),

    /** Returns whether the Skill holds a revision with this hash. */
    hasRevision: (skillId: Uint8Array, hash: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`SELECT 1 FROM skill_revisions WHERE skill_id = ${skillId} AND hash = ${hash}`,
        (rows) => rows.length > 0,
      ),

    /** Returns the Skill's revision with this hash, with its approval effects, if it has one. */
    findRevision: (
      skillId: Uint8Array,
      hash: string,
    ): Effect.Effect<Option.Option<SkillRevisionWithEffects>, SqlError> =>
      Effect.map(
        sql<RevisionWithEffectsRow>`
          SELECT ${sql.literal(REVISION_COLUMNS)}, allowed_tools, hooks
          FROM skill_revisions WHERE skill_id = ${skillId} AND hash = ${hash}
        `,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row) => ({
            revision: toRevision(row),
            approvalEffects: { allowedTools: row.allowed_tools, hooks: row.hooks },
          })),
      ),

    /** Inserts a revision of the Skill that was never applied. */
    insertRevision: (
      skillId: Uint8Array,
      revision: NewSkillRevision,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO skill_revisions
          (skill_id, hash, origin, file_count, size_bytes, description, allowed_tools, hooks,
           created_at, created_by)
        VALUES
          (${skillId}, ${revision.hash}, ${revision.origin}, ${revision.fileCount},
           ${revision.sizeBytes}, ${revision.description},
           ${revision.approvalEffects.allowedTools}, ${revision.approvalEffects.hooks},
           ${revision.at}, ${revision.actor})
      `),

    /**
     * Makes the Skill's revision with this hash current, and records the apply
     * on that revision, which keeps only its last apply. An available
     * revision that becomes current is no longer available.
     *
     * The upstream commit is cleared too: the last check compared that
     * commit's tree with the revision that was current, so the next check
     * must download the tree again.
     */
    applyRevision: (
      skillId: Uint8Array,
      hash: string,
      change: SkillChange,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE skill_revisions SET applied_at = ${change.at}, applied_by = ${change.actor}
          WHERE skill_id = ${skillId} AND hash = ${hash}
        `;
        yield* sql`
          UPDATE skills
          SET current_revision_hash = ${hash},
              available_revision_hash = CASE WHEN available_revision_hash = ${hash}
                                             THEN NULL ELSE available_revision_hash END,
              upstream_commit = NULL,
              updated_at = ${change.at}, updated_by = ${change.actor}
          WHERE id = ${skillId}
        `;
      }),

    /**
     * Sets the Skill's source. The last update check's available revision,
     * result and upstream commit were about the old source, so all three are
     * cleared.
     */
    setSource: (
      skillId: Uint8Array,
      source: SkillSource,
      change: SkillChange,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE skills
        SET source = ${encodeSource(source)}, available_revision_hash = NULL,
            last_checked_at = NULL, check_error = NULL, upstream_commit = NULL,
            updated_at = ${change.at}, updated_by = ${change.actor}
        WHERE id = ${skillId}
      `),

    /**
     * Points the Skill's available revision at the revision with this hash, or
     * clears it with null. The caller makes sure the hash is not the current
     * one.
     */
    setAvailableRevision: (
      skillId: Uint8Array,
      hash: string | null,
      change: SkillChange,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE skills
        SET available_revision_hash = ${hash},
            updated_at = ${change.at}, updated_by = ${change.actor}
        WHERE id = ${skillId}
      `),

    /**
     * Records how an update check ended. It changes neither `updated_at` nor
     * `updated_by`: a check that found nothing new changed nothing the user
     * made.
     */
    recordCheck: (skillId: Uint8Array, check: SkillCheckRecord): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE skills
        SET last_checked_at = ${check.at}, check_error = ${check.checkError},
            upstream_commit = ${check.upstreamCommit}
        WHERE id = ${skillId}
      `),

    /**
     * Deletes the Skill's `github` revisions that were never applied, except
     * the one with hash `kept` when it is not null, and returns the deleted
     * revisions' hashes. The caller first clears or moves
     * `available_revision_hash`, so no hash names a deleted row. A revision
     * that was never applied was never current either.
     */
    deleteUnappliedGithubRevisions: (
      skillId: Uint8Array,
      kept: string | null,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly hash: string }>`
          DELETE FROM skill_revisions
          WHERE skill_id = ${skillId} AND origin = 'github' AND applied_at IS NULL
            AND hash IS NOT ${kept}
          RETURNING hash
        `,
        (rows) => rows.map((row) => row.hash),
      ),

    /** Returns every revision of the Skill, in no particular order. */
    listRevisions: (skillId: Uint8Array): Effect.Effect<ReadonlyArray<SkillRevision>, SqlError> =>
      Effect.map(
        sql<RevisionRow>`
          SELECT ${sql.literal(REVISION_COLUMNS)} FROM skill_revisions WHERE skill_id = ${skillId}
        `,
        (rows) => rows.map(toRevision),
      ),

    /** Deletes the Skill and every revision it has, and returns the revisions' hashes. */
    delete: (skillId: Uint8Array): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        const deleted = yield* sql<{ readonly hash: string }>`
          DELETE FROM skill_revisions WHERE skill_id = ${skillId} RETURNING hash
        `;
        yield* sql`DELETE FROM skills WHERE id = ${skillId}`;
        return deleted.map((row) => row.hash);
      }),

    /** Returns whether any revision of any Skill has this hash. */
    isRevisionHashStored: (hash: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`SELECT 1 FROM skill_revisions WHERE hash = ${hash} LIMIT 1`,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns every Skill that has a current revision, with that revision's
     * hash and description, sorted by name. A Skill with only a proposed
     * revision has none and is left out.
     */
    listCurrentSkillRevisions: (): Effect.Effect<ReadonlyArray<SessionLibrarySkill>, SqlError> =>
      Effect.map(
        sql<{
          readonly name: string;
          readonly current_revision_hash: string;
          readonly description: string;
        }>`
          SELECT skills.name, skills.current_revision_hash, skill_revisions.description
          FROM skills
          JOIN skill_revisions ON skill_revisions.skill_id = skills.id
            AND skill_revisions.hash = skills.current_revision_hash
          ORDER BY skills.name
        `,
        (rows) =>
          rows.map((row) => ({
            name: row.name,
            revisionHash: row.current_revision_hash,
            description: row.description,
          })),
      ),

    /**
     * Returns whether a revision with this hash has ever been applied, by any
     * Skill. A revision keeps its last apply after another revision becomes
     * current, so a formerly current revision counts.
     */
    isRevisionApplied: (hash: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql`SELECT 1 FROM skill_revisions WHERE hash = ${hash} AND applied_at IS NOT NULL LIMIT 1`,
        (rows) => rows.length > 0,
      ),

    /** Returns every hash a revision has, each once. */
    listRevisionHashes: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly hash: string }>`SELECT DISTINCT hash FROM skill_revisions`,
        (rows) => rows.map((row) => row.hash),
      ),
  };
});

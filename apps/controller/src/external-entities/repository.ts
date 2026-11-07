/**
 * Reads and writes External Entities: the records of outside things, what
 * each Connection observes of them, the arrival counter, the Inbox, and the
 * sweep that prunes records nothing needs.
 *
 * This module requires the database and nothing else. Every write method
 * joins the caller's transaction and never opens its own. The caller (the
 * service) also checks that the Connection may still write, renders the slots
 * of each observation, and announces what the returned changes say. The
 * methods that need to know which plugins are active and what time it is take
 * them as plain data (`EntityEnvironment`), so no transaction waits on a
 * service.
 *
 * Observations key on the ref and the Connection, so a Connection can hold
 * state for a ref that has no entity yet. What a thing is (the shared fields)
 * is one row per ref, written by the Connection that presents it. Whether it
 * concerns the user, and whether each account can read it, is worked out on
 * read from the observations of every Connection (see `entity-records.ts`).
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  MAX_CONTEXT_DEPTH,
  MAX_CONTEXT_PARENTS,
  MAX_ENTITY_ANCESTORS,
  MAX_BOARD_PLACES,
  MAX_ENTITY_LINKS,
  MAX_INBOX_CARDS,
  MAX_INBOX_PLACES,
  type EntityConflict,
  type EntityPlace,
  type EntityStatus,
  type ExternalEntityDetail,
  type Inbox,
  type InboxCard,
  type InboxCounts,
  type InboxSide,
  type TaskStage,
} from "@hercule/contract";
import type { EntityObservation } from "@hercule/plugin-host";
import { connectionRepository, INGESTING_STATUSES } from "../connections";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { LIVE_TASK_LINKS_SQL, taskRepository } from "../tasks";
import {
  buildEntityFields,
  buildPlace,
  decideContextComplete,
  deriveAccess,
  deriveStale,
  deriveYours,
  isReadableNow,
  isWorkRecord,
  parseStoredStatus,
  SHARED_COLUMNS,
  unionConcerns,
  VISIBLE_COLUMNS,
  type EntityEnvironment,
  type EntityRow,
  type ObservationRow,
  type PresentedEntityRow,
  type SharedColumn,
  type SharedValues,
} from "./entity-records";
import {
  CURRENT_PART_OF_SQL,
  relationClaimRepository,
  WALK_DOWN_SQL,
  WALK_STATE_ROOM,
  WALK_UP_SQL,
  type AncestorWalk,
} from "./relation-claims";
import type { EntitySlots } from "./slots";

export type { EntityEnvironment } from "./entity-records";

/** How long a failed read waits before the first retry. Each failure doubles it. */
const RETRY_BASE_SECONDS = 120;

/** The longest a failed read waits before a retry. */
const RETRY_CAP_SECONDS = 6 * 60 * 60;

/** How long a record nothing needs is kept before the sweep deletes it. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Returns the seconds a ref waits before it may be read again, after
 * `attemptCount` failed reads: 120 seconds, doubling, at most 6 hours.
 */
export const computeRetryDelaySeconds = (attemptCount: number): number =>
  Math.min(RETRY_CAP_SECONDS, RETRY_BASE_SECONDS * 2 ** Math.min(attemptCount, 16));

// The Connection warnings that entity ingest writes, one sentence per kind
// and problem. The warning of a Connection is shared with account setup, so
// ingest replaces a warning only when it is empty or is exactly one of these
// sentences for a kind the Connection has, and clears it only when it is one
// of them. Anything else is account setup's and is left as it is.

/** Builds the warning for a complete read that could only be done in part. */
export const buildIncompleteWarning = (kind: string): string =>
  `The Inbox may be missing items: the ${kind} list could only be read in part.`;

/** Builds the warning for a relationship that was ignored because it would close a loop. */
export const buildConflictWarning = (kind: string): string =>
  `The Inbox ignored a relationship of ${kind} that would make a thing part of itself.`;

/**
 * One thing a Connection read, ready to store. `kind` is the qualified kind.
 * `slots` come from `renderEntitySlots` for a full observation. For a partial
 * observation the caller passes the place-shaped slots of its kind (`pace:
 * "context"`, the noun, and the caption, home, section and status when
 * known): only the noun, caption, home, section and status are stored from
 * them.
 */
export interface ObservedEntity {
  readonly kind: string;
  readonly observation: EntityObservation;
  readonly slots: EntitySlots;
}

/** What a write changed, so the service can announce it after the commit. All lists are sorted, each ref once. */
export interface EntityWriteChanges {
  /**
   * Refs whose card or place now shows something different, access and
   * concerns included, and refs whose current or refused claims changed. A
   * freshness change alone is not here.
   */
  readonly changedRefs: ReadonlyArray<string>;
  /** Live Tasks that link a changed ref or anything below one, before or after the write. */
  readonly affectedTaskIds: ReadonlyArray<string>;
  /** Every claim of the reported refs that the graph refused, such as a loop. */
  readonly conflicts: ReadonlyArray<EntityConflict>;
  /** The warning that entity ingest wants on the Connection, when there is one. */
  readonly warning: string | undefined;
  /** True when the Connection's warning was written. */
  readonly warningChanged: boolean;
}

/** What the daily sweep deleted. */
export interface PruneResult {
  readonly entities: number;
  readonly observations: number;
}

/** What Hercule holds of a ref, for the marks of a search result. */
export interface EntityStanding {
  readonly standing: "known" | "on-work";
  readonly taskId: string | undefined;
}

/**
 * What the service needs to know about a record before it makes a Task for
 * it. Nothing here is a card: it is the record as the rows hold it now.
 */
export interface TaskableEntity {
  readonly id: string;
  readonly ref: string;
  /** The qualified kind. A partial record may have none yet, and then this is the empty string. */
  readonly kind: string;
  readonly completeness: "full" | "partial";
  /** True when the record is a full record of a work kind (fast or slow), the only kind of record a card is made from. */
  readonly isWorkRecord: boolean;
  /** Empty for a record that has no title yet. */
  readonly title: string;
  readonly status: EntityStatus | undefined;
  /** The Task stage the kind declares for the status, when it declares one. */
  readonly stage: TaskStage | undefined;
  /** The canonical remote of the repository the work lands in, when the record has one. */
  readonly targetRemote: string | undefined;
  /** What any Connection can read of the thing, as `buildEntityFields` derives it. */
  readonly access: "ok" | "inaccessible" | "deleted";
  /** True when some Connection reports a concern for the thing. */
  readonly hasConcern: boolean;
}

/** One thing the sheet lists before the user types, as the rows hold it. */
export interface SuggestionRow {
  readonly ref: string;
  readonly kind: string;
  readonly noun: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly status: EntityStatus | undefined;
}

/** `readEntity` needs to know which kinds the catalog declares for an active plugin. */
export interface EntityReadEnvironment extends EntityEnvironment {
  /** The qualified kinds that are declared by a plugin that is active now. */
  readonly activeKinds: ReadonlySet<string>;
}

const EMPTY_VALUES: SharedValues = Object.fromEntries(
  SHARED_COLUMNS.map((column) => [column, null]),
) as unknown as SharedValues;

const toJson = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

/** Drops the keys that have no value, so a partial observation fills in only what it carries. */
const keepDefined = (values: Record<string, string | number | null | undefined>) =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<SharedValues>;

/**
 * Builds the shared columns one observation sets. A full observation sets all
 * of them, so a field it leaves out is cleared. A partial one sets only the
 * columns it carries, because an absent field is unknown, not removed.
 */
const buildIncomingValues = ({
  kind,
  observation,
  slots,
}: ObservedEntity): Partial<SharedValues> => {
  const place = slots.pace === "context" ? slots : undefined;
  const work = slots.pace === "context" ? undefined : slots;
  if (observation.partial === true) {
    return keepDefined({
      kind,
      noun: slots.noun,
      title: observation.title,
      caption: place?.caption,
      home: slots.home,
      section: slots.section,
      status: slots.status === undefined ? undefined : JSON.stringify(slots.status),
      url: observation.url,
      lifecycle: observation.lifecycle,
      repository:
        observation.repository === undefined ? undefined : JSON.stringify(observation.repository),
      progress:
        observation.progress === undefined ? undefined : JSON.stringify(observation.progress),
      target_date: observation.targetDate,
      source_updated_at: observation.sourceUpdatedAt,
      source_revision: observation.sourceRevision,
    });
  }
  return {
    kind,
    noun: slots.noun,
    card: work?.card ?? null,
    home: slots.home ?? null,
    section: slots.section ?? null,
    pace: slots.pace,
    patience: work?.patience ?? null,
    caption: place?.caption ?? null,
    completeness: "full",
    identifier: work?.identifier ?? null,
    title: observation.title,
    url: observation.url ?? null,
    status: toJson(slots.status),
    lifecycle: observation.lifecycle ?? null,
    person: toJson(work?.person),
    owner: work?.owner ?? null,
    facts: work === undefined ? null : JSON.stringify(work.facts),
    repository: toJson(observation.repository),
    reason: toJson(work?.reason),
    concern_reasons: toJson(work?.concernReasons),
    progress: toJson(observation.progress),
    target_date: observation.targetDate ?? null,
    waiting_since: observation.waitingSince ?? null,
    source_updated_at: observation.sourceUpdatedAt,
    source_revision: observation.sourceRevision ?? null,
  };
};

/** Orders two source times. A missing time is older than any known time, and two missing times are equal. */
const compareSourceTimes = (
  incoming: string | number | null | undefined,
  stored: string | number | null,
): number => {
  const left = incoming ?? null;
  if (left === null && stored === null) return 0;
  if (left === null) return -1;
  if (stored === null) return 1;
  return left < stored ? -1 : left > stored ? 1 : 0;
};

/** What to do with the shared columns of one entity row. */
type SharedWrite =
  | { readonly action: "none" }
  | { readonly action: "insert"; readonly values: SharedValues }
  | {
      readonly action: "update";
      readonly changes: Partial<SharedValues>;
      /** True when the reporter takes over as the presenter. */
      readonly takesOver: boolean;
    };

/**
 * Decides how one observation changes the shared columns of its entity.
 *
 * - No row yet: insert it.
 * - A full row and a partial observation: change nothing.
 * - A partial row and a full observation: the full one replaces everything.
 * - Otherwise the newer `sourceUpdatedAt` wins and the older loses. On an
 *   equal time, the reporter wins when it is the presenter, or the presenter
 *   is gone or cannot keep the row fresh. Then the reporter becomes the
 *   presenter, even if every fact is the same.
 * - An equal time from the presenter with the same, known `sourceRevision`
 *   changes nothing: the facts are covered.
 */
const decideSharedWrite = (input: {
  readonly existing: PresentedEntityRow | undefined;
  readonly incoming: Partial<SharedValues>;
  readonly incomingIsPartial: boolean;
  readonly reporterId: string;
}): SharedWrite => {
  const { existing, incoming, incomingIsPartial, reporterId } = input;
  if (existing === undefined) {
    return {
      action: "insert",
      values: {
        ...EMPTY_VALUES,
        ...incoming,
        completeness: incomingIsPartial ? "partial" : "full",
      },
    };
  }
  if (existing.completeness === "full" && incomingIsPartial) return { action: "none" };
  const isPresenter =
    existing.presented_by !== null && uuidToString(existing.presented_by) === reporterId;
  const promotes = existing.completeness === "partial" && !incomingIsPartial;
  if (!promotes) {
    const order = compareSourceTimes(incoming.source_updated_at, existing.source_updated_at);
    if (order < 0) return { action: "none" };
    if (order === 0) {
      const mayWrite =
        isPresenter || existing.presented_by === null || existing.presenter_usable === 0;
      if (!mayWrite) return { action: "none" };
      const revision = incoming.source_revision;
      if (isPresenter && revision != null && revision === existing.source_revision) {
        return { action: "none" };
      }
    }
  }
  const changes = Object.fromEntries(
    SHARED_COLUMNS.filter(
      (column) => column in incoming && incoming[column] !== existing[column],
    ).map((column) => [column, incoming[column]]),
  ) as Partial<SharedValues>;
  const takesOver = !isPresenter;
  return Object.keys(changes).length === 0 && !takesOver
    ? { action: "none" }
    : { action: "update", changes, takesOver };
};

/** What the observation row of one Connection and ref should hold after a read. */
interface ObservationValues {
  readonly concerns: string;
  readonly listed: number;
  readonly ownedByYou: number;
  readonly lastRefreshedAt: string | null;
}

/**
 * Works out what a successful read of a ref sets on the Connection's own
 * observation row, or returns undefined when the row already holds it.
 *
 * - A full observation of an inventory sets the concerns it reports, marks the
 *   ref as listed by the Connection, and sets the ownership (`false` when it
 *   does not say). A refresh and a partial observation never change the
 *   concerns or the listing, and keep the ownership unless a full refresh says.
 * - Every successful read sets `access` to `ok` and clears the retry state.
 * - The time of the read is stamped unless the read is part of a complete
 *   inventory, whose one scan row dates all of its members.
 */
const planObservationWrite = (input: {
  readonly existing: ObservationRow | undefined;
  readonly observation: EntityObservation;
  readonly isInventory: boolean;
  readonly stampsRead: boolean;
  readonly now: string;
}): ObservationValues | undefined => {
  const { existing, observation, isInventory } = input;
  const keptConcerns = existing?.concerns ?? "[]";
  const keptListed = existing?.listed ?? 0;
  const keptOwnership = existing?.owned_by_you ?? 0;
  const values: ObservationValues =
    observation.partial === true
      ? {
          concerns: keptConcerns,
          listed: keptListed,
          ownedByYou: keptOwnership,
          lastRefreshedAt: existing?.last_refreshed_at ?? null,
        }
      : {
          concerns: isInventory
            ? JSON.stringify([...new Set(observation.concerns)].sort())
            : keptConcerns,
          listed: isInventory ? 1 : keptListed,
          ownedByYou:
            observation.ownedByYou === undefined && !isInventory
              ? keptOwnership
              : observation.ownedByYou === true
                ? 1
                : 0,
          lastRefreshedAt: existing?.last_refreshed_at ?? null,
        };
  const stamped = input.stampsRead ? { ...values, lastRefreshedAt: input.now } : values;
  const unchanged =
    existing !== undefined &&
    existing.concerns === stamped.concerns &&
    existing.listed === stamped.listed &&
    existing.owned_by_you === stamped.ownedByYou &&
    existing.last_refreshed_at === stamped.lastRefreshedAt &&
    existing.access === "ok" &&
    existing.attempt_count === 0 &&
    existing.next_attempt_at === null;
  return unchanged ? undefined : stamped;
};

/** What a write reads of its refs, before or after it writes. */
interface RefStates {
  readonly entities: ReadonlyMap<string, PresentedEntityRow>;
  readonly observations: ReadonlyMap<string, ReadonlyArray<ObservationRow>>;
}

const groupBy = <Row extends { readonly ref: string }>(rows: ReadonlyArray<Row>) => {
  const groups = new Map<string, Array<Row>>();
  for (const row of rows) {
    const group = groups.get(row.ref);
    if (group === undefined) groups.set(row.ref, [row]);
    else group.push(row);
  }
  return groups;
};

/**
 * Returns a function that builds a string, equal for two states of a ref
 * exactly when a card, a place, or a card below it would show the same. It
 * holds the visible shared columns, the concerns, ownership and access worked
 * out from the observations, whether the thing is stale, and whether some
 * Connection can read it now (which decides the `contextComplete` of every
 * card below it). The last two depend on which plugins are active and on the
 * time, so they use the environment the write was given, before and after.
 * No time of a read is in it: a freshness change alone shows nothing.
 */
const buildVisibleStateProjector = (environment: EntityEnvironment) => {
  const activePluginIds = new Set(environment.activePluginIds);
  return (entity: EntityRow | undefined, observations: ReadonlyArray<ObservationRow>): string =>
    JSON.stringify([
      entity === undefined ? null : VISIBLE_COLUMNS.map((column) => entity[column]),
      unionConcerns(observations),
      deriveYours(observations),
      deriveAccess(observations),
      deriveStale(observations, activePluginIds),
      observations.some((observation) =>
        isReadableNow(observation, activePluginIds, environment.now),
      ),
    ]);
};

/** The most refs one statement lists as bound values, well under SQLite's limit on bound values. */
const MAX_REFS_PER_STATEMENT = 1000;

/** Returns the refs sorted, each once. */
const sortUnique = (refs: Iterable<string>): Array<string> => [...new Set(refs)].sort();

/**
 * The refs that concern the user: some Connection's inventory reports a
 * concern for them. The Inbox, the Add sheet's suggestions, the refs Hercule
 * wants read and the daily sweep all start from this one query, so a thing
 * that is on the Inbox is also kept, read and suggested.
 *
 * Open signals join here: a ref with an open signal also concerns the user,
 * and adding it with one more `UNION` puts it on all four.
 */
const CONCERNED_REFS_SQL = `SELECT ref FROM external_entity_observations WHERE concerns <> '[]'`;

/**
 * The one definition of what is on the Inbox, as common table expressions.
 * An entity is eligible when it is a full record of a work kind, is not
 * dismissed, and concerns the user or has a live Task. Access, lifecycle,
 * stale and whether the kind is still declared do not matter: a card keeps
 * its last known facts.
 *
 * `eligible` carries the active Task (`task_id`), the `side` the server puts
 * the card on, and whether a live Task follows the ref. The Inbox, its counts
 * and the Add sheet's suggestions all read it, so they cannot disagree.
 */
const ELIGIBLE_ENTITIES_SQL = `
  live_links AS MATERIALIZED (${LIVE_TASK_LINKS_SQL}),
  eligible AS (
    SELECT e.*, l.task_id AS task_id,
      CASE WHEN l.task_id IS NOT NULL THEN 'with-someone-else'
           WHEN e.card = 'compact' THEN 'requests'
           ELSE 'ongoing' END AS side,
      EXISTS (SELECT 1 FROM live_links f WHERE f.ref = e.ref AND f.following = 1) AS following
    FROM external_entities e
    LEFT JOIN live_links l ON l.ref = e.ref AND l.position = 1
    WHERE e.completeness = 'full' AND e.pace IN ('fast', 'slow') AND e.dismissed_at IS NULL
      AND (e.ref IN (${CONCERNED_REFS_SQL}) OR l.task_id IS NOT NULL)
  )`;

/**
 * The SQL that finds the refs Hercule wants a Connection to read, as a list of
 * common table expressions. `wanted` holds:
 *
 * - the roots: refs that concern the user (`CONCERNED_REFS_SQL`), and refs a
 *   live Task links;
 * - everything above the roots, up to `MAX_CONTEXT_DEPTH` levels of
 *   `part-of`, even where no record exists. A thing contributes its first
 *   `MAX_CONTEXT_PARENTS` parents (by ref), and the walk stops after
 *   `WALK_STATE_ROOM` states beyond the roots, so the work of one poll stays
 *   bounded however the graph grows;
 * - the direct peers of the roots, but only while they have no record: a
 *   peer gets one read for its title and access, and its own links and parents
 *   are never followed.
 *
 * The sweep that prunes observations asks this same question, so what is
 * wanted is decided once.
 */
const WANTED_REFS_SQL = `
  wanted_roots(ref) AS (
    ${CONCERNED_REFS_SQL}
    UNION
    SELECT ref FROM (${LIVE_TASK_LINKS_SQL})
  ),
  wanted_context(ref, depth) AS (
    SELECT ref, 0 FROM wanted_roots
    UNION
    SELECT parent.value, w.depth + 1
    FROM wanted_context w,
      json_each((
        SELECT json_group_array(to_ref) FROM (
          SELECT DISTINCT c.to_ref FROM external_entity_relation_claims c
          WHERE c.from_ref = w.ref AND ${CURRENT_PART_OF_SQL}
          ORDER BY c.to_ref LIMIT ${MAX_CONTEXT_PARENTS})
      )) parent
    WHERE w.depth < ${MAX_CONTEXT_DEPTH}
    LIMIT (SELECT COUNT(*) FROM wanted_roots) + ${WALK_STATE_ROOM}
  ),
  wanted_peers(ref) AS (
    -- CROSS JOIN pins the order, so each root seeks its claims by index
    -- instead of SQLite scanning every current claim.
    SELECT c.to_ref FROM wanted_roots r CROSS JOIN external_entity_relation_claims c
      ON c.from_ref = r.ref AND c.relation = 'linked' AND c.state = 'current'
    UNION
    SELECT c.from_ref FROM wanted_roots r CROSS JOIN external_entity_relation_claims c
      ON c.to_ref = r.ref AND c.relation = 'linked' AND c.state = 'current'
  ),
  wanted(ref) AS (
    SELECT ref FROM wanted_context
    UNION
    SELECT ref FROM wanted_peers
    WHERE NOT EXISTS (SELECT 1 FROM external_entities e WHERE e.ref = wanted_peers.ref)
  )`;

/** One row of the cards statement: an entity, its active Task, its side, and whether a live Task follows it. */
interface EligibleRow extends EntityRow {
  readonly task_id: Uint8Array | null;
  readonly side: InboxSide;
  readonly following: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const claims = yield* relationClaimRepository;
  const tasks = yield* taskRepository;
  const connections = yield* connectionRepository;

  const refsJson = (refs: ReadonlyArray<string>): string => JSON.stringify(refs);

  // -------------------------------------------------------------------------
  // Reading rows in batches
  // -------------------------------------------------------------------------

  /** Reads the entity rows of `refs` in one statement, with whether each one's presenter can keep it fresh. */
  const readPresentedEntities = (
    refs: ReadonlyArray<string>,
    environment: EntityEnvironment,
  ): Effect.Effect<ReadonlyMap<string, PresentedEntityRow>, SqlError> =>
    refs.length === 0
      ? Effect.succeed(new Map())
      : Effect.map(
          sql<PresentedEntityRow>`
            SELECT e.*, EXISTS (
              SELECT 1 FROM connections c JOIN external_entity_observations o
                ON o.connection_id = c.id AND o.ref = e.ref
              WHERE c.id = e.presented_by
                AND c.status IN (SELECT value FROM json_each(${refsJson(INGESTING_STATUSES)}))
                AND c.plugin_id IN (SELECT value FROM json_each(${refsJson(environment.activePluginIds)}))
                AND o.access = 'ok') AS presenter_usable
            FROM external_entities e
            WHERE e.ref IN (SELECT value FROM json_each(${refsJson(refs)}))`,
          (rows) => new Map(rows.map((row) => [row.ref, row])),
        );

  /** Reads the entity rows of `refs` in one statement. */
  const readEntities = (
    refs: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, EntityRow>, SqlError> =>
    refs.length === 0
      ? Effect.succeed(new Map())
      : Effect.map(
          sql<EntityRow>`
            SELECT * FROM external_entities
            WHERE ref IN (SELECT value FROM json_each(${refsJson(refs)}))`,
          (rows) => new Map(rows.map((row) => [row.ref, row])),
        );

  /**
   * Reads the observation rows of `refs`, every Connection's, in one
   * statement. Each row carries its Connection's status and plugin, and the
   * time that Connection last scanned the entity's kind completely.
   */
  const readObservations = (
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
            WHERE o.ref IN (SELECT value FROM json_each(${refsJson(refs)}))`,
          groupBy,
        );

  const readRefStates = (
    refs: ReadonlyArray<string>,
    environment: EntityEnvironment,
  ): Effect.Effect<RefStates, SqlError> =>
    Effect.gen(function* () {
      const entities = yield* readPresentedEntities(refs, environment);
      const observations = yield* readObservations(refs);
      return { entities, observations };
    });

  /**
   * Returns the ids of the live Tasks that link any of `refs`, sorted. The
   * refs go in as a plain `IN` list, in chunks, because SQLite then seeks the
   * Task links by ref instead of numbering every live link.
   */
  const listTaskIdsLinkedTo = (
    refs: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.map(
      Effect.forEach(
        Arr.chunksOf(refs, MAX_REFS_PER_STATEMENT),
        (chunk) =>
          sql<{ readonly task_id: Uint8Array }>`
          SELECT DISTINCT task_id FROM (${sql.literal(LIVE_TASK_LINKS_SQL)})
          WHERE ref IN ${sql.in(chunk)}`,
      ),
      (chunks) => sortUnique(chunks.flat().map((row) => uuidToString(row.task_id))),
    );

  // -------------------------------------------------------------------------
  // Writing observations and entities
  // -------------------------------------------------------------------------

  const writeObservation = (
    connectionId: Uint8Array,
    ref: string,
    values: ObservationValues,
  ): Effect.Effect<void, SqlError> =>
    Effect.asVoid(sql`
      INSERT INTO external_entity_observations
        (ref, connection_id, concerns, listed, owned_by_you, access, last_refreshed_at, attempt_count, next_attempt_at)
      VALUES (${ref}, ${connectionId}, ${values.concerns}, ${values.listed}, ${values.ownedByYou}, 'ok',
              ${values.lastRefreshedAt}, 0, NULL)
      ON CONFLICT (ref, connection_id) DO UPDATE SET
        concerns = excluded.concerns, listed = excluded.listed,
        owned_by_you = excluded.owned_by_you, access = 'ok',
        last_refreshed_at = excluded.last_refreshed_at, attempt_count = 0, next_attempt_at = NULL`);

  const insertEntity = (
    ref: string,
    values: SharedValues,
    presenter: Uint8Array,
    now: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.asVoid(sql`
      INSERT INTO external_entities
        (id, ref, ${sql.literal(SHARED_COLUMNS.join(", "))}, first_observed_at, updated_at, presented_by)
      VALUES (${mintUuid()}, ${ref}, ${sql.csv(SHARED_COLUMNS.map((column) => sql`${values[column]}`))},
              ${now}, ${now}, ${presenter})`);

  const updateEntity = (
    ref: string,
    write: Extract<SharedWrite, { readonly action: "update" }>,
    presenter: Uint8Array,
    now: string,
  ): Effect.Effect<void, SqlError> => {
    const sets = (Object.keys(write.changes) as Array<SharedColumn>).map(
      (column) => sql`${sql.literal(column)} = ${write.changes[column] ?? null}`,
    );
    if (sets.length > 0) sets.push(sql`updated_at = ${now}`);
    if (write.takesOver) sets.push(sql`presented_by = ${presenter}`);
    return Effect.asVoid(sql`UPDATE external_entities SET ${sql.csv(sets)} WHERE ref = ${ref}`);
  };

  /** Takes the next number of the arrival counter. The counter only goes up, even after a prune. */
  const takeArrivalSequence = Effect.map(
    sql<{ readonly last: number }>`
      UPDATE external_entity_arrival_counter SET last = last + 1 WHERE id = 1 RETURNING last`,
    (rows) => rows[0]!.last,
  );

  /**
   * Writes what a list of observations from one Connection reports, and
   * returns what changed. This is the part `reconcile` and `refresh` share.
   *
   * 1. Reads the state of the refs before the write.
   * 2. Writes the Connection's own observation rows. A reconcile also empties
   *    the concerns of `leaving`, the refs a complete inventory left out.
   * 3. Writes the shared fields of each entity, by `decideSharedWrite`.
   * 4. Applies each observation's relations.
   * 5. Gives a thing that went from no concern to some concern the start of
   *    its wait, and, when it is a fast kind with no Task and not dismissed,
   *    a number of the arrival counter.
   * 6. Reads the state again and compares it with the first.
   */
  const writeObservedEntities = (input: {
    readonly connectionId: string;
    readonly isInventory: boolean;
    readonly stampsRead: boolean;
    readonly observed: ReadonlyArray<ObservedEntity>;
    readonly leaving: ReadonlyArray<string>;
    readonly environment: EntityEnvironment;
  }): Effect.Effect<Omit<EntityWriteChanges, "warning" | "warningChanged">, SqlError> =>
    Effect.gen(function* () {
      const { environment } = input;
      const { now } = environment;
      const connection = uuidFromString(input.connectionId);
      const observed = [...input.observed].sort((a, b) =>
        a.observation.ref.localeCompare(b.observation.ref),
      );
      const touched = sortUnique([
        ...observed.map((entry) => entry.observation.ref),
        ...input.leaving,
      ]);

      const before = yield* readRefStates(touched, environment);
      const activeTasks = yield* tasks.listActiveTasksForRefs(touched);
      const refsWithTask = new Set(activeTasks.map((task) => task.ref));

      for (const entry of observed) {
        const ref = entry.observation.ref;
        const existing = (before.observations.get(ref) ?? []).find(
          (row) => uuidToString(row.connection_id) === input.connectionId,
        );
        const values = planObservationWrite({
          existing,
          observation: entry.observation,
          isInventory: input.isInventory,
          stampsRead: input.stampsRead,
          now,
        });
        if (values !== undefined) yield* writeObservation(connection, ref, values);
      }
      for (const ref of input.leaving) {
        yield* sql`
          UPDATE external_entity_observations SET concerns = '[]', listed = 0
          WHERE ref = ${ref} AND connection_id = ${connection}`;
      }

      for (const entry of observed) {
        const ref = entry.observation.ref;
        const write = decideSharedWrite({
          existing: before.entities.get(ref),
          incoming: buildIncomingValues(entry),
          incomingIsPartial: entry.observation.partial === true,
          reporterId: input.connectionId,
        });
        if (write.action === "insert") yield* insertEntity(ref, write.values, connection, now);
        else if (write.action === "update") yield* updateEntity(ref, write, connection, now);
      }

      const relationChanged = new Set<string>();
      const conflicts: Array<EntityConflict> = [];
      const { writes, refsBelowBefore } = yield* claims.applySourceRelations({
        connectionId: input.connectionId,
        entries: observed.flatMap(({ observation }) =>
          observation.relations === undefined
            ? []
            : [
                {
                  fromRef: observation.ref,
                  relations: observation.relations,
                  observedRevision: observation.sourceRevision,
                },
              ],
        ),
        now,
      });
      for (const [ref, relationWrite] of writes) {
        if (relationWrite.changed) relationChanged.add(ref);
        conflicts.push(...relationWrite.conflicts);
      }

      const afterWrite = yield* readRefStates(touched, environment);
      for (const ref of touched) {
        const entity = afterWrite.entities.get(ref);
        const reported = unionConcerns(before.observations.get(ref) ?? []);
        const reportedNow = unionConcerns(afterWrite.observations.get(ref) ?? []);
        if (entity === undefined || JSON.stringify(reported) === JSON.stringify(reportedNow)) {
          continue;
        }
        const sets = [sql`updated_at = ${now}`];
        if (reported.length === 0) {
          sets.push(sql`concerned_since = ${now}`);
          const onTheClock =
            isWorkRecord(entity) &&
            entity.pace === "fast" &&
            entity.dismissed_at === null &&
            !refsWithTask.has(ref);
          if (onTheClock) {
            sets.push(sql`arrival_sequence = ${yield* takeArrivalSequence}`);
          }
        }
        yield* sql`UPDATE external_entities SET ${sql.csv(sets)} WHERE ref = ${ref}`;
      }

      const projectVisibleState = buildVisibleStateProjector(environment);
      const changedRefs = sortUnique([
        ...touched.filter(
          (ref) =>
            projectVisibleState(before.entities.get(ref), before.observations.get(ref) ?? []) !==
            projectVisibleState(
              afterWrite.entities.get(ref),
              afterWrite.observations.get(ref) ?? [],
            ),
        ),
        ...relationChanged,
      ]);
      // The Tasks below a ref whose claims changed are found with the walk
      // from before the claims were removed, as well as the walk from now.
      const affectedTaskIds = yield* listAffectedTaskIds({
        changedRefs,
        refsBelowBefore,
      });
      return {
        changedRefs,
        affectedTaskIds,
        conflicts: conflicts.sort(
          (a, b) =>
            a.fromRef.localeCompare(b.fromRef) ||
            a.relation.localeCompare(b.relation) ||
            a.toRef.localeCompare(b.toRef),
        ),
      };
    });

  /**
   * Returns the live Tasks that link a changed ref or anything below one,
   * and the live Tasks that linked anything in `refsBelowBefore`, the refs
   * found below the changed claims before a claim was removed. One walk down,
   * never cut.
   */
  const listAffectedTaskIds = (input: {
    readonly changedRefs: ReadonlyArray<string>;
    readonly refsBelowBefore: ReadonlyArray<string>;
  }): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.gen(function* () {
      const below = yield* claims.listRefsBelow(input.changedRefs);
      return yield* listTaskIdsLinkedTo([...input.refsBelowBefore, ...below]);
    });

  // -------------------------------------------------------------------------
  // The Connection's warning
  // -------------------------------------------------------------------------

  /**
   * Records what the latest inventory of one kind left unresolved
   * (`wanted`, or nothing when it left nothing), then brings the Connection's
   * one warning in line with every kind that is still unresolved.
   *
   * - The Connection's warning is replaced only when it is empty or is
   *   exactly one of entity ingest's own sentences. Account setup's warning
   *   is never touched.
   * - A warning that still describes an unresolved kind stays. Otherwise the
   *   first unresolved kind (by name) is shown.
   * - The warning is cleared only when no kind is unresolved.
   *
   * Returns whether the Connection's warning changed.
   */
  const syncConnectionWarning = (input: {
    readonly connectionId: string;
    readonly kind: string;
    readonly wanted: string | undefined;
    readonly now: string;
  }): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const found = yield* connections.one(input.connectionId);
      if (Option.isNone(found)) return false;
      const connection = uuidFromString(input.connectionId);
      if (input.wanted === undefined) {
        yield* sql`
          DELETE FROM external_entity_ingest_warnings
          WHERE connection_id = ${connection} AND kind = ${input.kind}`;
      } else {
        yield* sql`
          INSERT INTO external_entity_ingest_warnings (connection_id, kind, warning)
          VALUES (${connection}, ${input.kind}, ${input.wanted})
          ON CONFLICT (connection_id, kind) DO UPDATE SET warning = excluded.warning`;
      }
      const unresolved = yield* sql<{ readonly kind: string; readonly warning: string }>`
        SELECT kind, warning FROM external_entity_ingest_warnings
        WHERE connection_id = ${connection} ORDER BY kind`;
      const scanned = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM external_entity_scans WHERE connection_id = ${connection}`;

      const current = found.value.warning;
      const ownKinds = new Set([
        input.kind,
        ...unresolved.map((row) => row.kind),
        ...scanned.map((row) => row.kind),
      ]);
      const isOwn =
        current === undefined ||
        [...ownKinds].some(
          (kind) =>
            current === buildIncompleteWarning(kind) || current === buildConflictWarning(kind),
        );
      if (!isOwn) return false;
      const shown =
        unresolved.find((row) => row.warning === current)?.warning ?? unresolved[0]?.warning;
      if (shown === current) return false;
      yield* connections.update(input.connectionId, { warning: shown ?? null }, input.now);
      return true;
    });

  // -------------------------------------------------------------------------
  // The Inbox
  // -------------------------------------------------------------------------

  /** Counts the eligible entities. Reads every one, so the counts include cards past `MAX_INBOX_CARDS`. */
  const readInboxCounts: Effect.Effect<InboxCounts, SqlError> = Effect.map(
    sql<{
      readonly on_the_clock: number;
      readonly requests: number;
      readonly with_someone_else: number;
      readonly newest_arrival: number;
    }>`
      WITH ${sql.literal(ELIGIBLE_ENTITIES_SQL)}
      SELECT
        COUNT(*) FILTER (WHERE task_id IS NULL AND pace = 'fast') AS on_the_clock,
        COUNT(*) FILTER (WHERE side = 'requests') AS requests,
        COUNT(*) FILTER (WHERE side = 'with-someone-else') AS with_someone_else,
        COALESCE(MAX(arrival_sequence) FILTER (WHERE task_id IS NULL AND pace = 'fast'), 0)
          AS newest_arrival
      FROM eligible`,
    (rows) => ({
      onTheClock: rows[0]!.on_the_clock,
      requests: rows[0]!.requests,
      withSomeoneElse: rows[0]!.with_someone_else,
      newestArrival: rows[0]!.newest_arrival,
    }),
  );

  /** Reads the record and the observations of each of `refs`, in two statements. */
  const readRecords = (refs: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const records = yield* readEntities(refs);
      const observations = yield* readObservations(refs);
      return { records, observations };
    });

  const sortPlaces = (places: ReadonlyArray<EntityPlace>) =>
    [...places].sort((a, b) => a.ref.localeCompare(b.ref));

  /**
   * Sets an entity aside or brings it back, and stamps `actor` as the one who
   * did. Returns none when there is no such entity, else its ref and whether
   * the call changed it (asking for the state it already has changes nothing).
   */
  const setDismissal = (
    id: string,
    change: { readonly dismissed: boolean; readonly actor: string; readonly now: string },
  ): Effect.Effect<Option.Option<{ readonly ref: string; readonly changed: boolean }>, SqlError> =>
    Effect.gen(function* () {
      const key = uuidFromString(id);
      const found = yield* sql<{ readonly ref: string; readonly dismissed_at: string | null }>`
        SELECT ref, dismissed_at FROM external_entities WHERE id = ${key}`;
      const row = found[0];
      if (row === undefined) return Option.none();
      if ((row.dismissed_at !== null) === change.dismissed) {
        return Option.some({ ref: row.ref, changed: false });
      }
      const { actor, now } = change;
      yield* change.dismissed
        ? sql`
            UPDATE external_entities
            SET dismissed_at = ${now}, dismissed_by = ${actor}, updated_at = ${now}
            WHERE id = ${key}`
        : sql`
            UPDATE external_entities
            SET dismissed_at = NULL, dismissed_by = NULL, restored_at = ${now},
                restored_by = ${actor}, updated_at = ${now}
            WHERE id = ${key}`;
      return Option.some({ ref: row.ref, changed: true });
    });

  return {
    /**
     * Replaces what one Connection says about one kind, and returns what
     * changed.
     *
     * - Every observation is stored: the Connection's own row (concerns,
     *   ownership, access), the shared fields of the entity when this
     *   Connection wins them, and the relations.
     * - `complete: true` empties the concerns of what this Connection listed
     *   before and leaves out now. No entity row is deleted. It also writes
     *   the one scan row of the Connection and kind.
     * - `complete: false` takes nothing away, stamps each observed row with
     *   the time of the read, and sets the Connection's warning to say the
     *   Inbox may be missing items.
     * - A thing that unchanged data reports again writes nothing but the scan
     *   row.
     *
     * The caller has validated the observations (each ref appears once) and
     * runs this in a transaction.
     */
    reconcile: (input: {
      readonly connectionId: string;
      readonly kind: string;
      readonly complete: boolean;
      readonly observed: ReadonlyArray<ObservedEntity>;
      /** The actor of the plugin, `plugin:<id>`, stamped on the scan row. */
      readonly actor: string;
      readonly environment: EntityEnvironment;
    }): Effect.Effect<EntityWriteChanges, SqlError> =>
      Effect.gen(function* () {
        const { now } = input.environment;
        const reported = new Set(input.observed.map((entry) => entry.observation.ref));
        const listed = input.complete
          ? yield* sql<{ readonly ref: string }>`
              SELECT o.ref FROM external_entity_observations o
              JOIN external_entities e ON e.ref = o.ref
              WHERE o.connection_id = ${uuidFromString(input.connectionId)}
                AND e.kind = ${input.kind} AND o.listed = 1`
          : [];
        const written = yield* writeObservedEntities({
          connectionId: input.connectionId,
          isInventory: true,
          stampsRead: !input.complete,
          observed: input.observed,
          leaving: listed.map((row) => row.ref).filter((ref) => !reported.has(ref)),
          environment: input.environment,
        });
        if (input.complete) {
          yield* sql`
            INSERT INTO external_entity_scans (connection_id, kind, last_complete_at, actor)
            VALUES (${uuidFromString(input.connectionId)}, ${input.kind}, ${now}, ${input.actor})
            ON CONFLICT (connection_id, kind) DO UPDATE SET
              last_complete_at = excluded.last_complete_at, actor = excluded.actor`;
        }
        const warning = !input.complete
          ? buildIncompleteWarning(input.kind)
          : written.conflicts.length > 0
            ? buildConflictWarning(input.kind)
            : undefined;
        const warningChanged = yield* syncConnectionWarning({
          connectionId: input.connectionId,
          kind: input.kind,
          wanted: warning,
          now,
        });
        return { ...written, warning, warningChanged };
      }),

    /**
     * Updates what is known of entities without touching any concern, and
     * returns what changed. Every thing read counts as read now: its row for
     * this Connection gets `access: ok` and the time, and its retry state is
     * cleared. A full observation that says `ownedByYou` updates the
     * ownership. Nothing is emptied, no scan row is written, and no arrival
     * number is taken, because the concerns do not change.
     *
     * The caller has validated the observations (each ref appears once).
     */
    refresh: (input: {
      readonly connectionId: string;
      readonly observed: ReadonlyArray<ObservedEntity>;
      readonly environment: EntityEnvironment;
    }): Effect.Effect<EntityWriteChanges, SqlError> =>
      Effect.gen(function* () {
        const written = yield* writeObservedEntities({
          ...input,
          isInventory: false,
          stampsRead: true,
          leaving: [],
        });
        return { ...written, warning: undefined, warningChanged: false };
      }),

    /**
     * Records that a Connection could not read a ref: its `access` becomes
     * `reason`, and the ref waits before it is wanted again (120 seconds,
     * doubling each time, at most 6 hours). Concerns, ownership, facts, claims
     * and the time of the last good read stay, so a failed read never looks
     * fresh. Creates no entity. Returns what changed on screen, which is the
     * access when no other Connection reads the ref.
     */
    reportMissing: (input: {
      readonly connectionId: string;
      readonly ref: string;
      readonly reason: "inaccessible" | "deleted";
      readonly environment: EntityEnvironment;
    }): Effect.Effect<EntityWriteChanges, SqlError> =>
      Effect.gen(function* () {
        const { environment, ref } = input;
        const connection = uuidFromString(input.connectionId);
        const before = yield* readRefStates([ref], environment);
        const attempts =
          (before.observations.get(ref) ?? []).find(
            (row) => uuidToString(row.connection_id) === input.connectionId,
          )?.attempt_count ?? 0;
        const retryAt = new Date(
          Date.parse(environment.now) + computeRetryDelaySeconds(attempts) * 1000,
        ).toISOString();
        yield* sql`
          INSERT INTO external_entity_observations
            (ref, connection_id, access, attempt_count, next_attempt_at)
          VALUES (${ref}, ${connection}, ${input.reason}, ${attempts + 1}, ${retryAt})
          ON CONFLICT (ref, connection_id) DO UPDATE SET
            access = excluded.access, attempt_count = excluded.attempt_count,
            next_attempt_at = excluded.next_attempt_at`;
        const after = yield* readRefStates([ref], environment);
        const projectVisibleState = buildVisibleStateProjector(environment);
        const changed =
          projectVisibleState(before.entities.get(ref), before.observations.get(ref) ?? []) !==
          projectVisibleState(after.entities.get(ref), after.observations.get(ref) ?? []);
        const changedRefs = changed ? [ref] : [];
        return {
          changedRefs,
          affectedTaskIds: yield* listAffectedTaskIds({ changedRefs, refsBelowBefore: [] }),
          conflicts: [],
          warning: undefined,
          warningChanged: false,
        };
      }),

    /**
     * Returns up to `limit` refs that start with `refPrefix` and that the
     * Connection should read now, and marks them as tried.
     *
     * Wanted refs are what is described by `WANTED_REFS_SQL`, without the
     * ones this Connection's inventory already lists, places included (its
     * next scan reads those). A ref backing off after a failure waits. Order: refs
     * never tried first, then the oldest attempt, then the ref, so every
     * wanted ref gets its turn however many there are.
     *
     * Writes `last_attempted_at` on the refs it returns, before they are read,
     * and creates an observation row for each ref that had none (`access:
     * inaccessible`, until a read says otherwise). A read that then fails for
     * all of them still moves the rotation on. Announces nothing.
     */
    listWanted: (input: {
      readonly connectionId: string;
      readonly refPrefix: string;
      readonly limit: number;
      readonly now: string;
    }): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        const connection = uuidFromString(input.connectionId);
        const rows = yield* sql<{ readonly ref: string }>`
          WITH RECURSIVE ${sql.literal(WANTED_REFS_SQL)}
          SELECT w.ref FROM wanted w
          LEFT JOIN external_entity_observations o
            ON o.ref = w.ref AND o.connection_id = ${connection}
          WHERE substr(w.ref, 1, ${input.refPrefix.length}) = ${input.refPrefix}
            AND (o.listed IS NULL OR o.listed = 0)
            AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ${input.now})
          ORDER BY o.last_attempted_at IS NOT NULL, o.last_attempted_at, w.ref
          LIMIT ${input.limit}`;
        const refs = rows.map((row) => row.ref);
        if (refs.length > 0) {
          yield* sql`
            INSERT INTO external_entity_observations (ref, connection_id, access, last_attempted_at)
            SELECT value, ${connection}, 'inaccessible', ${input.now}
            FROM json_each(${refsJson(refs)}) WHERE true
            ON CONFLICT (ref, connection_id) DO UPDATE SET
              last_attempted_at = excluded.last_attempted_at`;
        }
        return refs;
      }),

    /**
     * Returns the Inbox: every card up to `MAX_INBOX_CARDS`, oldest first by
     * `(firstObservedAt, id)`, the places above them, the edges between those
     * places, and the counts over all eligible cards.
     *
     * A constant number of statements however many cards there are: the
     * counts, the cards, one walk up for every card, the records above them,
     * and the observations of cards and places together.
     */
    queryInbox: (environment: EntityEnvironment): Effect.Effect<Inbox, SqlError> =>
      Effect.gen(function* () {
        const counts = yield* readInboxCounts;
        const found = yield* sql<EligibleRow>`
          WITH ${sql.literal(ELIGIBLE_ENTITIES_SQL)}
          SELECT * FROM eligible ORDER BY first_observed_at, id LIMIT ${MAX_INBOX_CARDS + 1}`;
        const truncated = found.length > MAX_INBOX_CARDS;
        const rows = truncated ? found.slice(0, MAX_INBOX_CARDS) : found;

        const walk = yield* claims.readAncestors(rows.map((row) => row.ref));

        // The reply carries at most `MAX_INBOX_PLACES` places. The walk can
        // find more ancestors than that (every card may have its own parents),
        // so the cut is made here, on the refs, before any record is read.
        // Cards come oldest first and each lists its nearest ancestors first,
        // so the older cards keep their context and a later one loses its
        // farthest. A card that loses an ancestor does not list it, and the
        // edges that touch it are dropped, so the reply names no place it
        // does not carry.
        const keptPlaceRefs = new Set<string>();
        const leftOutRefs = new Set<string>();
        for (const row of rows) {
          for (const ref of (walk.ancestors.get(row.ref) ?? []).slice(0, MAX_ENTITY_ANCESTORS)) {
            if (keptPlaceRefs.has(ref)) continue;
            if (keptPlaceRefs.size < MAX_INBOX_PLACES) keptPlaceRefs.add(ref);
            else leftOutRefs.add(ref);
          }
        }
        const placeRefs = sortUnique(keptPlaceRefs);
        const { records: placeRecords, observations } = yield* readRecords([
          ...rows.map((row) => row.ref),
          ...placeRefs,
        ]);
        const activePluginIds = new Set(environment.activePluginIds);

        const cards = rows.map((row): InboxCard => {
          const allAncestors = walk.ancestors.get(row.ref) ?? [];
          const shownAncestors = allAncestors
            .slice(0, MAX_ENTITY_ANCESTORS)
            .filter((ref) => !leftOutRefs.has(ref));
          const contextComplete = decideContextComplete({
            cut:
              walk.cutAll ||
              walk.cutRefs.has(row.ref) ||
              shownAncestors.length < Math.min(allAncestors.length, MAX_ENTITY_ANCESTORS),
            ancestors: allAncestors,
            maxAncestors: MAX_ENTITY_ANCESTORS,
            records: placeRecords,
            observations,
            activePluginIds,
            now: environment.now,
          });
          return {
            ...buildEntityFields({
              row,
              observations: observations.get(row.ref) ?? [],
              activePluginIds,
              taskId: row.task_id === null ? undefined : uuidToString(row.task_id),
              following: row.following === 1,
              ancestors: shownAncestors,
              contextComplete,
            }),
            side: row.side,
          };
        });
        const places = sortPlaces(
          placeRefs.flatMap((ref) => {
            const record = placeRecords.get(ref);
            return record === undefined ? [] : [buildPlace(record, observations.get(ref) ?? [])];
          }),
        );
        const edges = walk.edges.filter(
          (edge) => !leftOutRefs.has(edge.fromRef) && !leftOutRefs.has(edge.toRef),
        );
        return { cards, places, edges, counts, truncated };
      }),

    /**
     * Returns the place of each of `refs` that has a record, whatever kind of
     * record it is, by the same rules as the Inbox: a place no Connection
     * reads is restricted. A ref with no record has no entry. Two statements
     * however many refs there are.
     */
    readPlaces: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, EntityPlace>, SqlError> =>
      Effect.map(readRecords(refs), ({ records, observations }) => {
        const places = new Map<string, EntityPlace>();
        for (const [ref, record] of records) {
          places.set(ref, buildPlace(record, observations.get(ref) ?? []));
        }
        return places;
      }),

    /**
     * Returns the places the Work board draws, and whether the context they
     * give is complete, by the same rule as the Inbox: every ref above a link
     * has a record that some Connection reads now (not stale, not backing off),
     * and no limit cut the walk.
     *
     * The places are the records of `linkedRefs` and of every ref `walk`
     * found above them. At most `MAX_BOARD_PLACES` refs are kept, the first in
     * ref order, and the cut is made on the refs before any record is read.
     * Two statements however many refs there are.
     */
    readBoardContext: (input: {
      readonly linkedRefs: ReadonlyArray<string>;
      readonly walk: AncestorWalk;
      readonly environment: EntityEnvironment;
    }): Effect.Effect<
      { readonly places: ReadonlyArray<EntityPlace>; readonly contextComplete: boolean },
      SqlError
    > =>
      Effect.gen(function* () {
        const { walk, environment } = input;
        const aboveRefs = sortUnique([...walk.ancestors.values()].flat());
        const wantedRefs = sortUnique([...input.linkedRefs, ...aboveRefs]);
        const placeRefs = wantedRefs.slice(0, MAX_BOARD_PLACES);
        const { records, observations } = yield* readRecords(placeRefs);
        return {
          places: placeRefs.flatMap((ref) => {
            const record = records.get(ref);
            return record === undefined ? [] : [buildPlace(record, observations.get(ref) ?? [])];
          }),
          contextComplete: decideContextComplete({
            cut: walk.cutAll || walk.cutRefs.size > 0 || wantedRefs.length > placeRefs.length,
            ancestors: aboveRefs,
            maxAncestors: MAX_BOARD_PLACES,
            records,
            observations,
            activePluginIds: new Set(environment.activePluginIds),
            now: environment.now,
          }),
        };
      }),

    /** Returns the counts of the Inbox from the same definition as `queryInbox`, for the sidebar. */
    countInbox: (): Effect.Effect<InboxCounts, SqlError> => readInboxCounts,

    /**
     * Returns one entity with the records above it and what it is linked to,
     * or none. Only a full record of a work kind has a detail: a partial
     * record or a place is not found here, and travels as an `EntityPlace`.
     */
    readEntity: (
      id: string,
      environment: EntityReadEnvironment,
    ): Effect.Effect<Option.Option<ExternalEntityDetail>, SqlError> =>
      Effect.gen(function* () {
        const found = yield* sql<EntityRow>`
          SELECT * FROM external_entities WHERE id = ${uuidFromString(id)}`;
        const row = found[0];
        if (row === undefined || !isWorkRecord(row)) return Option.none();

        const links = yield* sql<{
          readonly task_id: Uint8Array;
          readonly following: number;
          readonly position: number;
        }>`
          SELECT task_id, following, position FROM (${sql.literal(LIVE_TASK_LINKS_SQL)})
          WHERE ref = ${row.ref}`;
        const active = links.find((link) => link.position === 1);
        const walk = yield* claims.readAncestors([row.ref]);
        const related = yield* claims.readClaimsFor(row.ref);

        const allAncestors = walk.ancestors.get(row.ref) ?? [];
        const ancestors = allAncestors.slice(0, MAX_ENTITY_ANCESTORS);
        const linkedRefs = related.links
          .slice(0, MAX_ENTITY_LINKS)
          .map((link) => (link.fromRef === row.ref ? link.toRef : link.fromRef));
        const placeRefs = sortUnique([...ancestors, ...linkedRefs]);
        const { records, observations } = yield* readRecords([row.ref, ...placeRefs]);
        const activePluginIds = new Set(environment.activePluginIds);

        const contextComplete = decideContextComplete({
          cut: walk.cutAll || walk.cutRefs.has(row.ref),
          ancestors: allAncestors,
          maxAncestors: MAX_ENTITY_ANCESTORS,
          records,
          observations,
          activePluginIds,
          now: environment.now,
        });
        const places = sortPlaces(
          placeRefs.flatMap((ref) => {
            const record = records.get(ref);
            return record === undefined ? [] : [buildPlace(record, observations.get(ref) ?? [])];
          }),
        );
        return Option.some({
          ...buildEntityFields({
            row,
            observations: observations.get(row.ref) ?? [],
            activePluginIds,
            taskId: active === undefined ? undefined : uuidToString(active.task_id),
            following: links.some((link) => link.following === 1),
            ancestors,
            contextComplete,
          }),
          kindAvailable: environment.activeKinds.has(row.kind as string),
          places,
          edges: walk.edges,
          links: related.links.slice(0, MAX_ENTITY_LINKS),
          conflicts: related.conflicts.slice(0, MAX_ENTITY_LINKS),
        });
      }),

    /**
     * Returns the record of an entity, found by its id or by its ref, as the
     * rows hold it now, or none when there is no such record. Any kind of
     * record is returned, a partial one and a place included, because the
     * caller decides what may become a Task.
     */
    readTaskableEntity: (
      key: { readonly id: string } | { readonly ref: string },
    ): Effect.Effect<Option.Option<TaskableEntity>, SqlError> =>
      Effect.gen(function* () {
        const found =
          "id" in key
            ? yield* sql<EntityRow>`
                SELECT * FROM external_entities WHERE id = ${uuidFromString(key.id)}`
            : yield* sql<EntityRow>`
                SELECT * FROM external_entities WHERE ref = ${key.ref}`;
        const row = found[0];
        if (row === undefined) return Option.none();
        const observations = (yield* readObservations([row.ref])).get(row.ref) ?? [];
        const { status, stage } = parseStoredStatus(row.status as string | null);
        const repository =
          row.repository === null
            ? undefined
            : (JSON.parse(String(row.repository)) as { target: { remote: string } });
        return Option.some({
          id: uuidToString(row.id),
          ref: row.ref,
          kind: (row.kind as string | null) ?? "",
          completeness: row.completeness as "full" | "partial",
          isWorkRecord: isWorkRecord(row),
          title: (row.title as string | null) ?? "",
          status,
          stage,
          targetRemote: repository?.target.remote,
          access: deriveAccess(observations),
          hasConcern: unionConcerns(observations).length > 0,
        });
      }),

    /**
     * Returns the things on the Inbox that have no live Task, for the sheet
     * that lists suggestions: the eligible entities of `ELIGIBLE_ENTITIES_SQL`
     * that no live Task links. Oldest first by
     * `(firstObservedAt, id)`, at most `limit`. When `contextRef` is given,
     * only the things below it are considered, at any depth of current
     * `part-of` claims. The walk down and the limit run in the same statement,
     * so a context with a long history of descendants never sends its refs to
     * the caller. Context records are never listed.
     */
    listSuggestions: (input: {
      readonly contextRef: string | undefined;
      readonly limit: number;
    }): Effect.Effect<ReadonlyArray<SuggestionRow>, SqlError> =>
      Effect.map(
        sql<{
          readonly ref: string;
          readonly kind: string;
          readonly noun: string;
          readonly identifier: string;
          readonly title: string;
          readonly url: string;
          readonly status: string | null;
        }>`
          WITH RECURSIVE ${sql.literal(ELIGIBLE_ENTITIES_SQL)},
          walk_start(ref) AS (
            SELECT value FROM json_each(${refsJson(input.contextRef === undefined ? [] : [input.contextRef])})
          ),
          ${sql.literal(WALK_DOWN_SQL)}
          SELECT e.ref, e.kind, e.noun, e.identifier, e.title, e.url, e.status
          FROM eligible e
          WHERE e.task_id IS NULL
            AND (${input.contextRef === undefined ? 1 : 0} = 1
                 OR e.ref IN (SELECT ref FROM walk_down))
          ORDER BY e.first_observed_at, e.id
          LIMIT ${input.limit}`,
        (rows) =>
          rows.map((row) => ({
            ref: row.ref,
            kind: row.kind,
            noun: row.noun,
            identifier: row.identifier,
            title: row.title,
            url: row.url,
            status: parseStoredStatus(row.status).status,
          })),
      ),

    /**
     * Returns what Hercule holds of each ref, for the marks of a search:
     * `on-work` with the active Task when a live Task links it, else `known`
     * when a record exists. A ref in neither case is new and has no entry.
     * Two statements however many refs there are.
     */
    readStandings: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, EntityStanding>, SqlError> =>
      Effect.gen(function* () {
        const records = yield* readEntities(refs);
        const active = yield* tasks.listActiveTasksForRefs(refs);
        const standings = new Map<string, EntityStanding>();
        for (const ref of records.keys())
          standings.set(ref, { standing: "known", taskId: undefined });
        for (const task of active)
          standings.set(task.ref, { standing: "on-work", taskId: task.id });
        return standings;
      }),

    /**
     * Dismisses an entity: it leaves the Inbox and stays out, whatever a new
     * concern or signal says, until `restore`. Returns none when there is no
     * such entity, else its ref and whether this call changed it (dismissing a
     * dismissed entity changes nothing).
     */
    dismiss: (
      id: string,
      actor: string,
      now: string,
    ): Effect.Effect<
      Option.Option<{ readonly ref: string; readonly changed: boolean }>,
      SqlError
    > => setDismissal(id, { dismissed: true, actor, now }),

    /**
     * Undoes `dismiss`, and records who did. Returns none when there is no such
     * entity, else its ref and whether this call changed it.
     */
    restore: (
      id: string,
      actor: string,
      now: string,
    ): Effect.Effect<
      Option.Option<{ readonly ref: string; readonly changed: boolean }>,
      SqlError
    > => setDismissal(id, { dismissed: false, actor, now }),

    /**
     * Deletes the records nothing needs, and returns how many it deleted. The
     * daily sweep calls it.
     *
     * - An entity goes when it has no concern from any Connection, no link to
     *   any Task (finished ones count), is not dismissed, is not above
     *   anything concerned or linked (any number of levels up), and has not
     *   changed for 30 days. Its claims stay: they are small and they are
     *   history. A dismissal is never pruned, so a record that came back
     *   cannot undo "only Undo brings it back".
     * - An observation row goes when its ref has no entity and is not wanted
     *   (`WANTED_REFS_SQL`).
     */
    pruneEntities: (now: string): Effect.Effect<PruneResult, SqlError> =>
      Effect.gen(function* () {
        const cutoff = new Date(Date.parse(now) - PRUNE_AFTER_MS).toISOString();
        const entities = yield* sql`
          WITH RECURSIVE
          roots(ref) AS (
            ${sql.literal(CONCERNED_REFS_SQL)}
            UNION
            -- Every Task link, finished Tasks too: a finished Task still names
            -- its things. (Wanted refs count only live Tasks.)
            SELECT ref FROM task_entity_links
          ),
          walk_start(ref) AS (SELECT ref FROM roots),
          ${sql.literal(WALK_UP_SQL)}
          DELETE FROM external_entities
          WHERE updated_at < ${cutoff} AND dismissed_at IS NULL
            AND ref NOT IN (SELECT ref FROM walk_up)
          RETURNING id`;
        const observations = yield* sql`
          WITH RECURSIVE ${sql.literal(WANTED_REFS_SQL)}
          DELETE FROM external_entity_observations
          WHERE NOT EXISTS (SELECT 1 FROM external_entities e WHERE e.ref = external_entity_observations.ref)
            AND ref NOT IN (SELECT ref FROM wanted)
          RETURNING ref`;
        return { entities: entities.length, observations: observations.length };
      }),
  };
});

/** Everything that reads and writes External Entities. */
export const externalEntityRepository = make;

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
  MAX_ENTITY_ANCESTORS,
  MAX_ENTITY_HINTS,
  MAX_ENTITY_LINKS,
  MAX_ENTITY_SIGNALS,
  type EntityChange,
  type EntityConflict,
  type EntityLifecycle,
  type EntityEdge,
  type EntityPlace,
  type EntityStatus,
  type ExternalEntityDetail,
  type InboxQuery,
  type InboxValueQuery,
  type SignalEntity,
  type TaskStage,
} from "@hercule/contract";
import type { EntityObservation } from "@hercule/plugin-host";
import { INGESTING_STATUSES } from "../connections";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { runRepository } from "../runs";
import { OPEN_THREAD_REFS_SQL, signalRepository } from "../signals";
import {
  LIVE_TASK_LINKS_SQL,
  makeSummaryDirtyMarker,
  taskRepository,
  type StageCauseThing,
} from "../tasks";
import {
  buildEntityFields,
  buildPlace,
  buildWorkRecordCondition,
  decideContextComplete,
  deriveAccess,
  deriveStale,
  deriveYours,
  isReadableNow,
  isWorkRecord,
  parseStoredStatus,
  readLinkedEntityFacts,
  SHARED_COLUMNS,
  unionConcerns,
  VISIBLE_COLUMNS,
  type EntityEnvironment,
  type EntityRow,
  type LinkedEntityFacts,
  type ObservationRow,
  type PresentedEntityRow,
  type SharedColumn,
  type SharedValues,
} from "./entity-records";
import { announceEntityChanges } from "./announce";
import { makeEntityLinkReads, readFarEnd } from "./entity-links";
import { WALK_DOWN_SQL, WALK_UP_SQL } from "./claim-graph";
import { makeWorkflowOfferReads, type WorkflowOfferTarget } from "./workflow-offer-reads";
import {
  buildEligibleEntities,
  makeInboxPopulation,
  RETAINED_ROOT_REFS_SQL,
  WANTED_REFS_SQL,
} from "./inbox-population";
import { makeInboxQueries, type InboxEnvironment, type InboxRailSettings } from "./inbox-query";
import { claimRepository, type ClaimChanges, type RecognizedEvidence } from "./claims";
import { computeRetryDelaySeconds } from "./retry-backoff";
import { buildDetailSignalFields } from "./signal-lines";
import type { EntitySlots, FullEntityObservation, StoredEntityStatus } from "./slots";
import {
  deleteOrphanedFields,
  readFieldValues,
  replaceFieldRows,
  type FieldSet,
} from "./entity-fields";
import type { EncodedField } from "./field-values";
import { detectSourceChanges, timelineRepository, type EntityChangeRecord } from "./timeline";

export type { EntityEnvironment } from "./entity-records";

/** How long a record nothing needs is kept before the sweep deletes it. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

interface ObservedEntityBase {
  readonly kind: string;
  readonly slots: EntitySlots;
  /** What the plugins recognized in the observation's web addresses and texts, when anything was. */
  readonly recognized?: RecognizedEvidence;
}

/**
 * A full observation with the encoded values of the kind's declared fields
 * (`encodeObservedFields`), empty when no field has a value. Storing it
 * replaces the stored fields with them.
 */
export interface FullObservedEntity extends ObservedEntityBase {
  readonly observation: FullEntityObservation;
  readonly fieldRows: ReadonlyArray<EncodedField>;
}

/** A partial observation. It never touches the stored fields, so it carries none. */
export interface PartialObservedEntity extends ObservedEntityBase {
  readonly observation: Extract<EntityObservation, { readonly partial: true }>;
  readonly fieldRows?: undefined;
}

/**
 * One thing a Connection read, ready to store. `kind` is the qualified kind.
 * `slots` come from `renderEntitySlots` for a full observation. For a partial
 * observation the caller passes the place-shaped slots of its kind (`pace:
 * "context"`, the noun, and the caption, home, section and status when
 * known): only the noun, caption, home, section and status are stored from
 * them.
 */
export type ObservedEntity = FullObservedEntity | PartialObservedEntity;

/** What a write changed, so it can be announced once the transaction commits. Both lists are sorted by ref, each once. */
export interface EntityWriteChanges {
  /**
   * The ids of the entities whose card or place now shows something
   * different, access and concerns included, and of those whose current or
   * refused claims changed. A freshness change alone is not here. A ref with
   * no entity row has no id and names nothing.
   */
  readonly entityIds: ReadonlyArray<string>;
  /** Live Tasks that link a changed ref or anything below one, before or after the write. */
  readonly affectedTaskIds: ReadonlyArray<string>;
}

/** What `reconcile` changed, and the claims the graph refused. */
export interface ReconcileChanges extends EntityWriteChanges {
  /** Every claim of the reported refs that the graph refused, such as a loop. */
  readonly conflicts: ReadonlyArray<EntityConflict>;
  /**
   * The ids of the open signals on a ref that this write turned into a full
   * record of a work kind, by creating it or by making a partial one full.
   * Intake shows the record on such a signal, so it must read it again.
   */
  readonly signalIds: ReadonlyArray<string>;
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

/**
 * What the rules for a Task's linked work need of a stored record: how much of
 * it Hercule holds, whether it is work, and whether anyone can read it now.
 */
export interface StoredRecordState {
  /** The qualified kind. A partial record may have none yet, and then this is the empty string. */
  readonly kind: string;
  readonly completeness: "full" | "partial";
  /** True when the record is a full record of a work kind (see `TaskableEntity.isWorkRecord`). */
  readonly isWorkRecord: boolean;
  /** Null when the record has no lifecycle yet. */
  readonly lifecycle: EntityLifecycle | null;
  /** What any Connection can read of the thing, as `buildEntityFields` derives it. */
  readonly access: "ok" | "inaccessible" | "deleted";
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

/** What `readContext` returns: the context above a list of start refs, cut by one rule. */
export interface ContextRead {
  /** The ancestors each start shows, nearest first. Every one is among `places`, or has no record. */
  readonly ancestors: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Whether each start's context is complete: nothing cut it and every ancestor is readable now. */
  readonly contextComplete: ReadonlyMap<string, boolean>;
  /** The places, by ref. */
  readonly places: ReadonlyArray<EntityPlace>;
  /** The `part-of` edges between the starts and the places, none that touches a ref left out. */
  readonly edges: ReadonlyArray<EntityEdge>;
  /** The observations of the starts and of the places. */
  readonly observations: ReadonlyMap<string, ReadonlyArray<ObservationRow>>;
  /** The latest change at the source of each start and each place that has one, in words. */
  readonly latestChanges: ReadonlyMap<string, EntityChange>;
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
      status_key: observation.status,
      url: observation.url,
      lifecycle: observation.lifecycle,
      repository:
        observation.repository === undefined ? undefined : JSON.stringify(observation.repository),
      progress:
        observation.progress === undefined ? undefined : JSON.stringify(observation.progress),
      target_date: observation.targetDate,
      source_updated_at: observation.sourceUpdatedAt,
      source_created_at: observation.sourceCreatedAt,
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
    status_key: observation.status ?? null,
    lifecycle: observation.lifecycle ?? null,
    person: toJson(work?.person),
    owner: work?.owner ?? null,
    facts: work === undefined ? null : JSON.stringify(work.facts),
    repository: toJson(observation.repository),
    reason: toJson(work?.reason),
    concern_reasons: toJson(work?.concernReasons),
    reason_templates: toJson(work?.reasonTemplates),
    progress: toJson(observation.progress),
    target_date: observation.targetDate ?? null,
    waiting_since: observation.waitingSince ?? null,
    source_updated_at: observation.sourceUpdatedAt,
    source_created_at: observation.sourceCreatedAt ?? null,
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

/**
 * What to do with the shared columns of one entity row.
 *
 * - `rejected`: the observation lost, so nothing it reports is stored.
 * - `unchanged`: the observation was accepted and the shared columns already
 *   hold what it reports. Its field values are still compared and stored.
 * - `insert` and `update`: the observation was accepted and changes the row.
 */
type SharedWrite =
  | { readonly action: "rejected" }
  | { readonly action: "unchanged" }
  | { readonly action: "insert"; readonly values: SharedValues }
  | {
      readonly action: "update";
      readonly changes: Partial<SharedValues>;
      /** True when the reporter takes over as the presenter. */
      readonly takesOver: boolean;
    };

/**
 * Returns whether the observation was accepted, so that the values it
 * reports (shared columns and field rows) may be stored. Only `rejected`
 * is not.
 */
const isAccepted = (write: SharedWrite): boolean => write.action !== "rejected";

/**
 * Decides how one observation changes the shared columns of its entity.
 *
 * - No row yet: insert it.
 * - A full row and a partial observation: rejected.
 * - A partial row and a full observation: the full one replaces everything.
 * - Otherwise the newer `sourceUpdatedAt` wins and the older is rejected. On
 *   an equal time, the reporter wins when it is the presenter, or the
 *   presenter is gone or cannot keep the row fresh. Then the reporter becomes
 *   the presenter, even if every fact is the same. An equal time from another
 *   presenter is rejected.
 * - An equal time from the presenter with the same, known `sourceRevision` is
 *   accepted and `unchanged`: the facts are covered.
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
  if (existing.completeness === "full" && incomingIsPartial) return { action: "rejected" };
  const isPresenter =
    existing.presented_by !== null && uuidToString(existing.presented_by) === reporterId;
  const promotes = existing.completeness === "partial" && !incomingIsPartial;
  if (!promotes) {
    const order = compareSourceTimes(incoming.source_updated_at, existing.source_updated_at);
    if (order < 0) return { action: "rejected" };
    if (order === 0) {
      const mayWrite =
        isPresenter || existing.presented_by === null || existing.presenter_usable === 0;
      if (!mayWrite) return { action: "rejected" };
      const revision = incoming.source_revision;
      if (isPresenter && revision != null && revision === existing.source_revision) {
        return { action: "unchanged" };
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
    ? { action: "unchanged" }
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

/** What `writeObservedEntities` is asked to write. */
interface ObservedWrite {
  readonly connectionId: string;
  readonly isInventory: boolean;
  readonly stampsRead: boolean;
  readonly observed: ReadonlyArray<ObservedEntity>;
  readonly leaving: ReadonlyArray<string>;
  readonly environment: EntityEnvironment;
}

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

/** Returns the canonical remote of the repository an entity's work lands in, or none when its kind has no repository. */
const readTargetRemote = (row: EntityRow): string | undefined =>
  row.repository === null
    ? undefined
    : (JSON.parse(String(row.repository)) as { target: { remote: string } }).target.remote;

/** Builds what the offers read needs of a full record of a work kind. */
const buildWorkflowOfferTarget = (row: EntityRow): WorkflowOfferTarget => ({
  ref: row.ref,
  kind: row.kind as string,
  targetRemote: readTargetRemote(row),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const claims = yield* claimRepository;
  const tasks = yield* taskRepository;
  const signals = yield* signalRepository;
  const runs = yield* runRepository;
  const timeline = yield* timelineRepository;
  const markSummaryDirty = yield* makeSummaryDirtyMarker;
  const linkReads = makeEntityLinkReads(sql, timeline.readLatestChanges);
  const inbox = makeInboxPopulation(sql);
  const workflowOfferReads = yield* makeWorkflowOfferReads;

  const refsJson = (refs: ReadonlyArray<string>): string => JSON.stringify(refs);

  /** Runs an effect of the field table with this repository's database client. */
  const withSql = Effect.provideService(SqlClient.SqlClient, sql);

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

  const inboxQueries = makeInboxQueries(sql, {
    readEntities,
    readObservations,
    listOpenKindsByThread: signals.listOpenKindsByThread,
    listLiveWorkflowsOfTasks: runs.listLiveWorkflowsOfTasks,
    readWorkflowOffers: workflowOfferReads.readWorkflowOffers,
    buildOfferTarget: buildWorkflowOfferTarget,
  });

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

  /**
   * Announces a change to the claims between `refs`: the entities at those
   * refs, and every live Task that links any of them, are read again. Records
   * the announcement for the transaction it runs in, so call it inside the
   * transaction that wrote the claims.
   */
  const announceRefs = (refs: ReadonlyArray<string>): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const found = yield* sql<{ readonly id: Uint8Array }>`
        SELECT id FROM external_entities
        WHERE ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))`;
      yield* announceEntityChanges({
        entityIds: found.map((row) => uuidToString(row.id)),
        affectedTaskIds: yield* listTaskIdsLinkedTo(refs),
      });
    });

  /**
   * Writes a `linked` change on the timelines of both ends of every new link
   * in `changes`, in the caller's transaction. The one place a claim change
   * reaches a timeline.
   */
  const recordNewLinks = (changes: ClaimChanges, now: string): Effect.Effect<void, SqlError> =>
    timeline.recordLinks(changes.newLinks, now);

  /**
   * Applies what an operation on the claims changed (see `ClaimChanges`) to
   * the rest of the domain, in the caller's transaction: writes the new links
   * on the timelines and announces the refs whose claims changed, with the
   * Tasks that link them. Does nothing when no claim changed. A write of
   * observations does not call this: it announces through the changes it
   * returns, together with the other things it changed.
   */
  const applyClaimChanges = (changes: ClaimChanges, now: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* recordNewLinks(changes, now);
      if (changes.changedRefs.length > 0) yield* announceRefs(changes.changedRefs);
    });

  /**
   * Marks the summary of every live Task that links one of `refs` out of date,
   * in the caller's transaction. A Task's summary reads the facts of the
   * things it links (`readLinkedEntityFacts`), so it must be written again
   * when they change.
   */
  const markLinkedSummariesDirty = (refs: ReadonlyArray<string>): Effect.Effect<void, SqlError> =>
    Effect.flatMap(listTaskIdsLinkedTo(refs), (taskIds) =>
      Effect.forEach(taskIds, markSummaryDirty, { discard: true }),
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
   *    its wait.
   * 6. Reads the state again and compares it with the first.
   *
   * A thing that this write puts onto the Inbox as a card on the clock takes
   * a number of the arrival counter (`recordArrivalsAfter`).
   */
  const writeObservedEntities = (
    input: ObservedWrite,
  ): Effect.Effect<ReconcileChanges, SqlError> => {
    const { environment } = input;
    const { now } = environment;
    const observed = [...input.observed].sort((a, b) =>
      a.observation.ref.localeCompare(b.observation.ref),
    );
    const touched = sortUnique([
      ...observed.map((entry) => entry.observation.ref),
      ...input.leaving,
    ]);
    return inbox.recordArrivalsAfter(
      touched,
      now,
      environment.askingKinds ?? [],
      writeObservations(input, observed, touched),
    );
  };

  /**
   * Writes the observations of `writeObservedEntities` (`observed` sorted by
   * ref, `touched` the refs they and `leaving` name) and returns what changed.
   */
  const writeObservations = (
    input: ObservedWrite,
    observed: ReadonlyArray<ObservedEntity>,
    touched: ReadonlyArray<string>,
  ): Effect.Effect<ReconcileChanges, SqlError> =>
    Effect.gen(function* () {
      const { environment } = input;
      const { now } = environment;
      const connection = uuidFromString(input.connectionId);

      const before = yield* readRefStates(touched, environment);

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

      // What changed at the source, for the timeline. Only an accepted update
      // of an existing entity can be news: a first sight is a baseline, and a
      // rejected observation writes nothing.
      const sourceChanges: Array<EntityChangeRecord> = [];
      const acceptedFieldSets: Array<FieldSet> = [];
      for (const entry of observed) {
        const ref = entry.observation.ref;
        const existing = before.entities.get(ref);
        const incomingIsPartial = entry.observation.partial === true;
        const write = decideSharedWrite({
          existing,
          incoming: buildIncomingValues(entry),
          incomingIsPartial,
          reporterId: input.connectionId,
        });
        // The field rows are shared fields too: only an accepted full
        // observation replaces them, whether or not its columns changed.
        if (isAccepted(write) && entry.fieldRows !== undefined) {
          acceptedFieldSets.push({ ref, fields: entry.fieldRows });
        }
        if (write.action === "insert") yield* insertEntity(ref, write.values, connection, now);
        else if (write.action === "update") {
          yield* updateEntity(ref, write, connection, now);
          sourceChanges.push(
            ...detectSourceChanges({
              ref,
              existing: existing!,
              incomingIsPartial,
              changes: write.changes,
            }),
          );
        }
      }

      yield* timeline.recordEntityChanges(sourceChanges, now);

      // A change to the field rows alone is a change of the entity: it is
      // dated and announced like a changed fact.
      const fieldChangedRefs = yield* withSql(replaceFieldRows(acceptedFieldSets));
      if (fieldChangedRefs.length > 0) {
        yield* sql`
          UPDATE external_entities SET updated_at = ${now}
          WHERE ref IN (SELECT value FROM json_each(${refsJson(fieldChangedRefs)}))`;
      }

      // What a thing reports while it is not yet a full record is part of what
      // it arrived with, so the links it joins then are not news.
      const isBaseline = (ref: string): boolean =>
        before.entities.get(ref)?.completeness !== "full";
      const claimChanges = yield* claims.applyObservedClaims({
        connectionId: input.connectionId,
        entries: observed.map(({ observation, recognized }) => ({
          fromRef: observation.ref,
          relations: observation.relations,
          texts: observation.texts,
          recognized,
          observedRevision: observation.sourceRevision,
          inBaseline: isBaseline(observation.ref),
        })),
        now,
      });
      yield* recordNewLinks(claimChanges, now);

      const afterWrite = yield* readRefStates(touched, environment);
      const becameWorkRecord = touched.filter((ref) => {
        const after = afterWrite.entities.get(ref);
        const beforeRow = before.entities.get(ref);
        return (
          after !== undefined &&
          isWorkRecord(after) &&
          (beforeRow === undefined || !isWorkRecord(beforeRow))
        );
      });
      const signalIds = yield* signals.listOpenSignalIds(becameWorkRecord);
      for (const ref of touched) {
        const entity = afterWrite.entities.get(ref);
        const reported = unionConcerns(before.observations.get(ref) ?? []);
        const reportedNow = unionConcerns(afterWrite.observations.get(ref) ?? []);
        if (entity === undefined || JSON.stringify(reported) === JSON.stringify(reportedNow)) {
          continue;
        }
        const sets = [sql`updated_at = ${now}`];
        if (reported.length === 0) sets.push(sql`concerned_since = ${now}`);
        yield* sql`UPDATE external_entities SET ${sql.csv(sets)} WHERE ref = ${ref}`;
      }

      yield* markLinkedSummariesDirty(
        touched.filter((ref) => {
          const after = afterWrite.entities.get(ref);
          if (after === undefined) return false;
          const beforeRow = before.entities.get(ref);
          return (
            beforeRow === undefined ||
            JSON.stringify(readLinkedEntityFacts(beforeRow)) !==
              JSON.stringify(readLinkedEntityFacts(after))
          );
        }),
      );

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
        ...fieldChangedRefs,
        ...claimChanges.changedRefs,
      ]);
      // The Tasks below a ref whose claims changed are found with the walk
      // from before the claims were removed, as well as the walk from now.
      const affectedTaskIds = yield* listAffectedTaskIds({
        changedRefs,
        refsBelowBefore: claimChanges.refsBelowBefore,
      });
      return {
        entityIds: changedRefs.flatMap((ref) => {
          const entity = afterWrite.entities.get(ref);
          return entity === undefined ? [] : [uuidToString(entity.id)];
        }),
        affectedTaskIds,
        conflicts: claimChanges.conflicts,
        signalIds,
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
   * (`wanted`, or nothing when it left nothing), and returns the warning of
   * every kind that is still unresolved, sorted by kind, with the kinds the
   * Connection has scanned completely. Ingest decides from them what the
   * Connection's one warning should say (see `decideConnectionWarning`).
   */
  const recordUnresolvedKind = (input: {
    readonly connectionId: string;
    readonly kind: string;
    readonly wanted: string | undefined;
  }) =>
    Effect.gen(function* () {
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
      return { unresolved, scannedKinds: scanned.map((row) => row.kind) };
    });

  // -------------------------------------------------------------------------
  // The Inbox
  // -------------------------------------------------------------------------

  /** Returns the `ridesOn` field of a card that rides on `lead`, else nothing. */

  /**
   * Reads what lies above each of `starts`: their ancestors, the places those
   * ancestors draw, and the edges between them. Every reply that draws
   * context (the Inbox, one entity, the Work board, the Add sheet's
   * suggestions) reads it here, so they all cut and judge it the same way.
   *
   * - A start shows at most `maxAncestors` ancestors, nearest first.
   * - The reply holds at most `maxPlaces` places. `alsoPlaces` take their
   *   room first, in the order given, then the ancestors of each start in
   *   the order of `starts`, nearest first, so a start listed early keeps its
   *   context and a later one loses its farthest ancestors.
   * - An ancestor that is not among the places, whether the budget or
   *   `maxAncestors` left it out, is dropped from the ancestors of every
   *   start, and so are the edges that touch it. The reply names no place it
   *   does not carry.
   * - A start is `contextComplete` only when no limit cut what is above it
   *   (the walk, the ancestors it may show, the places) and every ancestor
   *   has a record that some Connection reads now (not stale, not backing
   *   off).
   *
   * The `observations` are those of the starts and of the places. A constant
   * number of statements however many starts there are: one walk, the
   * records of the places, and the observations.
   */
  const readContext = (input: {
    readonly starts: ReadonlyArray<string>;
    readonly alsoPlaces?: ReadonlyArray<string>;
    readonly maxAncestors: number;
    readonly maxPlaces: number;
    readonly environment: EntityEnvironment;
  }): Effect.Effect<ContextRead, SqlError> =>
    Effect.gen(function* () {
      const { maxAncestors, maxPlaces, environment } = input;
      const starts = [...new Set(input.starts)];
      const walk = yield* claims.readAncestors(starts);
      const nearest = (start: string) => (walk.ancestors.get(start) ?? []).slice(0, maxAncestors);

      // The cut is made on refs, before any record is read.
      const kept = new Set<string>();
      let alsoPlaceLeftOut = false;
      for (const ref of input.alsoPlaces ?? []) {
        if (kept.size < maxPlaces) kept.add(ref);
        else if (!kept.has(ref)) alsoPlaceLeftOut = true;
      }
      for (const start of starts) {
        for (const ref of nearest(start)) if (kept.size < maxPlaces) kept.add(ref);
      }
      const leftOut = new Set([...walk.ancestors.values()].flat().filter((ref) => !kept.has(ref)));
      const placeRefs = [...kept];
      const records = yield* readEntities(placeRefs);
      const observations = yield* readObservations([...starts, ...placeRefs]);
      const latestChanges = yield* timeline.readLatestChanges(
        [...new Set([...starts, ...placeRefs])],
        environment.activeEntityKinds,
      );
      const activePluginIds = new Set(environment.activePluginIds);

      const ancestors = new Map<string, ReadonlyArray<string>>();
      const contextComplete = new Map<string, boolean>();
      for (const start of starts) {
        const all = walk.ancestors.get(start) ?? [];
        const shown = nearest(start).filter((ref) => kept.has(ref));
        ancestors.set(start, shown);
        contextComplete.set(
          start,
          decideContextComplete({
            cut:
              walk.cutAll ||
              walk.cutRefs.has(start) ||
              alsoPlaceLeftOut ||
              shown.length < Math.min(all.length, maxAncestors),
            ancestors: all,
            maxAncestors,
            records,
            observations,
            activePluginIds,
            now: environment.now,
          }),
        );
      }
      const places = placeRefs
        .flatMap((ref) => {
          const record = records.get(ref);
          if (record === undefined) return [];
          const place = buildPlace(record, observations.get(ref) ?? []);
          const latestChange = latestChanges.get(ref);
          return [
            latestChange === undefined || place.restricted ? place : { ...place, latestChange },
          ];
        })
        .sort((a, b) => a.ref.localeCompare(b.ref));
      const edges = walk.edges.filter(
        (edge) => !leftOut.has(edge.fromRef) && !leftOut.has(edge.toRef),
      );
      return { ancestors, contextComplete, places, edges, observations, latestChanges };
    });

  /**
   * Sets entities aside or brings them back, and stamps `actor` as the one who
   * did. Returns the ids that name no entity when there are any, and then
   * changes nothing. Otherwise returns, for each id, its ref and whether the
   * call changed it (asking for the state it already has changes nothing).
   * Two statements however many ids there are.
   */
  const setDismissals = (
    ids: ReadonlyArray<string>,
    change: { readonly dismissed: boolean; readonly actor: string; readonly now: string },
  ): Effect.Effect<
    | { readonly missing: ReadonlyArray<string> }
    | {
        readonly moved: ReadonlyArray<{
          readonly id: string;
          readonly ref: string;
          readonly changed: boolean;
        }>;
      },
    SqlError
  > =>
    Effect.gen(function* () {
      const found = yield* sql<{
        readonly id: Uint8Array;
        readonly ref: string;
        readonly dismissed_at: string | null;
      }>`
        SELECT id, ref, dismissed_at FROM external_entities
        WHERE id IN (SELECT unhex(replace(value, '-', '')) FROM json_each(${JSON.stringify(ids)}))`;
      const known = new Map(found.map((row) => [uuidToString(row.id), row]));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length > 0) return { missing };
      const moved = ids.map((id) => {
        const row = known.get(id)!;
        return { id, ref: row.ref, changed: (row.dismissed_at !== null) !== change.dismissed };
      });
      const changed = moved.filter((entry) => entry.changed).map((entry) => entry.id);
      if (changed.length > 0) {
        const { actor, now } = change;
        const changedJson = JSON.stringify(changed);
        yield* change.dismissed
          ? sql`
              UPDATE external_entities
              SET dismissed_at = ${now}, dismissed_by = ${actor}, updated_at = ${now}
              WHERE id IN (SELECT unhex(replace(value, '-', '')) FROM json_each(${changedJson}))`
          : sql`
              UPDATE external_entities
              SET dismissed_at = NULL, dismissed_by = NULL, restored_at = ${now},
                  restored_by = ${actor}, updated_at = ${now}
              WHERE id IN (SELECT unhex(replace(value, '-', '')) FROM json_each(${changedJson}))`;
      }
      return { moved };
    });

  return {
    applyClaimChanges,

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
     *   the time of the read.
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
    }): Effect.Effect<ReconcileChanges, SqlError> =>
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
        return written;
      }),

    recordUnresolvedKind,

    /**
     * Updates what is known of entities without touching any concern, and
     * returns what changed. Every thing read counts as read now: its row for
     * this Connection gets `access: ok` and the time, and its retry state is
     * cleared. A full observation that says `ownedByYou` updates the
     * ownership. Nothing is emptied and no scan row is written. A thing it
     * creates takes an arrival number only when a live signal puts it on the
     * clock, because a refresh never changes the concerns.
     *
     * The caller has validated the observations (each ref appears once).
     */
    refresh: (input: {
      readonly connectionId: string;
      readonly observed: ReadonlyArray<ObservedEntity>;
      readonly environment: EntityEnvironment;
    }): Effect.Effect<EntityWriteChanges & Pick<ReconcileChanges, "signalIds">, SqlError> =>
      Effect.gen(function* () {
        const { entityIds, affectedTaskIds, signalIds } = yield* writeObservedEntities({
          ...input,
          isInventory: false,
          stampsRead: true,
          leaving: [],
        });
        return { entityIds, affectedTaskIds, signalIds };
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
        const entity = after.entities.get(ref);
        return {
          entityIds: changed && entity !== undefined ? [uuidToString(entity.id)] : [],
          affectedTaskIds: yield* listAffectedTaskIds({ changedRefs, refsBelowBefore: [] }),
        };
      }),

    /**
     * Returns up to `limit` refs that start with `refPrefix` and that the
     * Connection should read now, and marks them as tried.
     *
     * Wanted refs are what is described by `WANTED_REFS_SQL`, without the
     * ones this Connection's inventory already lists, places included (its
     * next scan reads those). With `includesSignalRefs`, the refs of the open
     * signals that came through this Connection are wanted as well, snoozed
     * ones too, even when no entity exists yet: a mention of a thing no
     * inventory lists then gets a card. A ref backing off after a failure waits. Order: refs
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
      /** True when the prefix is a work kind's, so the open signals this Connection raised on refs with that prefix are wanted too. */
      readonly includesSignalRefs: boolean;
    }): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.gen(function* () {
        const connection = uuidFromString(input.connectionId);
        const rows = yield* sql<{ readonly ref: string }>`
          WITH RECURSIVE ${sql.literal(WANTED_REFS_SQL)},
          candidates(ref) AS (
            SELECT ref FROM wanted
            ${
              input.includesSignalRefs
                ? sql`UNION
                  SELECT thread_ref FROM signals
                  WHERE status = 'open' AND connection_id = ${connection}
                    AND substr(thread_ref, 1, ${input.refPrefix.length}) = ${input.refPrefix}`
                : sql``
            })
          SELECT w.ref FROM candidates w
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
     * Returns one page of an Inbox list (see `makeInboxQueries`). Fails with
     * `Validation` for a query that cannot be answered.
     */
    queryInbox: (environment: InboxEnvironment, query: InboxQuery) =>
      inboxQueries.queryInbox(environment, query),

    /**
     * Returns the offers and acting Connections of things, as the Inbox and
     * the detail show them, with their lists cut to the contract's bounds
     * (see `makeWorkflowOfferReads`). They are for display only.
     */
    readWorkflowOffers: workflowOfferReads.readWorkflowOffers,

    /**
     * Decides whether a workflow can take one thing and which Connection acts,
     * for a handoff, without any cut (see `prepareHandoff` in
     * `makeWorkflowOfferReads`). The handoff calls it inside its transaction.
     */
    prepareHandoff: workflowOfferReads.prepareHandoff,

    /**
     * Reads what lies above `starts`, as places and edges, cut by one rule
     * (see `readContext`). The Work board and the Add sheet's suggestions
     * read their context through it.
     */
    readContext,

    /**
     * Returns the pairs of Tasks, among `taskIds`, that the Work board may
     * draw as a stack (see `makeEntityLinkReads`).
     */
    listStackCandidates: linkReads.listStackCandidates,

    /** Returns the counts of the Inbox for the rail and the sidebar (see `makeInboxQueries`). */
    countInbox: (environment: InboxEnvironment, settings: InboxRailSettings) =>
      inboxQueries.countInbox(environment, settings),

    /** Returns the values of one field among the things of a list, for the search's suggestions. */
    suggestInboxValues: (environment: InboxEnvironment, query: InboxValueQuery) =>
      inboxQueries.suggestInboxValues(environment, query),

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
        const related = yield* claims.readClaimsFor(row.ref, MAX_ENTITY_LINKS);
        const entityLinks = related.links.slice(0, MAX_ENTITY_LINKS);
        const entityHints = related.hints.slice(0, MAX_ENTITY_HINTS);
        const linkedRefs = [...entityLinks, ...entityHints].map((pair) =>
          readFarEnd(pair, row.ref),
        );
        const context = yield* readContext({
          starts: [row.ref],
          alsoPlaces: linkedRefs,
          maxAncestors: MAX_ENTITY_ANCESTORS,
          maxPlaces: MAX_ENTITY_ANCESTORS + MAX_ENTITY_LINKS + MAX_ENTITY_HINTS,
          environment,
        });
        const offers = yield* workflowOfferReads.readWorkflowOffers(
          [buildWorkflowOfferTarget(row)],
          environment.kindSources ?? [],
        );
        const fieldValues = (yield* withSql(
          readFieldValues([row.ref], environment.activeEntityKinds),
        )).get(row.ref)!;
        return Option.some({
          ...buildEntityFields({
            row,
            observations: context.observations.get(row.ref) ?? [],
            activePluginIds: new Set(environment.activePluginIds),
            taskId: active === undefined ? undefined : uuidToString(active.task_id),
            following: links.some((link) => link.following === 1),
            ancestors: context.ancestors.get(row.ref)!,
            contextComplete: context.contextComplete.get(row.ref)!,
            latestChange: context.latestChanges.get(row.ref),
          }),
          kindAvailable: environment.activeKinds.has(row.kind as string),
          ...fieldValues,
          places: context.places,
          edges: context.edges,
          links: entityLinks,
          hints: entityHints,
          conflicts: related.conflicts.slice(0, MAX_ENTITY_LINKS),
          ...buildDetailSignalFields(
            yield* signals.readThreadSignals(row.ref, MAX_ENTITY_SIGNALS, environment.now),
            row.reason_templates as string | null,
          ),
          timeline: yield* timeline.readTimeline(row.ref, environment.activeEntityKinds),
          peers: (yield* linkReads.listPeers(
            yield* inbox.listEligibleRefs(
              linkedRefs,
              environment.now,
              environment.askingKinds ?? [],
            ),
            linkedRefs,
            environment.activeEntityKinds,
          )).slice(0, MAX_ENTITY_LINKS + MAX_ENTITY_HINTS),
          offers: offers.offerSets[offers.offerSetIds.get(row.ref)!]!,
          actingConnections: offers.actingConnections.get(row.ref) ?? [],
        });
      }),

    /**
     * Returns the facts a Task's summary reads (`LinkedEntityFacts`) for each
     * of `refs` that has an entity row, in the order of `refs`. One statement
     * however many refs there are. A ref with no row is left out.
     */
    listLinkedEntityFacts: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<LinkedEntityFacts>, SqlError> =>
      Effect.map(readEntities(refs), (rows) =>
        refs.flatMap((ref) => {
          const row = rows.get(ref);
          return row === undefined ? [] : [readLinkedEntityFacts(row)];
        }),
      ),

    /**
     * Returns the stored state (`StoredRecordState`) of each of `refs` that
     * has a record, by ref. A ref with no record is left out. One statement
     * however many refs there are, reading only the columns the state needs;
     * the access is derived in the statement (`deriveAccess`: one good read
     * is enough, else a deleted one, else none). No Connection or plugin is
     * consulted: it answers from the rows alone.
     */
    readStoredRecordStates: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, StoredRecordState>, SqlError> =>
      refs.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{
              readonly ref: string;
              readonly kind: string | null;
              readonly completeness: "full" | "partial";
              readonly is_work_record: number;
              readonly lifecycle: EntityLifecycle | null;
              readonly access: "ok" | "inaccessible" | "deleted";
            }>`
              SELECT e.ref, e.kind, e.completeness, e.lifecycle,
                     CASE WHEN ${sql.literal(buildWorkRecordCondition("e"))}
                          THEN 1 ELSE 0 END AS is_work_record,
                     CASE
                       WHEN EXISTS (SELECT 1 FROM external_entity_observations o
                                    WHERE o.ref = e.ref AND o.access = 'ok') THEN 'ok'
                       WHEN EXISTS (SELECT 1 FROM external_entity_observations o
                                    WHERE o.ref = e.ref AND o.access = 'deleted') THEN 'deleted'
                       ELSE 'inaccessible'
                     END AS access
              FROM external_entities e
              WHERE e.ref IN (SELECT value FROM json_each(${refsJson(refs)}))`,
            (rows) =>
              new Map(
                rows.map((row): [string, StoredRecordState] => [
                  row.ref,
                  {
                    kind: row.kind ?? "",
                    completeness: row.completeness,
                    isWorkRecord: row.is_work_record === 1,
                    lifecycle: row.lifecycle,
                    access: row.access,
                  },
                ]),
              ),
          ),

    /**
     * Returns the id of the record of each of `refs`, by ref. A ref with no
     * record is left out. One statement however many refs there are.
     */
    readRecordIds: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
      refs.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly ref: string; readonly id: Uint8Array }>`
              SELECT ref, id FROM external_entities
              WHERE ref IN (SELECT value FROM json_each(${refsJson(refs)}))`,
            (rows) => new Map(rows.map((row) => [row.ref, uuidToString(row.id)])),
          ),

    /**
     * Returns the stored words of each of `refs` that has a record (the noun
     * and identifier of its kind, its lifecycle and the label of its status),
     * by ref. A ref with no record is left out. One statement however many
     * refs there are. A card's stage cause is written from these.
     */
    listEntityWords: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, StageCauseThing>, SqlError> =>
      refs.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{
              readonly ref: string;
              readonly noun: string;
              readonly identifier: string | null;
              readonly lifecycle: EntityLifecycle | null;
              readonly status_label: string | null;
            }>`
              SELECT ref, noun, identifier, lifecycle,
                     json_extract(status, '$.label') AS status_label
              FROM external_entities
              WHERE noun IS NOT NULL
                AND ref IN (SELECT value FROM json_each(${refsJson(refs)}))`,
            (rows) =>
              new Map(
                rows.map((row): [string, StageCauseThing] => [
                  row.ref,
                  {
                    noun: row.noun,
                    identifier: row.identifier,
                    lifecycle: row.lifecycle,
                    statusWord: row.status_label,
                  },
                ]),
              ),
          ),

    /**
     * Returns the refs the Connection holds a row for (what it reads, and what
     * it tried to read and could not) that a live Task links. Deleting the
     * Connection deletes these rows. Only linked refs are returned, because
     * only they can make a fact, and a Connection may hold thousands of rows.
     * One statement.
     */
    listLinkedObservedRefs: (
      connectionId: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly ref: string }>`
          SELECT DISTINCT o.ref FROM external_entity_observations o
          WHERE o.connection_id = ${uuidFromString(connectionId)}
            AND o.ref IN (SELECT ref FROM (${sql.literal(LIVE_TASK_LINKS_SQL)}))`,
        (rows) => rows.map((row) => row.ref),
      ),

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
        return Option.some({
          id: uuidToString(row.id),
          ref: row.ref,
          kind: (row.kind as string | null) ?? "",
          completeness: row.completeness as "full" | "partial",
          isWorkRecord: isWorkRecord(row),
          title: (row.title as string | null) ?? "",
          status,
          stage,
          targetRemote: readTargetRemote(row),
          access: deriveAccess(observations),
          hasConcern: unionConcerns(observations).length > 0,
        });
      }),

    /**
     * Returns the things on the Inbox that have no live Task, for the sheet
     * that lists suggestions: the eligible entities of `buildEligibleEntities`
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
      readonly now: string;
      readonly askingKinds: ReadonlyArray<string>;
    }): Effect.Effect<ReadonlyArray<SuggestionRow>, SqlError> => {
      const eligible = buildEligibleEntities(input.now, input.askingKinds);
      return Effect.map(
        sql.unsafe<{
          readonly ref: string;
          readonly kind: string;
          readonly noun: string;
          readonly identifier: string;
          readonly title: string;
          readonly url: string;
          readonly status: string | null;
        }>(
          `WITH RECURSIVE ${eligible.sql},
          walk_start(ref) AS (SELECT value FROM json_each(?)),
          ${WALK_DOWN_SQL}
          SELECT e.ref, e.kind, e.noun, e.identifier, e.title, e.url, e.status
          FROM eligible e
          WHERE e.task_id IS NULL
            AND (? = 1 OR e.ref IN (SELECT ref FROM walk_down))
          ORDER BY e.first_observed_at, e.id
          LIMIT ?`,
          [
            ...eligible.params,
            refsJson(input.contextRef === undefined ? [] : [input.contextRef]),
            input.contextRef === undefined ? 1 : 0,
            input.limit,
          ],
        ),
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
      );
    },

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
     * Returns the entity of each of `refs` that is a full record of a work
     * kind, by ref. A place, a partial record and an unknown ref are left out,
     * so a signal on them stays on its own. One statement however many refs
     * there are.
     */
    readSignalEntities: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, SignalEntity>, SqlError> =>
      Effect.map(
        readEntities(refs),
        (rows) =>
          new Map(
            [...rows.values()].filter(isWorkRecord).map((row): [string, SignalEntity] => {
              const { status } = parseStoredStatus(row.status as string | null);
              return [
                row.ref,
                {
                  id: uuidToString(row.id),
                  kind: row.kind as string,
                  identifier: row.identifier as string,
                  title: row.title as string,
                  ...(status === undefined ? {} : { status }),
                },
              ];
            }),
          ),
      ),

    /**
     * Runs `write`, which writes an open signal on the thread `ref`, and
     * returns its result. When the write puts the entity at `ref` onto the
     * Inbox as a card on the clock, the entity takes a number of the arrival
     * counter, stamped at `now` (see `recordArrivalsAfter`). A ref with no
     * entity changes nothing. Run it in the caller's transaction. Announces
     * nothing: the signal's own announcement already refreshes the Inbox.
     */
    recordArrivalAfter: <A, E, R>(
      ref: string,
      now: string,
      askingKinds: ReadonlyArray<string>,
      write: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SqlError, R> =>
      inbox.recordArrivalsAfter([ref], now, askingKinds, write),

    /**
     * Dismisses entities: they leave the Inbox until `restore`, or until an
     * ask is raised on one of them after this call. See `setDismissals` for
     * what it returns.
     */
    dismiss: (ids: ReadonlyArray<string>, actor: string, now: string) =>
      setDismissals(ids, { dismissed: true, actor, now }),

    /** Undoes `dismiss`, and records who did. See `setDismissals` for what it returns. */
    restore: (ids: ReadonlyArray<string>, actor: string, now: string) =>
      setDismissals(ids, { dismissed: false, actor, now }),

    /**
     * Deletes the records nothing needs, and returns how many it deleted. The
     * daily sweep calls it.
     *
     * - An entity goes when it has no concern from any Connection, no link to
     *   any Task (finished ones count), no open signal (snoozed or not),
     *   is not dismissed, is not above
     *   anything concerned or linked (any number of levels up), and has not
     *   changed for 30 days. Its claims stay: they are small and they are
     *   history. A dismissal is never pruned, so a record that came back
     *   cannot undo "only Undo brings it back".
     * - An observation row goes when its ref has no entity, is not wanted
     *   (`WANTED_REFS_SQL`) and has no open signal, so the retry state of a
     *   ref a signal waits on is not lost.
     */
    /**
     * Replaces the stored status of every entity of `kind` whose status key is
     * `key` with `status`, and returns how many entities changed. An entity
     * whose stored status is already `status` is left alone.
     *
     * The time the entity was updated stays as it is, because nothing changed
     * at the source.
     */
    rewriteStatus: (
      kind: string,
      key: string,
      status: StoredEntityStatus,
    ): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql`
          UPDATE external_entities SET status = ${JSON.stringify(status)}
          WHERE kind = ${kind} AND status_key = ${key} AND status IS NOT ${JSON.stringify(status)}
          RETURNING id`,
        (rows) => rows.length,
      ),

    pruneEntities: (now: string): Effect.Effect<PruneResult, SqlError> =>
      Effect.gen(function* () {
        const cutoff = new Date(Date.parse(now) - PRUNE_AFTER_MS).toISOString();
        const entities = yield* sql`
          WITH RECURSIVE
          roots(ref) AS (
            ${sql.literal(RETAINED_ROOT_REFS_SQL)}
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
            AND ref NOT IN (${sql.literal(OPEN_THREAD_REFS_SQL)})
          RETURNING ref`;
        yield* timeline.deleteOrphanedChanges();
        yield* withSql(deleteOrphanedFields());
        return { entities: entities.length, observations: observations.length };
      }),
  };
});

/** Everything that reads and writes External Entities. */
export const externalEntityRepository = make;

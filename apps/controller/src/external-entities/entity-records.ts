/**
 * The rows of External Entities and their observations, and the pure rules
 * that turn them into what the API returns: the access, freshness and
 * concerns of a thing, worked out from the observation of each Connection,
 * and the place a record draws as above the cards.
 *
 * Nothing here reads the database. The repository reads rows, and these
 * functions decide what they mean, so a card, a detail and a place agree.
 */
import type {
  EntityConcern,
  EntityPlace,
  EntityStatus,
  InboxCard,
  TaskStage,
} from "@hercule/contract";
import { ENTITY_CONCERNS } from "@hercule/contract";
import { uuidToString } from "../db";

/**
 * The columns of an entity row that hold what the thing is, written by an
 * observation. A full observation sets all of them. A partial one sets only
 * the ones it carries.
 */
export const SHARED_COLUMNS = [
  "kind",
  "noun",
  "card",
  "home",
  "section",
  "pace",
  "patience",
  "caption",
  "completeness",
  "identifier",
  "title",
  "url",
  "status",
  "lifecycle",
  "person",
  "owner",
  "facts",
  "repository",
  "reason",
  "progress",
  "target_date",
  "waiting_since",
  "source_updated_at",
  "source_revision",
] as const;

export type SharedColumn = (typeof SHARED_COLUMNS)[number];

/** The values of the shared columns. JSON columns hold text. */
export type SharedValues = { readonly [Column in SharedColumn]: string | number | null };

/**
 * The shared columns a card or a place shows. A change to `source_revision`
 * alone changes nothing on screen, so it is not here.
 */
export const VISIBLE_COLUMNS: ReadonlyArray<SharedColumn> = SHARED_COLUMNS.filter(
  (column) => column !== "source_revision",
);

/** One row of `external_entities`. */
export interface EntityRow extends SharedValues {
  readonly id: Uint8Array;
  readonly ref: string;
  readonly concerned_since: string | null;
  readonly first_observed_at: string;
  readonly updated_at: string;
  readonly presented_by: Uint8Array | null;
  readonly dismissed_at: string | null;
  readonly dismissed_by: string | null;
  readonly arrival_sequence: number | null;
}

/** An entity row with whether its presenter can still keep it fresh, for the write path. */
export interface PresentedEntityRow extends EntityRow {
  readonly presenter_usable: number;
}

export type EntityAccess = "ok" | "inaccessible" | "deleted";

/**
 * One row of `external_entity_observations`, with the status and plugin of
 * its Connection and the time that Connection last read the kind completely.
 */
export interface ObservationRow {
  readonly ref: string;
  readonly connection_id: Uint8Array;
  readonly concerns: string;
  readonly owned_by_you: number;
  readonly access: EntityAccess;
  readonly last_refreshed_at: string | null;
  readonly next_attempt_at: string | null;
  readonly attempt_count: number;
  readonly connection_status: string;
  readonly plugin_id: string;
  readonly last_complete_at: string | null;
}

/** What decides whether a Connection can poll now. Plain data, passed in by the service. */
export interface EntityEnvironment {
  /** The one time of this operation, a normalized UTC ISO string. */
  readonly now: string;
  /** The plugins that are active in this process right now. */
  readonly activePluginIds: ReadonlyArray<string>;
}

/** The statuses of a Connection that can poll. */
const POLLING_STATUSES: ReadonlyArray<string> = ["connected", "error"];

/** Checks that the Connection of an observation can poll now. */
export const canPoll = (
  observation: ObservationRow,
  activePluginIds: ReadonlySet<string>,
): boolean =>
  POLLING_STATUSES.includes(observation.connection_status) &&
  activePluginIds.has(observation.plugin_id);

/** Returns the concerns the Connection of one observation reports. */
export const readConcerns = (observation: ObservationRow): ReadonlyArray<EntityConcern> =>
  JSON.parse(observation.concerns) as ReadonlyArray<EntityConcern>;

/**
 * Returns the concerns that any Connection reports, each once, in the order
 * of `ENTITY_CONCERNS`. This is the inventory's answer. `following` is not
 * here, because it comes from a live Task.
 */
export const unionConcerns = (
  observations: ReadonlyArray<ObservationRow>,
): ReadonlyArray<EntityConcern> => {
  const reported = new Set(observations.flatMap(readConcerns));
  return ENTITY_CONCERNS.filter((concern) => reported.has(concern));
};

/**
 * Returns `ok` if any Connection reads the thing, else `deleted` if any was
 * told so, else `inaccessible`. One account's refusal never hides another
 * account's good read.
 */
export const deriveAccess = (observations: ReadonlyArray<ObservationRow>): EntityAccess => {
  if (observations.some((observation) => observation.access === "ok")) return "ok";
  if (observations.some((observation) => observation.access === "deleted")) return "deleted";
  return "inaccessible";
};

/** Checks that any Connection reports the thing as the user's own. */
export const deriveYours = (observations: ReadonlyArray<ObservationRow>): boolean =>
  observations.some((observation) => observation.owned_by_you === 1);

/** Checks that no Connection with a good read of the thing can poll now. */
export const deriveStale = (
  observations: ReadonlyArray<ObservationRow>,
  activePluginIds: ReadonlySet<string>,
): boolean =>
  !observations.some(
    (observation) => observation.access === "ok" && canPoll(observation, activePluginIds),
  );

/**
 * Returns when the facts were last known true: the newest successful read of
 * any Connection, and the newest complete scan of each Connection that still
 * lists the thing. A scan of unrelated items does not make an item that left
 * the inventory look fresh. Falls back to `fallback` when nothing was read.
 */
export const deriveObservedAt = (
  observations: ReadonlyArray<ObservationRow>,
  fallback: string,
): string => {
  const times = observations.flatMap((observation) => [
    ...(observation.last_refreshed_at === null ? [] : [observation.last_refreshed_at]),
    ...(observation.last_complete_at !== null && readConcerns(observation).length > 0
      ? [observation.last_complete_at]
      : []),
  ]);
  return times.reduce((newest, time) => (time > newest ? time : newest), fallback);
};

/** Checks that a Connection read the thing and may be asked again now. */
export const isReadableNow = (
  observation: ObservationRow,
  activePluginIds: ReadonlySet<string>,
  now: string,
): boolean =>
  observation.access === "ok" &&
  canPoll(observation, activePluginIds) &&
  (observation.next_attempt_at === null || observation.next_attempt_at <= now);

/**
 * Decides whether everything above a thing could be read: every ancestor has
 * a record and some Connection reads it now (it is not stale and not backing
 * off), no limit cut the walk, and the ancestors fit the reply.
 */
export const decideContextComplete = (input: {
  readonly cut: boolean;
  readonly ancestors: ReadonlyArray<string>;
  readonly maxAncestors: number;
  readonly records: ReadonlyMap<string, EntityRow>;
  readonly observations: ReadonlyMap<string, ReadonlyArray<ObservationRow>>;
  readonly activePluginIds: ReadonlySet<string>;
  readonly now: string;
}): boolean =>
  !input.cut &&
  input.ancestors.length <= input.maxAncestors &&
  input.ancestors.every(
    (ancestor) =>
      input.records.has(ancestor) &&
      (input.observations.get(ancestor) ?? []).some((observation) =>
        isReadableNow(observation, input.activePluginIds, input.now),
      ),
  );

const readJson = <T>(text: string | number | null): T | undefined =>
  text === null ? undefined : (JSON.parse(String(text)) as T);

/**
 * Parses the `status` column. Returns the status as the public API shows it,
 * and the Task stage that was stored beside it, which the API never shows.
 * Both are undefined for a row with no status.
 */
export const readStoredStatus = (
  text: string | null,
): { readonly status: EntityStatus | undefined; readonly stage: TaskStage | undefined } => {
  const stored = readJson<EntityStatus & { readonly stage?: TaskStage }>(text);
  if (stored === undefined) return { status: undefined, stage: undefined };
  const { stage, ...status } = stored;
  return { status, stage };
};

/**
 * Builds the place a record draws as above the cards. A thing no Connection
 * reads now is restricted: it keeps its kind and noun, and shows no title,
 * status, progress or date.
 */
export const buildPlace = (
  row: EntityRow,
  observations: ReadonlyArray<ObservationRow>,
): EntityPlace => {
  const restricted = deriveAccess(observations) !== "ok";
  const status = restricted ? undefined : readStoredStatus(row.status as string | null).status;
  const progress = restricted
    ? undefined
    : readJson<NonNullable<EntityPlace["progress"]>>(row.progress);
  return {
    ref: row.ref,
    kind: row.kind as string,
    noun: row.noun as string,
    ...(row.caption === null ? {} : { caption: row.caption as string }),
    ...(restricted ? {} : { title: row.title as string }),
    ...(status === undefined ? {} : { status }),
    ...(progress === undefined ? {} : { progress }),
    ...(restricted || row.target_date === null ? {} : { targetDate: row.target_date as string }),
    restricted,
  };
};

/** Checks that a record is a full record of a work kind: the only kind of record a card is made from. */
export const isWorkRecord = (row: EntityRow): boolean =>
  row.completeness === "full" && (row.pace === "fast" || row.pace === "slow");

/** What a card or a detail adds to the row it draws. */
export interface EntityReadInputs {
  readonly row: EntityRow;
  readonly observations: ReadonlyArray<ObservationRow>;
  readonly activePluginIds: ReadonlySet<string>;
  /** The active Task of the ref, when there is one. */
  readonly taskId: string | undefined;
  /** True when a live Task follows the ref (its link was made by `addToWork`). */
  readonly following: boolean;
  readonly ancestors: ReadonlyArray<string>;
  readonly contextComplete: boolean;
}

/**
 * Builds what every read of an entity holds, from the row of a work record
 * and the observations of every Connection. A work record always has a card,
 * an identifier, a URL and a lifecycle: the service refuses an observation of
 * a work kind that lacks one, so the casts below only name what is stored.
 */
export const buildEntityFields = (input: EntityReadInputs): Omit<InboxCard, "side"> => {
  const { row, observations } = input;
  const concerns = unionConcerns(observations);
  const status = readStoredStatus(row.status as string | null).status;
  const person = readJson<NonNullable<InboxCard["person"]>>(row.person);
  const repository = readJson<NonNullable<InboxCard["repository"]>>(row.repository);
  const reason = readJson<NonNullable<InboxCard["reason"]>>(row.reason);
  const waitingSince = (row.waiting_since as string | null) ?? row.concerned_since;
  return {
    id: uuidToString(row.id),
    ref: row.ref,
    kind: row.kind as string,
    noun: row.noun as string,
    card: row.card as "rich" | "compact",
    ...(row.home === null ? {} : { home: row.home as string }),
    ...(row.section === null ? {} : { section: row.section as string }),
    pace: row.pace as "fast" | "slow",
    patience: row.patience as number,
    identifier: row.identifier as string,
    title: row.title as string,
    url: row.url as string,
    ...(status === undefined ? {} : { status }),
    lifecycle: row.lifecycle as "open" | "completed" | "abandoned",
    ...(person === undefined ? {} : { person }),
    yours: deriveYours(observations),
    facts: readJson<InboxCard["facts"]>(row.facts) ?? [],
    ...(repository === undefined ? {} : { repository }),
    concerns: input.following ? [...concerns, "following"] : concerns,
    access: deriveAccess(observations),
    observedAt: deriveObservedAt(observations, row.first_observed_at),
    stale: deriveStale(observations, input.activePluginIds),
    sourceUpdatedAt: row.source_updated_at as string,
    firstObservedAt: row.first_observed_at,
    ...(reason === undefined ? {} : { reason }),
    ...(waitingSince === null ? {} : { waitingSince }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ancestors: input.ancestors,
    contextComplete: input.contextComplete,
  };
};

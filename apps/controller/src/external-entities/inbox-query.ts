/**
 * The reads behind the Inbox: a page of a list, the counts of the rail, and
 * the values the search suggests.
 *
 * What is on the Inbox, and what each core key means, is the Inbox relation
 * (`inbox-relation.ts`). What a clause means is `compileInboxFilter`
 * (`inbox-predicates.ts`). This
 * module composes them into statements and reads only what it shows:
 *
 * - A page is one statement that finds, filters, counts, orders and cuts the
 *   units (keyset pages of `MAX_INBOX_PAGE` things), then batched reads for the
 *   refs of that page alone. A unit is a group of linked things or a thing
 *   that is in no group (`inbox-groups.ts`). The groups come from one
 *   statement over the links among the things on the Inbox, read once per
 *   snapshot.
 * - The counts are a fixed handful of statements, whatever the number of
 *   things, sources, saved queries or pins.
 *
 * The number of statements never depends on the number of things.
 */
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createValidationError,
  MAX_ENTITY_SIGNALS,
  MAX_GRAPH_EDGES,
  MAX_INBOX_ACCOUNTS,
  MAX_INBOX_ASKS,
  MAX_INBOX_HELD_REFS,
  MAX_INBOX_MOVED_THINGS,
  MAX_INBOX_PAGE,
  MAX_INBOX_PAGE_FACET_VALUES,
  MAX_INBOX_RAIL_FACET_VALUES,
  MAX_INBOX_SUGGESTIONS,
  MAX_LIVE_WORKFLOWS,
  type InboxCounts,
  type InboxFacet,
  type InboxFirstPage,
  type InboxGroup,
  type InboxGroupDetail,
  type InboxGroupMember,
  type InboxList,
  type InboxOutline,
  type InboxQuery,
  type InboxReply,
  type InboxThing,
  type InboxValueQuery,
  type InboxValues,
  type Validation,
} from "@hercule/contract";
import { CORE_INBOX_FIELDS, type InboxClause } from "@hercule/plugin-host";
import { uuidFromString, uuidToString, withReadSnapshot } from "../db";
import { runRepository } from "../runs";
import { sessionRepository } from "../sessions";
import { signalRepository } from "../signals";
import type { RegisteredSavedQuery, RegisteredSignalKind } from "../plugins";
import {
  buildLockedLabel,
  deriveAccess,
  deriveObservedAt,
  deriveStale,
  parseStoredStatus,
  type EntityEnvironment,
} from "./entity-records";
import { readFieldValues, type EntityFieldValues } from "./entity-fields";
import { EFFECTIVE_LINK_SQL, makeEntityLinkReads, readLinksAmong } from "./entity-links";
import { makeInboxPopulation } from "./inbox-population";
import { timelineRepository } from "./timeline";
import {
  buildInboxGroup,
  cutPage,
  decideGroups,
  type Group,
  findGroupMadeOf,
  type GroupsByRef,
} from "./inbox-groups";
import {
  compileInboxFilter,
  escapeLike,
  listDeclaredInboxFields,
  type DeclaredInboxField,
  type InboxFilterInput,
} from "./inbox-predicates";
import {
  buildAsksOfRefs,
  buildEligibleEntities,
  buildKeyset,
  buildMatchedEntities,
  buildSortTuple,
  buildSourceOfKindSql,
  CORE_KEYS,
  isCoreKey,
  joinConditions,
  OBSERVING_SQL,
  ORDER_BY,
  parseSourceOfKind,
  READABLE_RECORD_SQL,
  UUID_TEXT,
  type CompiledSql,
  type SortTuple,
  type SqlValue,
} from "./inbox-relation";
import { findSavedQuery, listQuerySignalKinds, listSavedQueries } from "./saved-queries";
import { buildSignalSay } from "./signal-lines";
import { buildWorkflowOfferTarget, makeEntityRowReads } from "./entity-reads";
import { makeWorkflowOfferReads } from "./workflow-offer-reads";

/**
 * What the Inbox reads need to know beyond the database: the plugins that are
 * active, their signal kinds (which ask, and what to call them) and their
 * saved queries. Plain data, read by the service before the call, so no
 * statement waits on a service.
 */
export interface InboxEnvironment extends EntityEnvironment {
  readonly signalKinds: ReadonlyArray<Pick<RegisteredSignalKind, "kind" | "noun" | "asks">>;
  readonly savedQueries: ReadonlyArray<RegisteredSavedQuery>;
  /** The qualified kinds, sorted, that ask the user for a move (`listAskingKinds`). */
  readonly askingKinds: ReadonlyArray<string>;
}

/** The user's own rail settings: what `readInboxOutline` pins and folds. */
export interface InboxRailSettings {
  readonly pins: ReadonlyArray<{
    readonly source: string;
    readonly connectionId?: string;
    readonly key: string;
    readonly value: string;
  }>;
  readonly browseFolded: ReadonlyArray<{ readonly source: string; readonly connectionId?: string }>;
}

// ---------------------------------------------------------------------------
// Lists, cursors and the statement every read starts from
// ---------------------------------------------------------------------------

/**
 * The scope of one read: the list's clauses and how it is ordered. A saved
 * query of a plugin carries the plugin's id as `source`, and its read is tied
 * to that source.
 */
interface ResolvedList {
  readonly clauses: ReadonlyArray<InboxClause>;
  readonly order: "waiting" | "newest";
  readonly source?: string;
}

const resolveList = (
  list: InboxList,
  environment: InboxEnvironment,
): Effect.Effect<ResolvedList, Validation> =>
  "savedQuery" in list
    ? Effect.map(
        findSavedQuery(list.savedQuery, environment.savedQueries),
        (query): ResolvedList => ({
          clauses: query.clauses,
          order: query.order,
          ...(query.source === undefined ? {} : { source: query.source }),
        }),
      )
    : Effect.succeed({
        clauses: [
          {
            key: list.browse.key,
            op: "is",
            value: list.browse.value,
            source: list.browse.source,
            ...(list.browse.connectionId === undefined
              ? {}
              : { connectionId: list.browse.connectionId }),
          },
        ],
        order: "waiting",
      });

/** Fails with `Validation` naming `path` and `message`. */
const failValidation = (path: ReadonlyArray<string>, message: string) =>
  Effect.fail(createValidationError([{ path, message }], message));

/**
 * Compiles the filter of a read, or fails with `Validation` naming the clauses
 * or the text that cannot be answered. `input` is what `compileInboxFilter`
 * takes, less the clock and the signal kinds, which the environment holds.
 */
const compileFilterOrFail = (
  environment: InboxEnvironment,
  input: Omit<InboxFilterInput, "now" | "signalKinds">,
  path: ReadonlyArray<string> | undefined = undefined,
): Effect.Effect<CompiledSql, Validation> => {
  const compiled = compileInboxFilter({
    ...input,
    now: environment.now,
    signalKinds: environment.signalKinds,
  });
  return "problem" in compiled
    ? failValidation(path ?? [compiled.part], compiled.problem)
    : Effect.succeed(compiled);
};

/** Runs a statement written with `?` placeholders. */
const runStatement = <Row extends object>(
  sql: SqlClient.SqlClient,
  statement: string,
  params: ReadonlyArray<SqlValue>,
) => sql.unsafe<Row>(statement, [...params]);

/** What every mode of a query selects, compiled: see `buildSelection`. */
interface Selection {
  readonly list: ResolvedList;
  readonly fields: ReadonlyArray<DeclaredInboxField>;
  readonly filter: CompiledSql;
  /** What a cursor is bound to. */
  readonly hash: string;
}

/** Hashes what a cursor is bound to (the selection and the order), so a cursor never reads another query. */
const hashQuery = (query: InboxQuery, order: string): string =>
  createHash("sha256")
    .update(JSON.stringify([query.list, query.clauses ?? [], query.text ?? "", order]))
    .digest("hex")
    .slice(0, 16);

const encodeCursor = (hash: string, tuple: SortTuple): string =>
  Buffer.from(JSON.stringify({ h: hash, t: tuple })).toString("base64url");

/** Decodes a cursor for the query with `hash`, or returns the sentence that says why it cannot be used. */
const decodeCursor = (cursor: string, hash: string, order: string): SortTuple | string => {
  const wrong =
    "the cursor does not belong to this list and search. Start again from the first page.";
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      h?: unknown;
      t?: unknown;
    };
    if (parsed.h !== hash) return wrong;
    const tuple = parsed.t;
    const length = order === "waiting" ? 3 : 2;
    if (
      !Array.isArray(tuple) ||
      tuple.length !== length ||
      !tuple.every((part) => typeof part === "string" || typeof part === "number")
    ) {
      return wrong;
    }
    return tuple;
  } catch {
    return "the cursor is not one this server wrote. Use the nextCursor of a page, unchanged.";
  }
};

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

/** One facet field of one source, as the declarations of its kinds say. */
interface FacetField {
  readonly source: string;
  readonly key: string;
  readonly label: string;
  readonly plural: string;
  readonly contextKind: string | undefined;
  readonly enumLabels: ReadonlyMap<string, string> | undefined;
  /** The qualified kinds that declare this facet. */
  readonly kinds: ReadonlyArray<string>;
}

/** Lists the facet fields, one per source and key, with the kinds that declare each. */
const listFacetFields = (fields: ReadonlyArray<DeclaredInboxField>): ReadonlyArray<FacetField> => {
  const found = new Map<string, FacetField>();
  for (const field of fields) {
    if (!field.isFacet) continue;
    const source = parseSourceOfKind(field.kind);
    const id = `${source}\u0000${field.key}`;
    const existing = found.get(id);
    found.set(
      id,
      existing === undefined
        ? {
            source,
            key: field.key,
            label: field.label,
            plural: field.plural ?? field.label,
            contextKind: field.contextKind,
            enumLabels:
              field.enumValues === undefined
                ? undefined
                : new Map(field.enumValues.map((entry) => [entry.value, entry.label])),
            kinds: [field.kind],
          }
        : { ...existing, kinds: [...existing.kinds, field.kind] },
    );
  }
  return [...found.values()];
};

/** One row of the facet statement. */
interface FacetRow {
  readonly source: string;
  readonly key: string;
  readonly value: string;
  readonly connection_id: Uint8Array | null;
  readonly n: number;
  /** The record's title, only when some Connection can read the record. */
  readonly title: string | null;
  /** The record's noun, whether or not it can be read. Null when Hercule holds no such record. */
  readonly noun: string | null;
  readonly status: string | null;
  readonly distinct_values: number;
}

/**
 * Reads the values of the facet fields among the things of `matched`, most
 * common first, at most `limit` per source, key and account, and how many
 * values each had.
 *
 * Both groupings come back: by source (`connection_id` null) and by account.
 * The caller uses the second only for a source with several accounts. With
 * `includeKnown`, the records of a facet's context kind that no matched thing
 * holds are added with count 0, so every Linear project is listed. A title is
 * read only for a record some Connection can read.
 */
const readFacetRows = (
  sql: SqlClient.SqlClient,
  matched: CompiledSql,
  facets: ReadonlyArray<FacetField>,
  limit: number,
  includeKnown: boolean,
): Effect.Effect<ReadonlyArray<FacetRow>, SqlError> => {
  if (facets.length === 0) return Effect.succeed([]);
  const pairs = facets.flatMap((facet) =>
    facet.kinds.map((kind) => ({ kind, key: facet.key, ctx: facet.contextKind ?? null })),
  );
  const contexts = facets.flatMap((facet) =>
    facet.contextKind === undefined
      ? []
      : [{ source: facet.source, key: facet.key, ctx: facet.contextKind }],
  );
  const known = includeKnown && contexts.length > 0;
  return runStatement<FacetRow>(
    sql,
    `WITH ${matched.sql},
      pairs AS (
        SELECT json_extract(value, '$.kind') AS kind, json_extract(value, '$.key') AS key
        FROM json_each(?)),
      by_source AS MATERIALIZED (
        SELECT ${buildSourceOfKindSql("m")} AS source, f.key AS key,
          f.text_value AS value, COUNT(*) AS n
        FROM matched m JOIN pairs p ON p.kind = m.kind
          JOIN external_entity_fields f ON f.ref = m.ref AND f.key = p.key AND f.text_value IS NOT NULL
        GROUP BY source, f.key, f.text_value),
      by_account AS MATERIALIZED (
        SELECT ${buildSourceOfKindSql("m")} AS source, f.key AS key,
          f.text_value AS value, o.connection_id AS connection_id, COUNT(*) AS n
        FROM matched m JOIN pairs p ON p.kind = m.kind
          JOIN external_entity_fields f ON f.ref = m.ref AND f.key = p.key AND f.text_value IS NOT NULL
          JOIN external_entity_observations o ON o.ref = m.ref AND ${OBSERVING_SQL}
        GROUP BY source, f.key, f.text_value, o.connection_id)
      ${
        known
          ? `, contexts AS (
              SELECT json_extract(value, '$.source') AS source, json_extract(value, '$.key') AS key,
                json_extract(value, '$.ctx') AS ctx
              FROM json_each(?)),
            accounts AS (SELECT plugin_id AS source, id AS connection_id FROM connections),
            known_all AS (
              SELECT c.source AS source, c.key AS key, t.ref AS value, NULL AS connection_id, 0 AS n
              FROM contexts c JOIN external_entities t ON t.kind = c.ctx
              WHERE ${READABLE_RECORD_SQL}
                AND NOT EXISTS (SELECT 1 FROM by_source h
                                WHERE h.source = c.source AND h.key = c.key AND h.value = t.ref)),
            known_account AS (
              SELECT c.source AS source, c.key AS key, t.ref AS value, a.connection_id AS connection_id,
                0 AS n
              FROM contexts c JOIN accounts a ON a.source = c.source
                JOIN external_entities t ON t.kind = c.ctx
              WHERE EXISTS (SELECT 1 FROM external_entity_observations o
                            WHERE o.ref = t.ref AND o.connection_id = a.connection_id
                              AND ${OBSERVING_SQL})
                AND NOT EXISTS (SELECT 1 FROM by_account h
                                WHERE h.source = c.source AND h.key = c.key AND h.value = t.ref
                                  AND h.connection_id = a.connection_id))`
          : ""
      },
      grouped AS (
        SELECT source, key, value, NULL AS connection_id, n FROM by_source
        UNION ALL SELECT source, key, value, connection_id, n FROM by_account
        ${known ? "UNION ALL SELECT * FROM known_all UNION ALL SELECT * FROM known_account" : ""}),
      titled AS (
        SELECT g.*, CASE WHEN ${READABLE_RECORD_SQL} THEN t.title END AS title,
          t.noun AS noun, CASE WHEN ${READABLE_RECORD_SQL} THEN t.status END AS status
        FROM grouped g LEFT JOIN external_entities t ON t.ref = g.value),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY source, key, connection_id
                             ORDER BY n DESC, COALESCE(title, value) COLLATE NOCASE, value) AS rn,
          COUNT(*) OVER (PARTITION BY source, key, connection_id) AS distinct_values
        FROM titled)
      SELECT source, key, value, connection_id, n, title, noun, status, distinct_values
      FROM ranked WHERE rn <= ?
      ORDER BY source, key, connection_id, rn`,
    [...matched.params, JSON.stringify(pairs), ...(known ? [JSON.stringify(contexts)] : []), limit],
  );
};

/** The most values of an enum field or signal kinds that a suggestion read matches by label in code. */
const MAX_LABELLED_IN_CODE_VALUES = 1000;

/** One account that holds things of a source. */
interface SourceAccount {
  readonly source: string;
  readonly connectionId: string;
  readonly label: string;
  readonly count: number;
}

/**
 * Builds the facets of the result from the rows `readFacetRows` returned. A
 * source with several accounts gets one facet per account, and any other
 * source one facet. `accounts` lists the accounts that hold things of each
 * source.
 */
const buildFacets = (
  rows: ReadonlyArray<FacetRow>,
  facetFields: ReadonlyArray<FacetField>,
  accounts: ReadonlyMap<string, ReadonlyArray<SourceAccount>>,
  limit: number,
): ReadonlyArray<InboxFacet> => {
  const byId = new Map<
    string,
    { facet: FacetField; connectionId: string | undefined; rows: Array<FacetRow> }
  >();
  for (const row of rows) {
    const own = accounts.get(row.source) ?? [];
    const several = own.length > 1;
    if (several === (row.connection_id === null)) continue;
    const field = facetFields.find((entry) => entry.source === row.source && entry.key === row.key);
    if (field === undefined) continue;
    const connectionId = row.connection_id === null ? undefined : uuidToString(row.connection_id);
    // An account that holds none of the result's things has no row in the rail.
    if (connectionId !== undefined && !own.some((entry) => entry.connectionId === connectionId)) {
      continue;
    }
    const id = `${row.source}\u0000${row.key}\u0000${connectionId ?? ""}`;
    const entry = byId.get(id) ?? { facet: field, connectionId, rows: [] };
    entry.rows.push(row);
    byId.set(id, entry);
  }
  return [...byId.values()].map(({ facet, connectionId, rows: facetRows }) => ({
    source: facet.source,
    ...(connectionId === undefined ? {} : { connectionId }),
    key: facet.key,
    label: facet.label,
    plural: facet.plural,
    values: facetRows.slice(0, limit).map((row) => {
      const health = parseStoredStatus(row.status).status;
      return {
        value: row.value,
        label:
          row.title ??
          facet.enumLabels?.get(row.value) ??
          (facet.contextKind === undefined ? row.value : buildLockedLabel(row.noun)),
        count: row.n,
        ...(health === undefined ? {} : { health }),
      };
    }),
    more: Math.max(0, (facetRows[0]?.distinct_values ?? 0) - limit),
  }));
};

/**
 * Reads, for each source, the accounts that hold things of `matched`, with
 * their labels and counts, and the number of things of the source. One
 * statement.
 */
const readSourceCounts = (
  sql: SqlClient.SqlClient,
  matched: CompiledSql,
): Effect.Effect<
  {
    readonly sources: ReadonlyMap<string, number>;
    readonly accounts: ReadonlyMap<string, ReadonlyArray<SourceAccount>>;
  },
  SqlError
> =>
  Effect.map(
    runStatement<{
      readonly source: string;
      readonly connection_id: Uint8Array | null;
      readonly label: string | null;
      readonly n: number;
    }>(
      sql,
      `WITH ${matched.sql}
       SELECT ${buildSourceOfKindSql("m")} AS source, NULL AS connection_id,
         NULL AS label, COUNT(*) AS n
       FROM matched m GROUP BY source
       UNION ALL
       SELECT ${buildSourceOfKindSql("m")} AS source, o.connection_id,
         c.label, COUNT(DISTINCT m.ref) AS n
       FROM matched m JOIN external_entity_observations o ON o.ref = m.ref AND ${OBSERVING_SQL}
         JOIN connections c ON c.id = o.connection_id
       GROUP BY source, o.connection_id
       ORDER BY source, 3`,
      matched.params,
    ),
    (rows) => {
      const sources = new Map<string, number>();
      const accounts = new Map<string, Array<SourceAccount>>();
      for (const row of rows) {
        if (row.connection_id === null) {
          sources.set(row.source, row.n);
          continue;
        }
        const list = accounts.get(row.source) ?? [];
        list.push({
          source: row.source,
          connectionId: uuidToString(row.connection_id),
          label: row.label!,
          count: row.n,
        });
        accounts.set(row.source, list);
      }
      return { sources, accounts };
    },
  );

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

/** What the first statement of a page returns for one thing. */
interface PageRow {
  readonly ref: string;
  readonly task_id: Uint8Array | null;
  /** The active Task's title, read in the page statement. Null when `task_id` is. */
  readonly task_title: string | null;
  readonly oldest_ask: string | null;
  readonly upd: string;
  readonly grp: number;
  /** The key of the unit the row places: the label ref of its group, or its own ref. */
  readonly unit: string;
  /** Only on the first page. */
  readonly total?: number;
}

/** A member of a group, as the members statement returns it. */
interface MemberRow {
  readonly id: Uint8Array;
  readonly ref: string;
  readonly task_id: Uint8Array | null;
  readonly task_title: string | null;
  readonly oldest_ask: string | null;
  readonly upd: string;
  readonly grp: number;
  /** 1 when the member answers the query of the list. */
  readonly matches: number;
}

/** What `readGroups` reads of a thing that is at the end of a link and on the Inbox. */
interface GroupRow {
  readonly ref: string;
  readonly kind: string;
  readonly title: string;
  readonly created_at: string;
}

/** Converts a row of the members statement to the member a reply lists. */
const describeMember = (member: MemberRow): InboxGroupMember => ({
  id: uuidToString(member.id),
  ref: member.ref,
  matches: member.matches === 1,
});

/** The things of a reply, the groups they form, and where the reply ended. */
interface UnitsRead {
  readonly things: ReadonlyArray<InboxThing>;
  readonly groups: ReadonlyArray<InboxGroup>;
  readonly offerSets: InboxFirstPage["offerSets"];
  /** The placing row of the last unit the reply holds, which a cursor continues after. */
  readonly lastRow: PageRow | undefined;
  /** True when units were left for a later page. */
  readonly more: boolean;
}

/** One open ask of a thing, as the asks statement returns it. */
interface AskRow {
  readonly ref: string;
  readonly id: Uint8Array;
  readonly kind: string;
  readonly asker: string | null;
  readonly created_at: string;
  readonly title: string;
  readonly ask_count: number;
  readonly kinds: string;
}

/** Builds the reads of the Inbox: a page, the counts, the outline of the rail and the suggested values. */
export const externalEntityInbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const signals = yield* signalRepository;
  const runs = yield* runRepository;
  const sessions = yield* sessionRepository;
  const offerReads = yield* makeWorkflowOfferReads;
  const timeline = yield* timelineRepository;
  const linkReads = makeEntityLinkReads(sql, timeline.readLatestChanges);
  const population = makeInboxPopulation(sql);
  const { readEntities, readObservations } = makeEntityRowReads(sql);

  /** Runs a read of the field table with this client. */
  const withSql = Effect.provideService(SqlClient.SqlClient, sql);

  /**
   * Reads the asks of `refs`: at most `MAX_INBOX_ASKS` of each, newest first,
   * with how many it has and the distinct kinds of all of them. One statement.
   */
  const readAsks = (
    environment: InboxEnvironment,
    refs: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<AskRow>>, SqlError> => {
    if (refs.length === 0) return Effect.succeed(new Map());
    const own = buildAsksOfRefs(refs, environment);
    return Effect.map(
      runStatement<AskRow>(
        sql,
        `WITH ${own.sql},
          page_asks AS (
            SELECT a.ref, a.id, a.kind, a.asker, a.created_at,
              ROW_NUMBER() OVER (PARTITION BY a.ref ORDER BY a.created_at DESC, a.id DESC) AS rn
            FROM asks a),
          kinds AS (
            SELECT ref, json_group_array(kind) AS kinds FROM (
              SELECT DISTINCT a.ref AS ref, a.kind AS kind FROM asks a ORDER BY a.ref, a.kind)
            GROUP BY ref)
         SELECT p.ref, p.id, p.kind, p.asker, p.created_at, s.title, y.ask_count, k.kinds
         FROM page_asks p JOIN signals s ON s.id = p.id
           JOIN ask_summary y ON y.ref = p.ref JOIN kinds k ON k.ref = p.ref
         WHERE p.rn <= ${MAX_INBOX_ASKS}
         ORDER BY p.ref, p.created_at DESC, p.id DESC`,
        own.params,
      ),
      (rows) => {
        const asks = new Map<string, Array<AskRow>>();
        for (const row of rows) {
          const list = asks.get(row.ref) ?? [];
          list.push(row);
          asks.set(row.ref, list);
        }
        return asks;
      },
    );
  };

  /** Builds the things of a page, in the order of `rows`, from the batched reads of their refs. */
  const hydrate = (
    environment: InboxEnvironment,
    rows: ReadonlyArray<Pick<PageRow, "ref" | "task_id" | "task_title" | "oldest_ask">>,
  ): Effect.Effect<
    { readonly things: ReadonlyArray<InboxThing>; readonly offerSets: InboxFirstPage["offerSets"] },
    SqlError
  > =>
    Effect.gen(function* () {
      const entities = yield* readEntities(rows.map((row) => row.ref));
      // A thing the page statement found can be pruned before this read; it is
      // left out, as it no longer belongs to the list.
      const present = rows.filter((row) => entities.has(row.ref));
      const refs = present.map((row) => row.ref);
      const observations = yield* readObservations(refs);
      const asks = yield* readAsks(environment, refs);
      const openKinds = yield* signals.listOpenKindsByThread(refs, MAX_ENTITY_SIGNALS);
      const fieldValues: ReadonlyMap<string, EntityFieldValues> = yield* withSql(
        readFieldValues(refs, environment.activeEntityKinds),
      );
      const offers = yield* offerReads.readWorkflowOffers(
        refs.map((ref) => buildWorkflowOfferTarget(entities.get(ref)!)),
        environment.kindSources ?? [],
      );
      const taskIds = present.flatMap((row) =>
        row.task_id === null ? [] : [uuidToString(row.task_id)],
      );
      const liveWorkflows = yield* runs.listLiveWorkflowsOfTasks(taskIds, MAX_LIVE_WORKFLOWS);
      const workingThreads = yield* sessions.countWorkingThreadsOfTasks(taskIds);
      // Every ask is of a kind the registry declares (`askingKinds`), so it has a noun.
      const nouns = new Map(environment.signalKinds.map((kind) => [kind.kind, kind.noun]));
      const activePluginIds = new Set(environment.activePluginIds);

      const things = present.map((page): InboxThing => {
        const row = entities.get(page.ref)!;
        const own = observations.get(page.ref) ?? [];
        const status = parseStoredStatus(row.status as string | null).status;
        const taskId = page.task_id === null ? undefined : uuidToString(page.task_id);
        const found = asks.get(page.ref) ?? [];
        const accounts = [
          ...new Set(
            own
              .filter((entry) => entry.access === "ok" || entry.concerns !== "[]")
              .map((entry) => uuidToString(entry.connection_id)),
          ),
        ]
          .sort()
          .slice(0, MAX_INBOX_ACCOUNTS);
        return {
          id: uuidToString(row.id),
          ref: row.ref,
          kind: row.kind as string,
          noun: row.noun as string,
          source: parseSourceOfKind(row.kind as string),
          identifier: row.identifier as string,
          title: row.title as string,
          url: row.url as string,
          ...(status === undefined ? {} : { status }),
          access: deriveAccess(own),
          stale: deriveStale(own, activePluginIds),
          observedAt: deriveObservedAt(own, row.first_observed_at),
          sourceUpdatedAt: row.source_updated_at as string,
          patience: row.patience as number,
          face: fieldValues.get(page.ref)?.face ?? null,
          asks: found.map((ask) => ({
            id: uuidToString(ask.id),
            kind: ask.kind,
            noun: nouns.get(ask.kind)!,
            ...(ask.asker === null ? {} : { asker: ask.asker }),
            say: buildSignalSay(
              {
                kind: ask.kind,
                title: ask.title,
                ...(ask.asker === null ? {} : { asker: ask.asker }),
              },
              row.reason_templates as string | null,
            ),
            createdAt: ask.created_at,
          })),
          askCount: found[0]?.ask_count ?? 0,
          askKinds: found[0] === undefined ? [] : (JSON.parse(found[0].kinds) as Array<string>),
          openKinds: openKinds.get(page.ref) ?? [],
          ...(page.oldest_ask === null ? {} : { waitingSince: page.oldest_ask }),
          ...(taskId === undefined
            ? {}
            : {
                task: {
                  id: taskId,
                  title: page.task_title!,
                  workingThreadCount: workingThreads.get(taskId) ?? 0,
                },
              }),
          liveWorkflows: taskId === undefined ? [] : (liveWorkflows.get(taskId) ?? []),
          ...(row.dismissed_at === null ? {} : { dismissedAt: row.dismissed_at }),
          arrival: row.arrival_sequence ?? 0,
          offerSetId: offers.offerSetIds.get(page.ref)!,
          actingConnections: offers.actingConnections.get(page.ref) ?? [],
          accounts,
        };
      });
      return { things, offerSets: offers.offerSets };
    });

  /**
   * Compiles what every mode of a query selects: the list, the filter of its
   * clauses and text, and the hash a cursor is bound to. Fails with
   * `Validation` for an unknown saved query, or a clause or text that cannot
   * be answered.
   */
  const buildSelection = (
    environment: InboxEnvironment,
    query: InboxQuery,
  ): Effect.Effect<Selection, Validation> =>
    Effect.gen(function* () {
      const list = yield* resolveList(query.list, environment);
      const fields = listDeclaredInboxFields(environment.activeEntityKinds ?? []);
      const filter = yield* compileFilterOrFail(environment, {
        clauses: [...list.clauses, ...(query.clauses ?? [])],
        text: query.text ?? "",
        fields,
        ...(list.source === undefined ? {} : { tie: { source: list.source } }),
      });
      return { list, fields, filter, hash: hashQuery(query, list.order) };
    });

  /**
   * Reads the groups of the Inbox: the links that join things (a link a source
   * or a person made), then, for the things at the ends of those links only,
   * whether they are on the Inbox and the facts that electing a group's label
   * needs. A link counts only when both its ends are on the Inbox, and a thing
   * that is not on the Inbox joins nothing. The first statement reads the
   * claims of the links, so the cost follows the number of links, not the
   * number of things on the Inbox; with no links there is no second statement.
   */
  const readGroups = (environment: InboxEnvironment): Effect.Effect<GroupsByRef, SqlError> =>
    Effect.gen(function* () {
      const pairs = yield* runStatement<{ readonly a: string; readonly b: string }>(
        sql,
        `SELECT DISTINCT c.from_ref AS a, c.to_ref AS b
         FROM external_entity_relation_claims c
         WHERE ${EFFECTIVE_LINK_SQL} AND c.from_ref <> c.to_ref`,
        [],
      );
      const lasting = new Map(
        (environment.activeEntityKinds ?? []).map((kind) => [kind.kind, kind.lasting ?? 0]),
      );
      if (pairs.length === 0) return decideGroups([], [], lasting);
      const ends = [...new Set(pairs.flatMap((pair) => [pair.a, pair.b]))];
      const eligible = buildEligibleEntities(environment, ends);
      const things = yield* runStatement<GroupRow>(
        sql,
        `WITH ${eligible.sql}
         SELECT e.ref, e.kind, e.title, COALESCE(e.source_created_at, e.first_observed_at) AS created_at
         FROM eligible e`,
        eligible.params,
      );
      const onInbox = new Set(things.map((thing) => thing.ref));
      return decideGroups(
        things.map((row) => ({
          ref: row.ref,
          kind: row.kind,
          title: row.title,
          createdAt: row.created_at,
        })),
        pairs
          .filter((pair) => onInbox.has(pair.a) && onInbox.has(pair.b))
          .map((pair) => ({ fromRef: pair.a, toRef: pair.b })),
        lasting,
      );
    });

  /**
   * Reads the group of `ref` among the things on the Inbox, in full, or none
   * when `ref` is not on the Inbox. The group is decided by `readGroups`, as
   * `queryInbox` decides it, inside one read snapshot.
   *
   * - A thing linked to nothing on the Inbox is a group of one, titled by its
   *   peer (its ref when the peer is restricted and shows no title).
   * - Members are the label thing, then the others sorted by ref, cut at
   *   `MAX_INBOX_MOVED_THINGS`; `links` are cut at `MAX_GRAPH_EDGES`.
   *   `complete` is false when either was cut.
   *
   * A fixed number of statements however large the group is: the groups, the
   * eligibility of `ref` (only when it is in no group), the members' records,
   * observations and latest changes, and the links.
   */
  const readInboxGroup = (
    environment: InboxEnvironment,
    ref: string,
  ): Effect.Effect<Option.Option<InboxGroupDetail>, SqlError> =>
    withReadSnapshot(
      sql,
      Effect.gen(function* () {
        const group = (yield* readGroups(environment)).get(ref);
        if (
          group === undefined &&
          !(yield* population.listEligibleRefs([ref], environment)).has(ref)
        ) {
          return Option.none();
        }
        const everyone = group?.memberRefs ?? [ref];
        const labelRef = group?.labelRef ?? ref;
        const shown = [labelRef, ...everyone.filter((member) => member !== labelRef)].slice(
          0,
          MAX_INBOX_MOVED_THINGS,
        );
        const found = yield* linkReads.listPeers(new Set(), shown, environment.activeEntityKinds);
        const peers = new Map(found.map((peer) => [peer.ref, peer] as const));
        const members = shown.flatMap((member) => peers.get(member) ?? []);
        const { links, complete: linksComplete } =
          shown.length < 2
            ? { links: [], complete: true }
            : yield* readLinksAmong(sql, shown, MAX_GRAPH_EDGES);
        return Option.some({
          labelRef,
          label: group?.label ?? peers.get(ref)?.title ?? ref,
          members,
          links,
          complete: shown.length === everyone.length && linksComplete,
        });
      }),
    );

  /**
   * Reads the rows that place the units of a list: one row for each unit that
   * has a member answering the selection, which is its first matching member in
   * the list's order. A lone thing places itself. The rows are in the list's
   * order, after `tuple` when there is one, at most `limit` of them. With
   * `onlyRefs`, only those things are looked at (the whole of every unit that
   * is wanted). One statement.
   *
   * A group is ranked here, before the keyset, so a cursor that continues after
   * a unit's placing row never meets the group again. Only the things in a
   * group are ranked in a window, so the cost of a list with few groups is the
   * cost of a list with none.
   */
  const readPlacingRows = (
    matched: ReturnType<typeof buildMatchedEntities>,
    selection: Selection,
    groups: GroupsByRef,
    options: {
      readonly tuple: SortTuple | undefined;
      readonly limit: number;
      readonly withTotal: boolean;
    },
  ) => {
    const order = ORDER_BY[selection.list.order];
    const where = buildKeyset(selection.list.order, options.tuple);
    return runStatement<PageRow>(
      sql,
      `WITH ${matched.sql},
        grouped(ref, unit) AS (SELECT key, value FROM json_each(?)),
        placed AS (
          SELECT m.ref, m.task_id, m.oldest_ask, m.upd, m.grp, m.ref AS unit
          FROM matched m WHERE m.ref NOT IN (SELECT ref FROM grouped)
          UNION ALL
          SELECT ref, task_id, oldest_ask, upd, grp, unit FROM (
            SELECT m.ref, m.task_id, m.oldest_ask, m.upd, m.grp, g.unit,
              ROW_NUMBER() OVER (PARTITION BY g.unit ORDER BY ${order}) AS rn
            FROM matched m JOIN grouped g ON g.ref = m.ref)
          WHERE rn = 1)
       -- The inner select sorts and cuts the page first, so the Task title is
       -- looked up for the few rows of the page, not for every placed unit.
       SELECT m.ref, m.task_id, (SELECT t.title FROM tasks t WHERE t.id = m.task_id) AS task_title,
              m.oldest_ask, m.upd, m.grp, m.unit${options.withTotal ? ", m.total" : ""}
       FROM (
         SELECT m.ref, m.task_id, m.oldest_ask, m.upd, m.grp, m.unit
           ${options.withTotal ? ", (SELECT COUNT(*) FROM matched) AS total" : ""}
         FROM placed m WHERE ${where.sql}
         ORDER BY ${order} LIMIT ?
       ) m
       ORDER BY ${order}`,
      [
        ...matched.params,
        JSON.stringify(
          Object.fromEntries([...groups].map(([ref, group]) => [ref, group.labelRef])),
        ),
        ...where.params,
        options.limit,
      ],
    );
  };

  /**
   * Reads the members of the groups `wanted`: the ones that answer the
   * selection first, then the others, each part in the list's order, at most
   * `MAX_INBOX_MOVED_THINGS` of each group. One statement, over the refs of
   * those groups alone. A member is on the Inbox, so it has a row whether it
   * answers or not. The cut is made per group in the statement, so a group of
   * thousands sends only what a reply holds.
   */
  const readMembers = (
    environment: InboxEnvironment,
    selection: Selection,
    wanted: ReadonlyArray<Group>,
  ) => {
    const refs = wanted.flatMap((group) => group.memberRefs);
    const eligible = buildEligibleEntities(environment, refs);
    const order = ORDER_BY[selection.list.order];
    return runStatement<MemberRow>(
      sql,
      `WITH ${eligible.sql}
       SELECT m.id, m.ref, m.task_id, m.task_title, m.oldest_ask, m.upd, m.grp, m.matches FROM (
         SELECT m.id, m.ref, m.task_id, m.task_title, m.oldest_ask, m.upd, m.grp, m.matches,
           ROW_NUMBER() OVER (PARTITION BY u.value ORDER BY m.matches DESC, ${order}) AS rn
         FROM (
           SELECT e.id, e.ref, e.task_id,
             (SELECT t.title FROM tasks t WHERE t.id = e.task_id) AS task_title,
             e.oldest_ask, e.source_updated_at AS upd,
             CASE WHEN e.oldest_ask IS NULL THEN 1 ELSE 0 END AS grp,
             CASE WHEN ${selection.filter.sql} THEN 1 ELSE 0 END AS matches
           FROM eligible e) m
         JOIN json_each(?) u ON u.key = m.ref) m
       WHERE m.rn <= ${MAX_INBOX_MOVED_THINGS}
       ORDER BY m.matches DESC, ${order}`,
      [
        ...eligible.params,
        ...selection.filter.params,
        JSON.stringify(
          Object.fromEntries(
            wanted.flatMap((group) => group.memberRefs.map((ref) => [ref, group.labelRef])),
          ),
        ),
      ],
    );
  };

  /**
   * Reads the members of `wanted` in one batch and returns them by the label
   * ref of their group, each list with the members that answer the selection
   * first.
   */
  const readMembersByUnit = (
    environment: InboxEnvironment,
    selection: Selection,
    groups: GroupsByRef,
    wanted: ReadonlyArray<Group>,
  ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<MemberRow>>, SqlError> =>
    Effect.gen(function* () {
      const byUnit = new Map<string, Array<MemberRow>>();
      if (wanted.length === 0) return byUnit;
      const members = yield* readMembers(environment, selection, wanted);
      for (const member of members) {
        const key = groups.get(member.ref)?.labelRef ?? member.ref;
        const unitMembers = byUnit.get(key) ?? [];
        unitMembers.push(member);
        byUnit.set(key, unitMembers);
      }
      return byUnit;
    });

  /**
   * Cuts `placing`, the rows that place the units in list order, to `budget`
   * things (see `cutPage`), reads the members of the groups it keeps in one
   * batch, and hydrates the things of the page. The things of a unit are
   * contiguous, in the list's order. Of a group that the cut shortens, the
   * reply holds its first members, but its `InboxGroup` still names them all.
   */
  const readUnits = (
    environment: InboxEnvironment,
    selection: Selection,
    groups: GroupsByRef,
    placing: ReadonlyArray<PageRow>,
    budget: number,
  ): Effect.Effect<UnitsRead, SqlError> =>
    Effect.gen(function* () {
      const cut = cutPage(
        placing.map((row) => ({
          key: row.unit,
          size: groups.get(row.ref)?.memberRefs.length ?? 1,
          row,
        })),
        budget,
      );
      const keptGroups = cut.kept.flatMap(({ unit }) => {
        const group = groups.get(unit.row.ref);
        return group === undefined ? [] : [group];
      });
      const membersByUnit = yield* readMembersByUnit(environment, selection, groups, keptGroups);

      const rows: Array<Pick<PageRow, "ref" | "task_id" | "task_title" | "oldest_ask">> = [];
      for (const { unit, take } of cut.kept) {
        if (!groups.has(unit.row.ref)) rows.push(unit.row);
        else rows.push(...membersByUnit.get(unit.key)!.slice(0, take));
      }
      const inboxGroups = keptGroups.map((group) =>
        buildInboxGroup(group, membersByUnit.get(group.labelRef)!.map(describeMember)),
      );
      const { things, offerSets } = yield* hydrate(environment, rows);
      return {
        things,
        groups: inboxGroups,
        offerSets,
        lastRow: cut.kept.at(-1)?.unit.row,
        more: cut.more,
      };
    });

  /**
   * Reads one page of the selection after `tuple` (the first page when it is
   * absent): the statement for the rows that place the units, one for the
   * members of its groups, then the batched reads of the details. The first
   * page also counts the whole result.
   */
  const readPage = (
    environment: InboxEnvironment,
    selection: Selection,
    groups: GroupsByRef,
    tuple: SortTuple | undefined,
    budget: number,
  ) =>
    Effect.gen(function* () {
      const { list, filter, hash } = selection;
      const matched = buildMatchedEntities(environment, filter);
      const placing = yield* readPlacingRows(matched, selection, groups, {
        tuple,
        limit: budget + 1,
        withTotal: tuple === undefined,
      });
      const read = yield* readUnits(environment, selection, groups, placing, budget);
      const nextCursor =
        read.more && read.lastRow !== undefined
          ? encodeCursor(hash, buildSortTuple(list.order, read.lastRow))
          : undefined;
      return {
        matched,
        things: read.things,
        groups: read.groups,
        offerSets: read.offerSets,
        // A first page has no keyset, so it has no rows only when nothing matches.
        total: placing[0]?.total ?? 0,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    });

  /** Reads the first page of the selection, at most `budget` things, with its total and its facets. */
  const readFirstPage = (
    environment: InboxEnvironment,
    selection: Selection,
    groups: GroupsByRef,
    budget: number,
  ): Effect.Effect<InboxFirstPage, SqlError> =>
    Effect.gen(function* () {
      const page = yield* readPage(environment, selection, groups, undefined, budget);
      const facetFields = listFacetFields(selection.fields);
      const { accounts } = yield* readSourceCounts(sql, page.matched);
      const facetRows = yield* readFacetRows(
        sql,
        page.matched,
        facetFields,
        MAX_INBOX_PAGE_FACET_VALUES,
        false,
      );
      return {
        mode: "first",
        things: page.things,
        groups: page.groups,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        total: page.total,
        order: selection.list.order,
        facets: buildFacets(facetRows, facetFields, accounts, MAX_INBOX_PAGE_FACET_VALUES),
        offerSets: page.offerSets,
      };
    });

  /**
   * Reads the things of `held` that are still on the list, in the list's
   * order, and describes the groups they are in. A held thing is on the list
   * when it answers the selection, or when it is a member of a group that has
   * a member that answers (the group is on the list, and the thing is drawn
   * quieter in it). One statement for the members of the groups of the held
   * things, one for the rows, then the batched reads of the details. A held
   * ref that is not on the list, or was pruned, is not in the reply. Members
   * that are not held are not hydrated: the group only names them.
   *
   * A group lists at most `MAX_INBOX_MOVED_THINGS` of its members, but a held
   * ref of an answering group stays on the list and in the group's `members`
   * wherever it stands in the group: one more statement reads those beyond the
   * cap.
   */
  const readHeldRows = (
    environment: InboxEnvironment,
    selection: Selection,
    groups: GroupsByRef,
    held: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const heldGroups = [
        ...new Map(
          held.flatMap((ref) => {
            const group = groups.get(ref);
            return group === undefined ? [] : [[group.labelRef, group] as const];
          }),
        ).values(),
      ];
      const membersByUnit = yield* readMembersByUnit(environment, selection, groups, heldGroups);
      const heldSet = new Set(held);
      // A group has a member that answers exactly when its first member does:
      // the members that answer come first. The capped read is enough for that.
      // Every held ref of such a group stays, however far down the group it is.
      const answeringGroups = new Set(
        [...membersByUnit].flatMap(([key, members]) => (members[0]?.matches === 1 ? [key] : [])),
      );
      const quiet = held.filter((ref) => {
        const group = groups.get(ref);
        return group !== undefined && answeringGroups.has(group.labelRef);
      });
      const onList = joinConditions("OR", [
        selection.filter,
        {
          sql: "e.ref IN (SELECT value FROM json_each(?))",
          params: [JSON.stringify(quiet)],
        },
      ]);
      const matched = buildMatchedEntities(environment, onList, undefined, held);
      const rows = yield* runStatement<PageRow>(
        sql,
        `WITH ${matched.sql}
         SELECT m.ref, m.task_id, (SELECT t.title FROM tasks t WHERE t.id = m.task_id) AS task_title,
                m.oldest_ask, m.upd, m.grp
         FROM (
           SELECT m.ref, m.task_id, m.oldest_ask, m.upd, m.grp
           FROM matched m ORDER BY ${ORDER_BY[selection.list.order]} LIMIT ?
         ) m
         ORDER BY ${ORDER_BY[selection.list.order]}`,
        [...matched.params, MAX_INBOX_HELD_REFS],
      );
      const groupsOfThings = new Set(rows.map((row) => groups.get(row.ref)?.labelRef));
      const { things, offerSets } = yield* hydrate(environment, rows);
      // A held ref beyond the cap of its group's capped read is not in
      // `membersByUnit`. It is read apart, so its group always lists it.
      const listedRefs = new Set(
        [...membersByUnit.values()].flatMap((members) => members.map((member) => member.ref)),
      );
      const beyondCap = heldGroups.flatMap((group) => {
        const refs = group.memberRefs.filter((ref) => heldSet.has(ref) && !listedRefs.has(ref));
        return refs.length === 0 || !answeringGroups.has(group.labelRef)
          ? []
          : [{ ...group, memberRefs: refs }];
      });
      const heldBeyondCap = yield* readMembersByUnit(environment, selection, groups, beyondCap);
      return {
        things,
        groups: heldGroups
          .filter((group) => groupsOfThings.has(group.labelRef))
          .map((group) =>
            buildInboxGroup(
              group,
              [
                ...membersByUnit.get(group.labelRef)!,
                ...(heldBeyondCap.get(group.labelRef) ?? []),
              ].map(describeMember),
            ),
          ),
        offerSets,
      };
    });

  /**
   * Reads one `queryInbox` in the mode it asks for: see `InboxQuery` and
   * `InboxReply`. A page is one statement for its rows, then the batched reads
   * of their details, so the number of statements depends on the mode and
   * never on the number of things. Every mode reads in one read snapshot, so
   * the first page with its counts and facets, a page, the held rows of
   * `rows`, and the first page with the held rows of `refresh` each show the
   * database at one moment.
   *
   * Fails with `Validation` for an unknown saved query, a clause or text that
   * cannot be answered, or a cursor that does not belong to the selection.
   */
  const queryInbox = (
    environment: InboxEnvironment,
    query: InboxQuery,
  ): Effect.Effect<InboxReply, SqlError | Validation> =>
    Effect.gen(function* () {
      const selection = yield* buildSelection(environment, query);
      return yield* withReadSnapshot(sql, readInMode(environment, selection, query));
    });

  /** Reads the reply of `query` in its mode. It must run inside one read snapshot. */
  const readInMode = (
    environment: InboxEnvironment,
    selection: Selection,
    query: InboxQuery,
  ): Effect.Effect<InboxReply, SqlError | Validation> =>
    Effect.gen(function* () {
      switch (query.mode) {
        case "first":
          return yield* readFirstPage(
            environment,
            selection,
            yield* readGroups(environment),
            query.limit ?? MAX_INBOX_PAGE,
          );
        case "next": {
          const tuple = decodeCursor(query.after, selection.hash, selection.list.order);
          if (typeof tuple === "string") return yield* failValidation(["after"], tuple);
          const page = yield* readPage(
            environment,
            selection,
            yield* readGroups(environment),
            tuple,
            MAX_INBOX_PAGE,
          );
          return {
            mode: "next",
            things: page.things,
            groups: page.groups,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            offerSets: page.offerSets,
          };
        }
        case "rows":
          return {
            mode: "rows",
            ...(yield* readHeldRows(environment, selection, yield* readGroups(environment), [
              ...new Set(query.held),
            ])),
          };
        case "refresh": {
          const groups = yield* readGroups(environment);
          const first = yield* readFirstPage(environment, selection, groups, MAX_INBOX_PAGE);
          const onFirstPage = new Set(first.things.map((thing) => thing.ref));
          const rest = [...new Set(query.held)].filter((ref) => !onFirstPage.has(ref));
          const held = yield* readHeldRows(environment, selection, groups, rest);
          return { mode: "refresh", first, held } as const;
        }
      }
    });

  /**
   * Reads the counts the sidebar draws: see `InboxCounts`. One statement over
   * the eligible things.
   */
  const countInbox = (environment: InboxEnvironment): Effect.Effect<InboxCounts, SqlError> =>
    Effect.gen(function* () {
      const eligible = buildEligibleEntities(environment);
      const [counted] = yield* runStatement<{
        readonly waiting: number;
        readonly newest_arrival: number | null;
      }>(
        sql,
        `WITH ${eligible.sql}
         SELECT COUNT(e.ask_count) AS waiting,
           MAX(CASE WHEN e.ask_count IS NOT NULL THEN e.arrival_sequence END) AS newest_arrival
         FROM eligible e`,
        eligible.params,
      );
      return { waiting: counted?.waiting ?? 0, newestArrival: counted?.newest_arrival ?? 0 };
    });

  /**
   * Reads what the rail draws: see `InboxOutline`. Counts are of distinct
   * things. A fixed number of statements: the saved queries and the pins
   * together; the sources and accounts; the facet values (only when some
   * source is not folded and has a facet); the records the pins name; and the
   * failing sources.
   */
  const readInboxOutline = (
    environment: InboxEnvironment,
    settings: InboxRailSettings,
  ): Effect.Effect<InboxOutline, SqlError> =>
    Effect.gen(function* () {
      const declared = listDeclaredInboxFields(environment.activeEntityKinds ?? []);
      const facetFields = listFacetFields(declared);
      const saved = listSavedQueries(environment.savedQueries);
      const everything: CompiledSql = { sql: "1", params: [] };
      const matched = buildMatchedEntities(environment, everything);

      // Every saved query and every pin is one `SUM` over the eligible things.
      const compileCount = (
        clauses: ReadonlyArray<InboxClause>,
        source: string | undefined,
      ): CompiledSql | undefined => {
        const compiled = compileInboxFilter({
          clauses,
          text: "",
          now: environment.now,
          fields: declared,
          signalKinds: environment.signalKinds,
          ...(source === undefined ? {} : { tie: { source } }),
        });
        return "problem" in compiled ? undefined : compiled;
      };
      const savedCounts = saved.map((query) => compileCount(query.clauses, query.source));
      const pinCounts = settings.pins.map((pin) =>
        compileCount(
          [
            {
              key: pin.key,
              op: "is",
              value: pin.value,
              source: pin.source,
              ...(pin.connectionId === undefined ? {} : { connectionId: pin.connectionId }),
            },
          ],
          undefined,
        ),
      );
      const columns = [...savedCounts, ...pinCounts];
      const eligible = buildEligibleEntities(environment);
      const [counted] = yield* runStatement<Record<string, number | null>>(
        sql,
        `WITH ${eligible.sql}
         SELECT ${columns
           .map(
             (compiled, index) =>
               `${compiled === undefined ? "0" : `SUM(CASE WHEN ${compiled.sql} THEN 1 ELSE 0 END)`} AS c${String(index)}`,
           )
           .join(", ")}
         FROM eligible e`,
        [...eligible.params, ...columns.flatMap((compiled) => compiled?.params ?? [])],
      );
      const readCountColumn = (index: number): number => counted?.[`c${String(index)}`] ?? 0;

      const { sources, accounts } = yield* readSourceCounts(sql, matched);
      const foldedSources = new Set(
        settings.browseFolded
          .filter((entry) => entry.connectionId === undefined)
          .map((entry) => entry.source),
      );
      const foldedAccounts = new Set(
        settings.browseFolded.flatMap((entry) =>
          entry.connectionId === undefined ? [] : [entry.connectionId],
        ),
      );
      const openFacetFields = facetFields.filter((field) => !foldedSources.has(field.source));
      const facetRows = yield* readFacetRows(
        sql,
        matched,
        openFacetFields,
        MAX_INBOX_RAIL_FACET_VALUES,
        true,
      );
      const facets = buildFacets(
        facetRows,
        openFacetFields,
        accounts,
        MAX_INBOX_RAIL_FACET_VALUES,
      ).filter(
        (facet) => facet.connectionId === undefined || !foldedAccounts.has(facet.connectionId),
      );

      // A pin on a record shows the record's title when some Connection can read
      // it, and a locked label when none can. A pin on an enum value shows the
      // value's label. A value that names nothing keeps its stored text.
      const pinRefs = settings.pins.map((pin) => pin.value);
      const records =
        pinRefs.length === 0
          ? new Map<string, { readonly title: string | null; readonly noun: string }>()
          : new Map(
              (yield* runStatement<{
                readonly ref: string;
                readonly noun: string;
                readonly title: string | null;
              }>(
                sql,
                `SELECT t.ref, t.noun, CASE WHEN ${READABLE_RECORD_SQL} THEN t.title END AS title
                 FROM external_entities t WHERE t.ref IN (SELECT value FROM json_each(?))`,
                [JSON.stringify(pinRefs)],
              )).map((row) => [row.ref, { title: row.title, noun: row.noun }]),
            );
      const buildPinLabel = (pin: InboxRailSettings["pins"][number]): string => {
        const record = records.get(pin.value);
        if (record !== undefined) return record.title ?? buildLockedLabel(record.noun);
        const enumLabel = declared
          .filter((field) => field.key === pin.key && parseSourceOfKind(field.kind) === pin.source)
          .flatMap((field) => field.enumValues ?? [])
          .find((entry) => entry.value === pin.value)?.label;
        return enumLabel ?? pin.value;
      };
      // A Connection's `updated_at` moves with every change to it, so the time
      // is when the source's failing Connection was last changed, not when it
      // began to fail.
      const failing = yield* runStatement<{ readonly source: string; readonly updated_at: string }>(
        sql,
        `SELECT plugin_id AS source, MAX(updated_at) AS updated_at FROM connections
         WHERE status IN ('needs-reauth', 'error') GROUP BY plugin_id ORDER BY plugin_id`,
        [],
      );

      const fieldList = new Map<string, InboxOutline["fields"][number]>();
      for (const field of declared) {
        const source = parseSourceOfKind(field.kind);
        const id = `${source}\u0000${field.key}`;
        if (fieldList.has(id)) continue;
        fieldList.set(id, {
          key: field.key,
          label: field.label,
          type: field.type,
          source,
          ...(field.enumValues === undefined ? {} : { values: [...field.enumValues] }),
          ...(field.currency === undefined ? {} : { currency: field.currency }),
        });
      }
      const sourceIds = [...sources.keys()].sort();
      return {
        savedQueries: saved.map((query, index) => ({
          id: query.id,
          name: query.name,
          order: query.order,
          ...(query.source === undefined ? {} : { source: query.source }),
          signalKinds: listQuerySignalKinds(query),
          count: readCountColumn(index),
        })),
        sources: sourceIds.map((source) => {
          const folded = foldedSources.has(source);
          const own = accounts.get(source) ?? [];
          return {
            source,
            count: sources.get(source) ?? 0,
            folded,
            accounts:
              own.length > 1
                ? own.map(({ connectionId, label, count }) => ({ connectionId, label, count }))
                : [],
            ...(folded ? {} : { facets: facets.filter((facet) => facet.source === source) }),
          };
        }),
        pins: settings.pins.map((pin, index) => ({
          source: pin.source,
          ...(pin.connectionId === undefined ? {} : { connectionId: pin.connectionId }),
          key: pin.key,
          value: pin.value,
          label: buildPinLabel(pin),
          count: readCountColumn(saved.length + index),
        })),
        fields: [
          ...CORE_INBOX_FIELDS.map(({ key, label, type }) => ({ key, label, type })),
          ...fieldList.values(),
        ],
        failing: failing.map((row) => ({ source: row.source, updatedAt: row.updated_at })),
      };
    });

  /**
   * Reads the values of one field among the things of a list: see
   * `InboxValues`. One statement. Only text, person and enum fields and the
   * core keys `source`, `kind`, `account`, `from` and `signal` have values to
   * suggest; any other key returns none.
   *
   * A value is suggested once across sources: its count adds up, and it
   * names the source that holds most of it. A facet of records suggests only
   * records some Connection can read, because the others have no title to
   * type. Enum values and signal kinds are matched by their label in code, as
   * the labels are not in the database.
   *
   * Fails with `Validation` for an unknown saved query or a list the query
   * cannot answer.
   */
  const suggestInboxValues = (
    environment: InboxEnvironment,
    query: InboxValueQuery,
  ): Effect.Effect<InboxValues, SqlError | Validation> =>
    Effect.gen(function* () {
      const list = yield* resolveList(query.list, environment);
      // A saved query of a plugin and a source asked for must be the same one.
      if (list.source !== undefined && query.source !== undefined && list.source !== query.source) {
        return { values: [] };
      }
      const source = query.source ?? list.source;
      const fields = listDeclaredInboxFields(environment.activeEntityKinds ?? []);
      const filter = yield* compileFilterOrFail(
        environment,
        {
          clauses: list.clauses,
          text: "",
          fields,
          tie: {
            ...(source === undefined ? {} : { source }),
            ...(query.connectionId === undefined ? {} : { connectionId: query.connectionId }),
          },
        },
        ["list"],
      );
      const matched = buildMatchedEntities(environment, filter);
      const prefix = `${escapeLike(query.prefix)}%`;
      const sourceSql = buildSourceOfKindSql("m");
      const declared = fields.filter(
        (field) =>
          field.key === query.key &&
          (field.type === "text" || field.type === "person" || field.type === "enum") &&
          (source === undefined || parseSourceOfKind(field.kind) === source),
      );

      let tuples: string | undefined;
      let tupleParams: ReadonlyArray<SqlValue> = [];
      if (declared.length > 0) {
        tuples = `SELECT f.text_value AS value, COALESCE(t.title, f.text_value) AS label,
            ${sourceSql} AS source, m.ref AS ref
          FROM matched m JOIN external_entity_fields f ON f.ref = m.ref AND f.key = ?
            AND f.text_value IS NOT NULL
          LEFT JOIN external_entities t ON t.ref = f.text_value AND ${READABLE_RECORD_SQL}
          WHERE m.kind IN (SELECT value FROM json_each(?))
            AND (t.ref IS NOT NULL OR m.kind NOT IN (SELECT value FROM json_each(?)))`;
        tupleParams = [
          query.key,
          JSON.stringify(declared.map((field) => field.kind)),
          JSON.stringify(
            declared.filter((field) => field.contextKind !== undefined).map((field) => field.kind),
          ),
        ];
        // A facet of records also offers the records the account observes that
        // no thing of the list holds. They have no `ref`, so they count 0.
        const contextKinds = [...new Set(declared.flatMap((field) => field.contextKind ?? []))];
        if (contextKinds.length > 0) {
          tuples += `
          UNION ALL
          SELECT t.ref AS value, t.title AS label, ${buildSourceOfKindSql("t")} AS source,
            NULL AS ref
          FROM external_entities t
          WHERE t.kind IN (SELECT value FROM json_each(?)) AND ${READABLE_RECORD_SQL}
            ${
              query.connectionId === undefined
                ? ""
                : `AND EXISTS (SELECT 1 FROM external_entity_observations o
                    WHERE o.ref = t.ref AND o.connection_id = ? AND ${OBSERVING_SQL})`
            }`;
          tupleParams = [
            ...tupleParams,
            JSON.stringify(contextKinds),
            ...(query.connectionId === undefined
              ? []
              : [
                  // An id that is not a UUID matches no Connection.
                  UUID_TEXT.test(query.connectionId)
                    ? uuidFromString(query.connectionId)
                    : new Uint8Array(),
                ]),
          ];
        }
      } else if (isCoreKey(query.key)) {
        tuples = CORE_KEYS[query.key].values;
      }
      if (tuples === undefined) return { values: [] };

      const enumLabels = new Map(
        declared.flatMap((field) =>
          (field.enumValues ?? []).map((entry) => [entry.value, entry.label] as const),
        ),
      );
      const signalNouns = new Map(
        query.key === "signal" ? environment.signalKinds.map((kind) => [kind.kind, kind.noun]) : [],
      );
      // The label of these values is not in the database, so the prefix is
      // matched here, and the statement returns every value to match.
      const labelledInCode =
        declared.some((field) => field.type === "enum") || query.key === "signal";
      const rows = yield* runStatement<{
        readonly value: string;
        readonly label: string;
        readonly source: string;
        readonly n: number;
      }>(
        sql,
        `WITH ${matched.sql},
          tuples AS (${tuples}),
          per_source AS (
            SELECT value, MIN(label) AS label, source, COUNT(DISTINCT ref) AS n FROM tuples
            ${labelledInCode ? "" : "WHERE label LIKE ? ESCAPE '\\'"}
            GROUP BY source, value),
          merged AS (
            SELECT value, label, source,
              SUM(n) OVER (PARTITION BY lower(value)) AS total,
              ROW_NUMBER() OVER (PARTITION BY lower(value) ORDER BY n DESC, source) AS rn
            FROM per_source)
         SELECT value, label, source, total AS n FROM merged WHERE rn = 1
         ORDER BY total DESC, label COLLATE NOCASE, value
         LIMIT ?`,
        [
          ...matched.params,
          ...tupleParams,
          ...(labelledInCode ? [] : [prefix]),
          labelledInCode ? MAX_LABELLED_IN_CODE_VALUES : MAX_INBOX_SUGGESTIONS,
        ],
      );
      const lowered = query.prefix.toLowerCase();
      const values = rows
        .map((row) => ({
          value: row.value,
          label: enumLabels.get(row.value) ?? signalNouns.get(row.value) ?? row.label,
          count: row.n,
          source: row.source,
        }))
        .filter(
          (row) =>
            !labelledInCode ||
            row.label.toLowerCase().startsWith(lowered) ||
            row.value
              .slice(row.value.indexOf("/") + 1)
              .toLowerCase()
              .startsWith(lowered),
        )
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
        .slice(0, MAX_INBOX_SUGGESTIONS);
      return { values };
    });

  /**
   * Returns the ref of the label thing of the Inbox group whose members are
   * exactly `refs` (in any order), or none when `refs` are not that: fewer
   * than two refs, a ref in no group, refs of different groups, or part of a
   * group.
   *
   * The groups are decided by `readGroups`, as `queryInbox` decides them, in
   * one read snapshot. That read scans the link graph, so callers keep it off
   * the transaction that writes. It returns the ref and not the label text,
   * because access to the label thing can change before the text is used:
   * the caller reads the label thing again when it writes the text.
   */
  const findInboxGroupLabelRef = (
    environment: InboxEnvironment,
    refs: ReadonlyArray<string>,
  ): Effect.Effect<Option.Option<string>, SqlError> =>
    withReadSnapshot(
      sql,
      Effect.gen(function* () {
        const group = findGroupMadeOf(yield* readGroups(environment), refs);
        return group === undefined ? Option.none() : Option.some(group.labelRef);
      }),
    );

  return {
    queryInbox,
    countInbox,
    readInboxOutline,
    suggestInboxValues,
    readInboxGroup,
    findInboxGroupLabelRef,
  };
});

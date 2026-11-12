/**
 * The reads behind the Inbox: a page of a list, the counts of the rail, and
 * the values the search suggests.
 *
 * What is on the Inbox is `buildEligibleEntities` (inbox-population.ts), and
 * what a clause means is `compileInboxFilter` (inbox-predicates.ts). This
 * module composes them into statements and reads only what it shows:
 *
 * - A page is one statement that finds, filters, counts, orders and cuts the
 *   things (keyset pages of `MAX_INBOX_PAGE`), then batched reads for the
 *   refs of that page alone.
 * - The counts are a fixed handful of statements, whatever the number of
 *   things, sources, saved queries or pins.
 *
 * The number of statements never depends on the number of things.
 */
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createValidationError,
  MAX_ENTITY_SIGNALS,
  MAX_INBOX_ACCOUNTS,
  MAX_INBOX_ASKS,
  MAX_INBOX_PAGE,
  MAX_INBOX_PAGE_FACET_VALUES,
  MAX_INBOX_RAIL_FACET_VALUES,
  MAX_INBOX_SUGGESTIONS,
  MAX_LIVE_WORKFLOWS,
  type InboxCounts,
  type InboxFacet,
  type InboxList,
  type InboxOutline,
  type InboxPage,
  type InboxQuery,
  type InboxThing,
  type InboxValueQuery,
  type InboxValues,
  type Validation,
} from "@hercule/contract";
import { CORE_INBOX_FIELDS, type InboxClause } from "@hercule/plugin-host";
import { uuidFromString, uuidToString } from "../db";
import type { RegisteredSavedQuery, RegisteredSignalKind } from "../plugins";
import {
  deriveAccess,
  deriveObservedAt,
  deriveStale,
  parseStoredStatus,
  type EntityEnvironment,
  type EntityRow,
  type ObservationRow,
} from "./entity-records";
import { readFieldValues, type EntityFieldValues } from "./entity-fields";
import { buildAsksOfRefs, buildEligibleEntities, buildTakenOfRefs } from "./inbox-population";
import {
  buildSourceOfKindSql,
  compileInboxFilter,
  escapeLike,
  listDeclaredInboxFields,
  OBSERVING_SQL,
  UUID_TEXT,
  parseSourceOfKind,
  READABLE_RECORD_SQL,
  type CompiledSql,
  type DeclaredInboxField,
  type InboxFilterInput,
  type SqlValue,
} from "./inbox-predicates";
import { findSavedQuery, listSavedQueries } from "./saved-queries";
import { buildSignalSay } from "./signal-lines";
import type { WorkflowOfferTarget } from "./workflow-offer-reads";

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

/** The reads of other modules that the Inbox's hydration uses, passed in by the repository. */
export interface InboxReaders {
  readonly readEntities: (
    refs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, EntityRow>, SqlError>;
  readonly readObservations: (
    refs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<ObservationRow>>, SqlError>;
  readonly listOpenKindsByThread: (
    refs: ReadonlyArray<string>,
    limit: number,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>, SqlError>;
  readonly listLiveWorkflowsOfTasks: (
    taskIds: ReadonlyArray<string>,
    perTask: number,
  ) => Effect.Effect<
    ReadonlyMap<string, ReadonlyArray<{ readonly workflowId: string; readonly name: string }>>,
    SqlError
  >;
  readonly readWorkflowOffers: (
    targets: ReadonlyArray<WorkflowOfferTarget>,
    kindSources: NonNullable<EntityEnvironment["kindSources"]>,
  ) => Effect.Effect<
    {
      readonly offerSetIds: ReadonlyMap<string, string>;
      readonly offerSets: InboxPage["offerSets"];
      readonly actingConnections: ReadonlyMap<string, InboxThing["actingConnections"]>;
    },
    SqlError
  >;
  readonly buildOfferTarget: (row: EntityRow) => WorkflowOfferTarget;
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
    : Effect.succeed({ clauses: [list.browse], order: "waiting" });

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

/**
 * The statements that hold what a read works on: the common table expressions
 * of the Inbox and `matched`, the eligible things that pass `filter`, with the
 * columns every read needs. With `onlyRefs`, only those things are looked at.
 */
const buildMatched = (
  environment: InboxEnvironment,
  filter: CompiledSql,
  extra: CompiledSql = { sql: "", params: [] },
  onlyRefs?: ReadonlyArray<string>,
): CompiledSql => {
  const eligible = buildEligibleEntities(environment.now, environment.askingKinds, onlyRefs);
  return {
    sql: `${eligible.sql},
      matched AS MATERIALIZED (
        SELECT e.ref, e.id, e.kind, e.task_id, e.oldest_ask, e.source_updated_at AS upd,
          CASE WHEN e.oldest_ask IS NULL THEN 1 ELSE 0 END AS grp
        FROM eligible e WHERE ${filter.sql})${extra.sql}`,
    params: [...eligible.params, ...filter.params, ...extra.params],
  };
};

/** Runs a statement written with `?` placeholders. */
const runStatement = <Row extends object>(
  sql: SqlClient.SqlClient,
  statement: string,
  params: ReadonlyArray<SqlValue>,
) => sql.unsafe<Row>(statement, [...params]);

/** The sort key of a thing in a list, which a cursor carries. */
type SortTuple = ReadonlyArray<string | number>;

/** Hashes what a cursor is bound to, so a cursor never reads another query. */
const hashQuery = (list: InboxList, query: InboxQuery, order: string): string =>
  createHash("sha256")
    .update(JSON.stringify([list, query.clauses ?? [], query.text ?? "", order]))
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

/**
 * Builds the `WHERE` and the parameters that keep the things after the sort
 * tuple. Order `waiting` sorts things with an ask first, oldest ask first
 * (`grp = 0`), then the rest by the latest change; order `newest` by the
 * latest change. Ties break by ref.
 */
const buildKeyset = (order: "waiting" | "newest", tuple: SortTuple | undefined): CompiledSql => {
  if (tuple === undefined) return { sql: "1", params: [] };
  if (order === "newest") {
    const [upd, ref] = tuple as [string, string];
    return { sql: "(m.upd < ? OR (m.upd = ? AND m.ref > ?))", params: [upd, upd, ref] };
  }
  const [grp, key, ref] = tuple as [number, string, string];
  return grp === 0
    ? {
        sql: "((m.grp = 0 AND (m.oldest_ask > ? OR (m.oldest_ask = ? AND m.ref > ?))) OR m.grp = 1)",
        params: [key, key, ref],
      }
    : {
        sql: "(m.grp = 1 AND (m.upd < ? OR (m.upd = ? AND m.ref > ?)))",
        params: [key, key, ref],
      };
};

const ORDER_BY: Readonly<Record<"waiting" | "newest", string>> = {
  waiting:
    "m.grp ASC, CASE WHEN m.grp = 0 THEN m.oldest_ask END ASC, CASE WHEN m.grp = 1 THEN m.upd END DESC, m.ref ASC",
  newest: "m.upd DESC, m.ref ASC",
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
 * Builds the label of a context record that no Connection can read: it names
 * the kind of record and never the ref or the title, which are restricted. The
 * wording matches the locked rows the apps draw.
 */
const buildLockedLabel = (noun: string | null): string => {
  const kind = noun === null ? "record" : noun.charAt(0).toLowerCase() + noun.slice(1);
  return `${/^[aeiou]/i.test(kind) ? "An" : "A"} ${kind} you cannot open`;
};

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
  readonly oldest_ask: string | null;
  readonly upd: string;
  readonly grp: number;
  /** Only on the first page. */
  readonly total?: number;
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

/** Builds the reads of the Inbox over `sql`, with the readers of the other modules in `readers`. */
export const makeInboxQueries = (sql: SqlClient.SqlClient, readers: InboxReaders) => {
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
    const own = buildAsksOfRefs(refs, environment.now, environment.askingKinds);
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

  /**
   * Reads which of `refs` the user took on: the ones whose active Task link
   * has a `taken_at`. One statement. It is apart from the page statement
   * because joining it there changes the plan of a narrowed page for the worse.
   */
  const readTakenRefs = (
    refs: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlySet<string>, SqlError> => {
    if (refs.length === 0) return Effect.succeed(new Set());
    const own = buildTakenOfRefs(refs);
    return Effect.map(
      runStatement<{ readonly ref: string }>(
        sql,
        `WITH ${own.sql} SELECT ref FROM taken`,
        own.params,
      ),
      (rows) => new Set(rows.map((row) => row.ref)),
    );
  };

  /** Builds the things of a page, in the order of `rows`, from the batched reads of their refs. */
  const hydrate = (
    environment: InboxEnvironment,
    rows: ReadonlyArray<PageRow>,
  ): Effect.Effect<
    { readonly things: ReadonlyArray<InboxThing>; readonly offerSets: InboxPage["offerSets"] },
    SqlError
  > =>
    Effect.gen(function* () {
      const entities = yield* readers.readEntities(rows.map((row) => row.ref));
      // A thing the page statement found can be pruned before this read; it is
      // left out, as it no longer belongs to the list.
      const present = rows.filter((row) => entities.has(row.ref));
      const refs = present.map((row) => row.ref);
      const observations = yield* readers.readObservations(refs);
      const asks = yield* readAsks(environment, refs);
      const taken = yield* readTakenRefs(refs);
      const openKinds = yield* readers.listOpenKindsByThread(refs, MAX_ENTITY_SIGNALS);
      const fieldValues: ReadonlyMap<string, EntityFieldValues> = yield* withSql(
        readFieldValues(refs, environment.activeEntityKinds),
      );
      const offers = yield* readers.readWorkflowOffers(
        refs.map((ref) => readers.buildOfferTarget(entities.get(ref)!)),
        environment.kindSources ?? [],
      );
      const taskIds = present.flatMap((row) =>
        row.task_id === null ? [] : [uuidToString(row.task_id)],
      );
      const liveWorkflows = yield* readers.listLiveWorkflowsOfTasks(taskIds, MAX_LIVE_WORKFLOWS);
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
          ...(taskId === undefined ? {} : { taskId }),
          takenOn: taken.has(page.ref),
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
   * Reads one page of the list of `query`: see `InboxPage`. The statements are
   * the page (one, which also counts the whole result on the first page), on the first
   * page the accounts and the facets, then one read for each kind of detail
   * of the things on the page.
   *
   * Fails with `Validation` for an unknown saved query, a clause or text that
   * cannot be answered, a cursor that does not belong to the query, or a
   * cursor given with `refs`.
   */
  const queryInbox = (
    environment: InboxEnvironment,
    query: InboxQuery,
  ): Effect.Effect<InboxPage, SqlError | Validation> =>
    Effect.gen(function* () {
      const list = yield* resolveList(query.list, environment);
      if (query.refs !== undefined && query.cursor !== undefined) {
        return yield* failValidation(
          ["cursor"],
          "a read by refs takes no cursor. Send one or the other.",
        );
      }
      const fields = listDeclaredInboxFields(environment.activeEntityKinds ?? []);
      const filter = yield* compileFilterOrFail(environment, {
        clauses: [...list.clauses, ...(query.clauses ?? [])],
        text: query.text ?? "",
        fields,
        ...(list.source === undefined ? {} : { tie: { source: list.source } }),
      });
      const hash = hashQuery(query.list, query, list.order);
      let tuple: SortTuple | undefined;
      if (query.cursor !== undefined) {
        const decoded = decodeCursor(query.cursor, hash, list.order);
        if (typeof decoded === "string") return yield* failValidation(["cursor"], decoded);
        tuple = decoded;
      }

      // A read of some refs looks at those things only, and only the first page
      // counts the whole list: a next page or a refs read ranks nothing for it.
      const matched = buildMatched(environment, filter, undefined, query.refs);
      const isFirstPage = query.cursor === undefined && query.refs === undefined;
      const where: CompiledSql =
        query.refs === undefined ? buildKeyset(list.order, tuple) : { sql: "1", params: [] };
      const rows = yield* runStatement<PageRow>(
        sql,
        `WITH ${matched.sql}
         SELECT m.ref, m.task_id, m.oldest_ask, m.upd, m.grp
           ${isFirstPage ? ", (SELECT COUNT(*) FROM matched) AS total" : ""}
         FROM matched m WHERE ${where.sql}
         ORDER BY ${ORDER_BY[list.order]} LIMIT ?`,
        [...matched.params, ...where.params, MAX_INBOX_PAGE + 1],
      );
      const more = rows.length > MAX_INBOX_PAGE;
      const pageRows = rows.slice(0, MAX_INBOX_PAGE);
      // A first page has no keyset, so it has no rows only when nothing matches.
      const total = isFirstPage ? (rows[0]?.total ?? 0) : undefined;
      const last = pageRows.at(-1);
      const nextCursor =
        more && last !== undefined && query.refs === undefined
          ? encodeCursor(
              hash,
              list.order === "newest"
                ? [last.upd, last.ref]
                : [last.grp, last.grp === 0 ? last.oldest_ask! : last.upd, last.ref],
            )
          : undefined;

      const { things, offerSets } = yield* hydrate(environment, pageRows);
      let facets: ReadonlyArray<InboxFacet> | undefined;
      if (query.cursor === undefined && query.refs === undefined) {
        const facetFields = listFacetFields(fields);
        const { accounts } = yield* readSourceCounts(sql, matched);
        const facetRows = yield* readFacetRows(
          sql,
          matched,
          facetFields,
          MAX_INBOX_PAGE_FACET_VALUES,
          false,
        );
        facets = buildFacets(facetRows, facetFields, accounts, MAX_INBOX_PAGE_FACET_VALUES);
      }
      return {
        things,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        ...(total === undefined ? {} : { total }),
        order: list.order,
        ...(facets === undefined ? {} : { facets }),
        offerSets,
      };
    });

  /**
   * Reads the counts the sidebar draws: see `InboxCounts`. One statement over
   * the eligible things.
   */
  const countInbox = (environment: InboxEnvironment): Effect.Effect<InboxCounts, SqlError> =>
    Effect.gen(function* () {
      const eligible = buildEligibleEntities(environment.now, environment.askingKinds);
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
      const matched = buildMatched(environment, everything);

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
      const eligible = buildEligibleEntities(environment.now, environment.askingKinds);
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
      const matched = buildMatched(environment, filter);
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
      } else if (query.key === "from") {
        tuples = `SELECT a.asker AS value, a.asker AS label, ${sourceSql} AS source, m.ref AS ref
          FROM matched m JOIN asks a ON a.ref = m.ref WHERE a.asker IS NOT NULL
          UNION
          SELECT json_extract(e.person, '$.name'), json_extract(e.person, '$.name'), ${sourceSql}, m.ref
          FROM matched m JOIN external_entities e ON e.ref = m.ref
          WHERE m.oldest_ask IS NULL AND json_extract(e.person, '$.name') IS NOT NULL`;
      } else if (query.key === "source") {
        tuples = `SELECT ${sourceSql} AS value, ${sourceSql} AS label, ${sourceSql} AS source, m.ref AS ref FROM matched m`;
      } else if (query.key === "kind") {
        tuples = `SELECT m.kind AS value, e.noun AS label, ${sourceSql} AS source, m.ref AS ref
          FROM matched m JOIN external_entities e ON e.ref = m.ref`;
      } else if (query.key === "signal") {
        tuples = `SELECT s.kind AS value, s.kind AS label, ${sourceSql} AS source, m.ref AS ref
          FROM matched m JOIN live_signals s ON s.ref = m.ref`;
      } else if (query.key === "account") {
        tuples = `SELECT c.label AS value, c.label AS label, ${sourceSql} AS source, m.ref AS ref
          FROM matched m JOIN external_entity_observations o ON o.ref = m.ref AND ${OBSERVING_SQL}
            JOIN connections c ON c.id = o.connection_id`;
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

  return { queryInbox, countInbox, readInboxOutline, suggestInboxValues };
};

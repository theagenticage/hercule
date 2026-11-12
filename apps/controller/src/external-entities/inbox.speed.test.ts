/**
 * Times the Inbox's reads against a database arranged as production arranges
 * one, counts the statements they send, and prints the numbers. Run it with
 * `pnpm test:speed`, or on its own with
 * `RUN_SPEED_TESTS=1 pnpm test:node apps/controller/src/external-entities/inbox.speed.test.ts`.
 *
 * It is opt-in, and not part of `pnpm test` or CI, because time depends on the
 * machine. The database is the test database every controller test uses: a
 * file in a temporary folder, in WAL mode, with a writer and a read-only
 * reader (ADR 0004, amendment of 2026-10-18), not SQLite's in-memory mode. It
 * is seeded with a migrated schema and no statistics, as a controller starts.
 *
 * It drives the repository's three Inbox reads, at 300, 1,000 and 2,400
 * things:
 *
 * - `queryInbox`: the first page of "Someone waits on me" (order waiting) and
 *   of "Everything" (order newest), a `refs` read of 200 things, and the page
 *   after the first. A page prints its median and 95th percentile, the
 *   statements sent and the bytes of the encoded reply;
 * - `suggestInboxValues`: the values of a facet field and of the core key
 *   `from`;
 * - `countInbox`: the rail's counts with every source open, and the sidebar's
 *   case, every source folded, timed apart because it skips the facets.
 *
 * Every statement's query plan is checked: a `SCAN` of one of the big tables
 * is printed, so a read that walks every row shows up. Reads that must walk
 * the eligible things once (the counts, the facets) show the scans they make.
 *
 * The things are tickets of an `acme` plugin (a facet of team records, an
 * enum, a number, an age) and issues of a `beta` plugin, over six accounts.
 * Every second thing has an open ask, every fifth an open signal that asks
 * nothing, every tenth is dismissed (half of those with an ask raised after),
 * and every tenth has a live Task.
 *
 * What it guards is an order of magnitude: the ceilings are far above what
 * the reads take, and the statement counts must not follow the things.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { mintUuid, uuidFromString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { taskRepository } from "../tasks";
import { claimRepository } from "./claims";
import type { ActiveEntityKind } from "./entity-records";
import type { InboxEnvironment } from "./inbox-query";
import { externalEntityRepository } from "./repository";

/** Set to "1" by `pnpm test:speed`. */
const SPEED_TESTS_ENABLED = process.env["RUN_SPEED_TESTS"] === "1";

/** The target of spec 17 for a page at 300 things, in milliseconds. */
const PAGE_TARGET_MS = 20;

/** The most time a page may take at 1,000 and 2,400 things, in milliseconds. */
const LARGE_PAGE_CEILING_MS = 100;

/** The most time the counts may take, in milliseconds. */
const COUNTS_CEILING_MS = 150;

/** The most time one walk up may take, in milliseconds. */
const ANCESTORS_CEILING_MS = 200;

/** How often each read is timed after it has warmed up. */
const RUNS = 25;
const WARM_UP_RUNS = 5;

/** The plugin the walk up part-of seeds its Connection for. */
const PLUGIN = "acme";

const AT = "2026-11-01T09:00:00.000Z";
const NOW = "2026-11-02T09:00:00.000Z";

/** The tables a `SCAN` of which follows the size of the database rather than the page. */
const BIG_TABLES = [
  "external_entities",
  "external_entity_observations",
  "external_entity_relation_claims",
  "external_entity_fields",
  "signals",
  "tasks",
  "task_entity_links",
  "runs",
  "sessions",
];

const ACME_ACCOUNTS = Array.from(
  { length: 4 },
  (_, n) => `0190c000-0000-7000-8000-00000000a${n}00`,
);
const BETA_ACCOUNTS = Array.from(
  { length: 2 },
  (_, n) => `0190c000-0000-7000-8000-00000000b${n}00`,
);
const TEAMS = 60;

const TICKET: ActiveEntityKind = {
  kind: "acme/ticket",
  noun: "Ticket",
  refPrefix: "acme:ticket:",
  fields: [
    { key: "team", label: "Team", type: "text", facet: { plural: "Teams", values: "acme/team" } },
    {
      key: "priority",
      label: "Priority",
      type: "enum",
      values: [
        { value: "p1", label: "Urgent" },
        { value: "p2", label: "Normal" },
        { value: "p3", label: "Low" },
      ],
    },
    { key: "size", label: "Size", type: "number" },
    { key: "opened", label: "Opened", type: "age" },
  ],
  face: { place: "team", fact: "size" },
};

const ISSUE: ActiveEntityKind = {
  kind: "beta/issue",
  noun: "Issue",
  refPrefix: "beta:issue:",
  fields: [
    { key: "owner", label: "Owner", type: "person", facet: { plural: "Owners" } },
    {
      key: "priority",
      label: "Priority",
      type: "enum",
      values: [
        { value: "p1", label: "Urgent" },
        { value: "p2", label: "Normal" },
      ],
    },
  ],
};

const ENVIRONMENT: InboxEnvironment = {
  now: NOW,
  activePluginIds: ["acme", "beta"],
  activeEntityKinds: [TICKET, ISSUE],
  kindSources: [],
  signalKinds: [
    { kind: "acme/review", noun: "review request", asks: true },
    { kind: "acme/note", noun: "note", asks: false },
    { kind: "beta/ask", noun: "question", asks: true },
  ],
  savedQueries: [],
  askingKinds: ["acme/review", "beta/ask"],
};

const OPEN_RAIL = { pins: [], browseFolded: [] } as const;
const FOLDED_RAIL = {
  pins: [],
  browseFolded: [{ source: "acme" }, { source: "beta" }],
} as const;

const ticketRef = (n: number) => `acme:ticket:${String(n)}`;
const issueRef = (n: number) => `beta:issue:${String(n)}`;

/** Every third thing is an issue of `beta`, the rest are tickets of `acme`. */
const thingRef = (n: number) => (n % 3 === 0 ? issueRef(n) : ticketRef(n));

const minutesAfter = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

/**
 * Seeds `things` things as production would hold them, in a few bulk
 * statements: plugins, accounts, team records, the things with their
 * observations and fields, signals, dismissals and live Tasks.
 */
const seed = (things: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const plugin of ["acme", "beta"]) {
      yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
        VALUES (${plugin}, 1, '{}', ${AT}, ${AT})`;
    }
    const accounts = [
      ...ACME_ACCOUNTS.map((id, n) => ["acme", id, `acme-${String(n)}`] as const),
      ...BETA_ACCOUNTS.map((id, n) => ["beta", id, `beta-${String(n)}`] as const),
    ];
    for (const [plugin, id, label] of accounts) {
      yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
          status, labels, config, created_at, updated_at)
        VALUES (${uuidFromString(id)}, ${plugin}, ${`${plugin}/account`}, ${label}, ${label},
          ${label}, 'connected', '[]', '{}', ${AT}, ${AT})`;
    }
    const teams = Array.from({ length: TEAMS }, (_, n) => n);
    yield* sql`
      INSERT INTO external_entities
        (id, ref, kind, noun, pace, completeness, title, status, first_observed_at, updated_at)
      SELECT randomblob(16), 'acme:team:' || value, 'acme/team', 'Team', 'context', 'full',
        'Team ' || value, '{"shape":"dot","tone":"good","label":"On track"}', ${AT}, ${AT}
      FROM json_each(${JSON.stringify(teams)})`;
    yield* sql`
      INSERT INTO external_entity_observations (ref, connection_id, access)
      SELECT 'acme:team:' || value, ${uuidFromString(ACME_ACCOUNTS[0]!)}, 'ok'
      FROM json_each(${JSON.stringify(teams)})`;

    const numbers = Array.from({ length: things }, (_, n) => n + 1);
    const rows = numbers.map((n) => {
      const issue = n % 3 === 0;
      return {
        ref: thingRef(n),
        kind: issue ? "beta/issue" : "acme/ticket",
        noun: issue ? "Issue" : "Ticket",
        n,
        updated: minutesAfter(n),
        // Every tenth thing is dismissed, a day before the asks below are raised.
        dismissed: n % 10 === 0 ? minutesAfter(n) : null,
        person: JSON.stringify({ name: `Person ${String(n % 17)}` }),
        accounts: (issue ? BETA_ACCOUNTS : ACME_ACCOUNTS)
          .filter((_, index) => index === n % 2 || (n % 7 === 0 && index === 3))
          .map((id) => uuidFromString(id))
          .map((bytes) => Buffer.from(bytes).toString("hex")),
        fields: issue
          ? [
              ["owner", `Owner ${String(n % 23)}`, null],
              ["priority", `p${String((n % 2) + 1)}`, null],
            ]
          : [
              ["team", `acme:team:${String(n % TEAMS)}`, null],
              ["priority", `p${String((n % 3) + 1)}`, null],
              ["size", null, n % 40],
              ["opened", null, Date.parse(AT) - (n % 30) * 86_400_000],
            ],
      };
    });
    yield* sql`
      INSERT INTO external_entities
        (id, ref, kind, noun, card, pace, patience, completeness, identifier, title, url,
         lifecycle, person, source_updated_at, first_observed_at, updated_at, dismissed_at)
      SELECT randomblob(16), json_extract(value, '$.ref'), json_extract(value, '$.kind'),
        json_extract(value, '$.noun'), 'compact', 'fast', 24, 'full',
        'T-' || json_extract(value, '$.n'),
        'Make the checkout page remember the last payment method (' || json_extract(value, '$.n') || ')',
        'https://acme.example/' || json_extract(value, '$.n'), 'open',
        json_extract(value, '$.person'), json_extract(value, '$.updated'), ${AT}, ${AT},
        json_extract(value, '$.dismissed')
      FROM json_each(${JSON.stringify(rows)})`;
    yield* sql`
      INSERT INTO external_entity_observations (ref, connection_id, concerns, owned_by_you, access)
      SELECT json_extract(r.value, '$.ref'), unhex(a.value), '["assigned"]',
        json_extract(r.value, '$.n') % 5 = 0, 'ok'
      FROM json_each(${JSON.stringify(rows)}) r, json_each(r.value, '$.accounts') a`;
    yield* sql`
      INSERT INTO external_entity_fields (ref, key, text_value, number_value)
      SELECT json_extract(r.value, '$.ref'), json_extract(f.value, '$[0]'),
        json_extract(f.value, '$[1]'), json_extract(f.value, '$[2]')
      FROM json_each(${JSON.stringify(rows)}) r, json_each(r.value, '$.fields') f`;

    // Every second thing asks, every fifth holds a signal that asks nothing.
    // Dismissed things get their ask a minute after the dismissal, half of
    // them, so half of the dismissed things come back.
    const signalRows = numbers.flatMap((n) => {
      const asked = n % 2 === 0 || n % 10 === 0;
      const signals: Array<{ ref: string; kind: string; at: string; connection: string }> = [];
      const connection = (n % 3 === 0 ? BETA_ACCOUNTS : ACME_ACCOUNTS)[0]!;
      if (asked && (n % 10 !== 0 || n % 20 === 0)) {
        signals.push({
          ref: thingRef(n),
          kind: n % 3 === 0 ? "beta/ask" : "acme/review",
          at: minutesAfter(n + 1),
          connection,
        });
      }
      if (n % 5 === 0) {
        signals.push({ ref: thingRef(n), kind: "acme/note", at: minutesAfter(n), connection });
      }
      return signals;
    });
    yield* sql`
      INSERT INTO signals
        (id, kind, origin, title, asker, place, priority, blocks, actions, match, status,
         created_at, connection_id, thread_ref)
      SELECT randomblob(16), json_extract(value, '$.kind'),
        json_object('type', 'event', 'eventId', 1, 'connectionId', 'x',
                    'threadRef', json_extract(value, '$.ref')),
        json_extract(value, '$.kind') || ' on ' || json_extract(value, '$.ref'),
        'Asker ' || (abs(random()) % 9), 'acme/web', 'normal', '[]', '[]', '{}', 'open',
        json_extract(value, '$.at'), unhex(replace(json_extract(value, '$.connection'), '-', '')),
        json_extract(value, '$.ref')
      FROM json_each(${JSON.stringify(signalRows)})`;

    const tasks = yield* taskRepository;
    for (let n = 7; n <= things; n += 10) {
      yield* tasks.insert({
        title: `Work on ${thingRef(n)}`,
        description: "",
        status: "open",
        stage: "planned",
        priority: "normal",
        labels: [],
        projectId: undefined,
        provenance: [{ ref: thingRef(n) }],
        at: minutesAfter(n + 2),
        actor: "user",
      });
    }
    return things;
  }).pipe(inTransaction);

/** The median and the 95th percentile of a timed read, in milliseconds. */
interface Timing {
  readonly median: number;
  readonly p95: number;
}

/** Times `read` after warming it up, and returns its median and 95th percentile. */
const measure = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const times: Array<number> = [];
    for (let run = 0; run < WARM_UP_RUNS + RUNS; run++) {
      const started = performance.now();
      yield* read;
      if (run >= WARM_UP_RUNS) times.push(performance.now() - started);
    }
    const sorted = times.toSorted((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)]!,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    } satisfies Timing;
  });

/** Runs `read` once and returns its value with every statement it sent, compiled. */
const captureStatements = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const value = yield* read.pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) =>
        Effect.sync(() => {
          statements.push(statement.compile());
          return statement;
        }),
      ),
    );
    return { value, statements };
  });

/** Words that can follow a table's name in a statement and are not an alias. */
const NOT_AN_ALIAS = new Set([
  "WHERE",
  "ON",
  "JOIN",
  "LEFT",
  "INNER",
  "CROSS",
  "SET",
  "GROUP",
  "ORDER",
  "LIMIT",
  "USING",
  "VALUES",
  "AS",
  "UNION",
  "SELECT",
  "AND",
  "OR",
  "WITH",
  "INDEXED",
  "NOT",
  "DEFAULT",
  "RETURNING",
]);

/**
 * Returns the names a statement gives the big tables: each table's own name
 * and every alias it is read under (`external_entities e`, `tasks AS t`).
 */
const findBigTableNames = (text: string): ReadonlyMap<string, string> => {
  const names = new Map(BIG_TABLES.map((table) => [table, table] as const));
  const pattern = new RegExp(`\\b(${BIG_TABLES.join("|")})\\s+(?:AS\\s+)?(\\w+)`, "gi");
  for (const [, table, alias] of text.matchAll(pattern)) {
    if (!NOT_AN_ALIAS.has(alias!.toUpperCase())) names.set(alias!, table!);
  }
  return names;
};

/**
 * Returns the steps of the query plans of `statements` that scan one of the
 * big tables, by its name or an alias, each with the start of its statement.
 * A scan of a partial index is listed too: it follows the rows the index
 * holds, which may or may not be the page.
 */
const findBigScans = (statements: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scans: Array<string> = [];
    for (const [text, params] of statements) {
      const rows = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${text}`,
        params,
      );
      const names = findBigTableNames(text);
      for (const { detail } of rows) {
        const name = /^SCAN (\w+)/.exec(detail)?.[1];
        const table = name === undefined ? undefined : names.get(name);
        if (table !== undefined) {
          scans.push(
            `${detail} (${table})   <- ${text.replaceAll(/\s+/g, " ").trim().slice(0, 70)}`,
          );
        }
      }
    }
    return scans;
  });

/** Returns the length of `value` as UTF-8 JSON, in bytes. */
const measureBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

const format = (ms: number) => ms.toFixed(2).padStart(7);

/** What one timed read reports. */
interface Case {
  readonly name: string;
  readonly timing: Timing;
  readonly statements: number;
  readonly scans: ReadonlyArray<string>;
  readonly bytes: number;
  readonly returned: number;
}

/** Times `read` and captures its statements and their plans once. */
const runCase = <A>(
  name: string,
  read: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  summarize: (value: A) => number,
) =>
  Effect.gen(function* () {
    const { value, statements } = yield* captureStatements(read);
    return {
      name,
      timing: yield* measure(read),
      statements: statements.length,
      scans: yield* findBigScans(statements),
      bytes: measureBytes(value),
      returned: summarize(value),
    } satisfies Case;
  });

const printCase = (size: number, result: Case) =>
  process.stderr.write(
    `${String(size).padStart(5)} things  ${result.name.padEnd(30)} ${format(result.timing.median)} ms ` +
      `${format(result.timing.p95)} ms  ${String(result.statements).padStart(2)} statements  ` +
      `${String(result.bytes).padStart(8)} bytes  ${String(result.returned)} returned\n` +
      // The base of every read (live Tasks, signals, concerns) scans its tables
      // once; each distinct scan is listed once, at the largest size only.
      (size === SIZES.at(-1)
        ? [...new Set(result.scans.map((scan) => scan.split("   <- ")[0]!))]
            .map((scan) => `        SCAN of a big table: ${scan}\n`)
            .join("")
        : ""),
  );

const SIZES = [300, 1000, 2400] as const;

/** Runs every read at `size` things and returns the cases. */
const runSize = (size: number) =>
  Effect.gen(function* () {
    yield* seed(size);
    const repository = yield* externalEntityRepository;
    const waits = { list: { savedQuery: "waits" } } as const;
    const everything = { list: { savedQuery: "everything" } } as const;
    const firstWaiting = yield* repository.queryInbox(ENVIRONMENT, waits);
    const firstNewest = yield* repository.queryInbox(ENVIRONMENT, everything);
    const refs = firstNewest.things.map((thing) => thing.ref);
    const cases: Array<Case> = [];
    const pages = (page: { readonly things: ReadonlyArray<unknown> }) => page.things.length;
    cases.push(
      yield* runCase("page: waits (waiting)", repository.queryInbox(ENVIRONMENT, waits), pages),
      yield* runCase(
        "page: everything (newest)",
        repository.queryInbox(ENVIRONMENT, everything),
        pages,
      ),
      yield* runCase(
        "page: narrowed by clauses+text",
        repository.queryInbox(ENVIRONMENT, {
          ...everything,
          clauses: [
            { key: "priority", op: "is", value: "normal" },
            { key: "size", op: "over", value: 10 },
            { key: "opened", op: "over", value: 86_400 },
          ],
          text: "checkout payment",
        }),
        pages,
      ),
      yield* runCase(
        "refs read (200 refs)",
        repository.queryInbox(ENVIRONMENT, { ...everything, refs: refs.slice(0, 200) }),
        pages,
      ),
      yield* runCase(
        "suggest: team",
        repository.suggestInboxValues(ENVIRONMENT, { ...everything, key: "team", prefix: "Te" }),
        (reply) => reply.values.length,
      ),
      yield* runCase(
        "suggest: from",
        repository.suggestInboxValues(ENVIRONMENT, { ...everything, key: "from", prefix: "" }),
        (reply) => reply.values.length,
      ),
      yield* runCase(
        "counts: rail open",
        repository.countInbox(ENVIRONMENT, OPEN_RAIL),
        (counts) => counts.sources.length,
      ),
      yield* runCase(
        "counts: sidebar, all folded",
        repository.countInbox(ENVIRONMENT, FOLDED_RAIL),
        (counts) => counts.sources.length,
      ),
    );
    if (firstNewest.nextCursor !== undefined) {
      cases.push(
        yield* runCase(
          "page: the second one",
          repository.queryInbox(ENVIRONMENT, { ...everything, cursor: firstNewest.nextCursor }),
          pages,
        ),
      );
    }
    return {
      cases,
      waitingTotal: firstWaiting.total,
      newestTotal: firstNewest.total,
      facets: firstNewest.facets?.length ?? 0,
    };
  }).pipe(Effect.provide(TestDatabase));

describe.runIf(SPEED_TESTS_ENABLED)("the Inbox's reads", () => {
  it("sends a constant number of statements and stays fast at 300, 1,000 and 2,400 things", async () => {
    process.stderr.write(
      `\nthe Inbox's reads, median and p95 of ${String(RUNS)}:\n` +
        "  size          read                              median        p95\n",
    );
    const runSizeOnce = (size: number) => Effect.runPromise(runSize(size));
    const bySize = new Map<number, Awaited<ReturnType<typeof runSizeOnce>>>();
    for (const size of SIZES) {
      const result = await runSizeOnce(size);
      bySize.set(size, result);
      for (const one of result.cases) printCase(size, one);
      process.stderr.write(
        `        waits ${String(result.waitingTotal)} of ${String(result.newestTotal)}, ${String(result.facets)} facets on the first page\n`,
      );
    }

    const small = bySize.get(300)!;
    for (const size of SIZES) {
      const result = bySize.get(size)!;
      // The statements of a read never follow the number of things.
      for (const one of result.cases) {
        const same = small.cases.find((other) => other.name === one.name);
        if (same !== undefined)
          expect(one.statements, `${one.name} at ${String(size)}`).toBe(same.statements);
      }
      // A page is bounded whatever the Inbox holds.
      for (const one of result.cases.filter((c) => c.name.startsWith("page"))) {
        expect(one.returned).toBeLessThanOrEqual(200);
        expect(one.bytes).toBeLessThan(200 * 4_000 + 100_000);
      }
      const counts = result.cases.find((c) => c.name === "counts: rail open")!;
      const folded = result.cases.find((c) => c.name === "counts: sidebar, all folded")!;
      expect(counts.timing.median).toBeLessThan(COUNTS_CEILING_MS);
      expect(folded.timing.median).toBeLessThan(COUNTS_CEILING_MS);
      for (const one of result.cases.filter(
        (c) => c.name.startsWith("page") || c.name.startsWith("refs"),
      )) {
        expect(one.timing.median, `${one.name} at ${String(size)}`).toBeLessThan(
          size === 300 ? PAGE_TARGET_MS : LARGE_PAGE_CEILING_MS,
        );
      }
    }
  }, 300_000);
});

/**
 * Writes `part-of` claims from each `[child, parent]` pair, as one Connection
 * reported them, in one transaction.
 */
const seedClaims = (pairs: ReadonlyArray<readonly [string, string]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const connection = mintUuid();
    yield* sql`
      INSERT INTO connections (id, plugin_id, type, label, display_name, account_id, status,
                               labels, config, created_at, updated_at)
      VALUES (${connection}, ${PLUGIN}, 'acme/acme', 'a', 'a', 'a', 'connected', '[]', '{}',
              ${AT}, ${AT})`;
    yield* sql`
      INSERT INTO external_entity_relation_claims
        (from_ref, relation, to_ref, claim_type, connection_id, evidence_key, state, observed_at)
      SELECT json_extract(value, '$[0]'), 'part-of', json_extract(value, '$[1]'), 'source',
             ${connection}, '', 'current', ${AT}
      FROM json_each(${JSON.stringify(pairs)})`;
  }).pipe(inTransaction);

/**
 * Builds a tree of `levels` levels with `fanout` children under each node, as
 * `[child, parent]` pairs, and returns them with the refs of the leaves.
 * Linear's issues sit under a milestone, a project, a team and an initiative,
 * which is five levels with the issue.
 */
const buildTree = (levels: number, fanout: number) => {
  const pairs: Array<readonly [string, string]> = [];
  let level = ["linear:node:0"];
  for (let depth = 1; depth < levels; depth++) {
    const next: Array<string> = [];
    for (const parent of level) {
      for (let child = 0; child < fanout; child++) {
        const ref = `${parent}.${String(child)}`;
        pairs.push([ref, parent]);
        next.push(ref);
      }
    }
    level = next;
  }
  return { pairs, leaves: level };
};

/** Builds a chain of `depth` levels with `leaves` things under its lowest link. */
const buildChain = (depth: number, leaves: number) => {
  const pairs: Array<readonly [string, string]> = [];
  for (let link = 1; link < depth; link++) {
    pairs.push([`chain:${String(link)}`, `chain:${String(link - 1)}`]);
  }
  const starts = Array.from({ length: leaves }, (_, n) => `chain:leaf:${String(n)}`);
  for (const start of starts) pairs.push([start, `chain:${String(depth - 1)}`]);
  return { pairs, leaves: starts };
};

/** Picks `count` refs spread evenly over `refs`. */
const pickSpread = (refs: ReadonlyArray<string>, count: number) =>
  Array.from({ length: count }, (_, n) => refs[Math.floor((n * refs.length) / count)]!);

const ANCESTOR_CASES: ReadonlyArray<
  readonly [
    string,
    () => { pairs: ReadonlyArray<readonly [string, string]>; starts: Array<string> },
  ]
> = [
  [
    "300 leaves of a tree of 5 levels with fanout 10 (11,111 things)",
    () => {
      const tree = buildTree(5, 10);
      return { pairs: tree.pairs, starts: pickSpread(tree.leaves, 300) };
    },
  ],
  [
    "1,000 leaves of a tree of 5 levels with fanout 10 (11,111 things)",
    () => {
      const tree = buildTree(5, 10);
      return { pairs: tree.pairs, starts: pickSpread(tree.leaves, 1000) };
    },
  ],
  [
    "300 leaves under a chain 20 levels deep",
    () => {
      const chain = buildChain(20, 300);
      return { pairs: chain.pairs, starts: chain.leaves };
    },
  ],
];

describe.runIf(SPEED_TESTS_ENABLED)("the walk up part-of", () => {
  it.each(ANCESTOR_CASES)("from %s", async (name, build) => {
    const { pairs, starts } = build();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedClaims(pairs);
        const claims = yield* claimRepository;
        const { value: walk, statements } = yield* captureStatements(claims.readAncestors(starts));
        return {
          statements: statements.length,
          scans: yield* findBigScans(statements),
          deepest: Math.max(...[...walk.ancestors.values()].map((found) => found.length)),
          edges: walk.edges.length,
          cutRefs: walk.cutRefs.size,
          cutAll: walk.cutAll,
          timing: yield* measure(claims.readAncestors(starts)),
        };
      }).pipe(Effect.provide(TestDatabase)),
    );

    process.stderr.write(
      [
        `readAncestors from ${name}, median and p95 of ${String(RUNS)}:`,
        `  ${format(result.timing.median)} ms ${format(result.timing.p95)} ms ` +
          `${String(result.statements)} statements, at most ${String(result.deepest)} ancestors, ` +
          `${String(result.edges)} edges, ${String(result.cutRefs)} starts cut by depth, cut all ${String(result.cutAll)}`,
        ...result.scans.map((scan) => `  SCAN of a big table: ${scan}`),
      ].join("\n") + "\n",
    );
    expect(result.statements).toBe(1);
    expect(result.timing.median).toBeLessThan(ANCESTORS_CEILING_MS);
  });
});

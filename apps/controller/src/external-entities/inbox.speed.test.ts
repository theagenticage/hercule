/**
 * Times the Inbox's reads against a database arranged as production arranges
 * one, counts the statements they send, and prints the numbers. Run it with
 * `pnpm test:speed`.
 *
 * It is opt-in, and not part of `pnpm test` or CI, because time depends on the
 * machine. The database is the test database every controller test uses: a
 * file in a temporary folder, in WAL mode, with a writer and a read-only
 * reader (ADR 0004, amendment of 2026-10-18), not SQLite's in-memory mode. It
 * is seeded with a migrated schema and no statistics, as a controller starts.
 *
 * It times the real statements, through the real services, against the
 * targets of spec 17 §What the Inbox costs:
 *
 * - `externalEntity.queryInbox`, the whole read, at 10, 300 and 1,000 cards,
 *   with and without an open signal on every card, and with and without
 *   handoff offers. The offers come from two workflows for each kind, some
 *   with a workspace on one of three repositories, and two accounts, one of
 *   which cannot act on every seventh card. A case prints the median, the
 *   95th percentile, the statements sent, and the bytes of the encoded reply
 *   in all and for each card;
 * - `externalEntity.countInbox` and `task.readAttention`, the two small reads
 *   the shell sends on every screen;
 * - `signal.query` on the To do view, once with the real `SignalEntities`
 *   port and once with a port that reads nothing, so the difference is the
 *   statements the entities of the signals cost;
 * - the query plan of every statement the Inbox read sends at 300 cards. A
 *   `SCAN` of one of the big tables is printed, so a read that walks every row
 *   shows up;
 * - `readAncestors`, the walk up `part-of` that the Inbox and the board share,
 *   over a hierarchy shaped like a Linear workspace (five levels with ten
 *   children each, 11,111 things) and over a chain twenty levels deep.
 *
 * The cards are issues of a Linear-like kind, two thirds of them, under ten
 * projects under two teams; and pull requests of a GitHub-like kind, the
 * other third, each linked to the issue two cards on and landing in one of three
 * repositories. Every tenth card has a live Task, and every twentieth a
 * running run on it.
 *
 * What it guards is an order of magnitude: the ceilings are far above what
 * the reads take, and the statement counts must not follow the cards.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { Inbox, InboxCounts, SignalPage, TaskAttention } from "@hercule/contract";
import {
  HOST_API,
  registerConnectionType,
  registerEventSource,
  type EntityKindDeclaration,
  type EntityObservation,
  type Plugin,
} from "@hercule/plugin-host";
import { CurrentActor } from "../actor";
import { FakeBoundOperationsLayer } from "../bound-actions/testing";
import { connectionRepository } from "../connections";
import { SignalEntitiesLayer } from "../daemon/ingest";
import { TaskServicePortsLayer } from "../daemon/tasks";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { EntityLookups, PluginHost } from "../plugins";
import { buildPluginStack, IDLE_FEEDS, IDLE_INGEST_OPEN, USER } from "../plugins/testing";
import { signalRepository } from "../signals/repository";
import {
  SignalClaimsLayer,
  type SignalEntities,
  SignalService,
  SignalServiceLayer,
} from "../signals";
import { buildSignalEntitiesDouble } from "../signals/signal-entities.testing";
import { TaskService, TaskServiceLayer } from "../tasks";
import { claimRepository } from "./claims";
import { externalEntityRepository, type ObservedEntity } from "./repository";
import { ExternalEntityService, ExternalEntityServiceLayer } from "./service";
import { renderEntitySlots } from "./slots";

/** Set to "1" by `pnpm test:speed`. */
const SPEED_TESTS_ENABLED = process.env["RUN_SPEED_TESTS"] === "1";

/** The target of spec 17 for the Inbox read at 300 cards, in milliseconds. */
const INBOX_TARGET_MS = 20;

/** The most time the Inbox read may take at 300 cards before the test fails, in milliseconds. */
const INBOX_CEILING_MS = 100;

/** The most time the Inbox read may take at 1,000 cards before the test fails, in milliseconds. */
const LARGE_INBOX_CEILING_MS = 300;

/** The most time a shell read (the counts, the attention) may take, in milliseconds. */
const SHELL_READ_CEILING_MS = 50;

/** The most time one walk up may take, in milliseconds. */
const ANCESTORS_CEILING_MS = 200;

/** How often each read is timed after it has warmed up. */
const RUNS = 25;
const WARM_UP_RUNS = 5;

const AT = "2026-11-01T09:00:00.000Z";

/** The tables a `SCAN` of which follows the size of the database rather than the page. */
const BIG_TABLES = [
  "external_entities",
  "external_entity_observations",
  "external_entity_relation_claims",
  "signals",
  "tasks",
  "task_entity_links",
  "runs",
  "sessions",
];

/** The repositories the pull requests land in, as canonical remotes. */
const REMOTES = ["github.com/acme/web", "github.com/acme/api", "github.com/acme/mobile"];

/** An issue, modelled on the Linear plugin's: a rich, slow card with a person, facts and reasons. */
const ISSUE_KIND: EntityKindDeclaration = {
  word: "issue",
  noun: "Issue",
  refPrefix: "acme:issue:",
  card: "rich",
  pace: "slow",
  patience: 336,
  identifier: "{key}",
  person: "assignee",
  owner: "assignee",
  home: "project",
  status: {
    backlog: { shape: "dashed", tone: "quiet", word: "Backlog", stage: "exploring" },
    todo: { shape: "ring", tone: "quiet", word: "Todo", stage: "planned" },
    started: { shape: "half", tone: "active", word: "In Progress", stage: "building" },
  },
  facts: [
    { field: "priority", form: "bars" },
    { field: "milestone", form: "word" },
  ],
  reasons: {
    assigned: { say: "Assigned to you", tone: "plain" },
    mention: { say: "{person} mentioned you", tone: "plain" },
  },
};

/** A pull request, modelled on the GitHub plugin's: a compact, fast card in a repository. */
const PULL_KIND: EntityKindDeclaration = {
  word: "pull",
  noun: "Pull request",
  refPrefix: "acme:pull:",
  card: "compact",
  pace: "fast",
  patience: 24,
  identifier: "{key}",
  person: "author",
  owner: "author",
  status: {
    open: { shape: "ring", tone: "active", word: "Open", stage: "in-review" },
    draft: { shape: "dashed", tone: "quiet", word: "Draft", stage: "building" },
  },
  facts: [],
  reasons: {
    "review-requested": { say: "{person} asked for your review", tone: "plain" },
  },
};

/** Builds a place kind: no card, no clock, groupable with a caption. */
const buildPlaceKind = (word: string, noun: string, caption: string): EntityKindDeclaration => ({
  word,
  noun,
  refPrefix: `acme:${word}:`,
  pace: "context",
  patience: 0,
  identifier: "{key}",
  person: null,
  owner: null,
  groupable: { caption },
  status: null,
  facts: [],
  reasons: {},
});

const PLUGIN = "acme";
const SIGNAL_KIND = `${PLUGIN}/review-requested`;

/** An invented tracker plugin with issues, pull requests, projects and teams. */
const trackerPlugin: Plugin = {
  manifest: {
    id: PLUGIN,
    displayName: "Acme",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources", "events", "entities"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    Effect.andThen(
      registerConnectionType(host, {
        type: "acme",
        displayName: "Acme",
        setup: [],
        validate: () => Effect.succeed({ displayName: "Acme", accountId: "acme-1" }),
      }),
      registerEventSource(host, {
        id: "acme",
        connectionType: "acme/acme",
        feeds: IDLE_FEEDS,
        entityKinds: [
          ISSUE_KIND,
          PULL_KIND,
          buildPlaceKind("project", "Project", "Acme project"),
          buildPlaceKind("team", "Team", "Acme team"),
        ],
        kinds: {
          "acme.thing.done": {
            description: "Something was done.",
            schema: Schema.Struct({ title: Schema.String }),
            availableToTriage: true,
          },
        },
        open: IDLE_INGEST_OPEN,
      }),
    ),
  activate: () => Effect.succeed(Effect.void),
};

/** Lookups that reach no source: the reads timed here never call them. */
const IDLE_LOOKUPS: EntityLookups["Service"] = {
  recognize: () => Effect.succeed([]),
  listLinkSources: () => Effect.succeed([PLUGIN]),
  search: () => Effect.succeed({ observations: [], incomplete: false, outcome: "results" }),
  resolve: () => Effect.succeed({ missing: "unknown" }),
};

const layer = ExternalEntityServiceLayer.pipe(
  Layer.provideMerge(Layer.succeed(EntityLookups)(IDLE_LOOKUPS)),
  Layer.provideMerge(
    TaskServiceLayer.pipe(
      Layer.provideMerge(NotifierLayer),
      Layer.provideMerge(TaskServicePortsLayer),
      Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
    ),
  ),
  Layer.provideMerge(buildPluginStack()),
);

/**
 * Builds the signal service over the outer database and plugin host, with
 * `entities` as its `SignalEntities` port.
 */
const buildSignalServiceLayer = (
  entities: Layer.Layer<SignalEntities, never, SqlClient.SqlClient>,
) =>
  SignalServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(FakeBoundOperationsLayer, SignalClaimsLayer, entities)),
  );

const issueRef = (n: number) => `acme:issue:${String(n)}`;
const pullRef = (n: number) => `acme:pull:${String(n)}`;
const projectRef = (n: number) => `acme:project:${String(n)}`;
const teamRef = (n: number) => `acme:team:${String(n)}`;

/** The ref of card `n`: every third card is a pull request, the rest are issues. */
const cardRef = (n: number) => (n % 3 === 0 ? pullRef(n) : issueRef(n));

/** What a case seeds besides its cards. */
interface Arrangement {
  readonly cards: number;
  /** One open signal on every card. */
  readonly signals: boolean;
  /** Workflows that take each kind, and a second account. */
  readonly offers: boolean;
  /** History that is not on the Inbox: partial records, things a card mentions but nobody follows. */
  readonly partialRecords?: number;
  /** History that is not on the Inbox: done Tasks that each link a ref of their own. */
  readonly doneTaskLinks?: number;
}

/** Builds the observation of card `n`, as a Connection reports it. */
const buildCardObservation = (n: number): EntityObservation => {
  const sourceUpdatedAt = new Date(Date.parse(AT) + n * 60_000).toISOString();
  if (n % 3 === 0) {
    return {
      kind: "pull",
      ref: pullRef(n),
      title: `Make the checkout page remember the last payment method (${String(n)})`,
      url: `https://code.example/acme/pull/${String(n)}`,
      lifecycle: "open",
      status: n % 2 === 0 ? "open" : "draft",
      fields: { key: `#${String(n)}`, author: "Dana Whitfield" },
      concerns: ["review-requested"],
      repository: { target: { remote: REMOTES[Math.floor(n / 3) % REMOTES.length]! } },
      relations: { complete: true, partOf: [], linked: [issueRef(n + 2)] },
      sourceUpdatedAt,
    };
  }
  return {
    kind: "issue",
    ref: issueRef(n),
    title: `Refunds over 500 euros need a second approval before they go out (${String(n)})`,
    url: `https://tracker.example/acme/issue/${String(n)}`,
    lifecycle: "open",
    status: ["backlog", "todo", "started"][n % 3]!,
    fields: {
      key: `ACME-${String(n)}`,
      assignee: "Rogier Pennink",
      priority: (n % 3) + 1,
      milestone: "Beta",
    },
    concerns: ["assigned"],
    relations: { complete: true, partOf: [projectRef(n % 10)], linked: [] },
    sourceUpdatedAt,
  };
};

/** Builds the observations of the ten projects, each under one of two teams, and of the teams. */
const buildPlaceObservations = (): ReadonlyArray<EntityObservation> => [
  ...Array.from({ length: 10 }, (_, n) => ({
    kind: "project",
    ref: projectRef(n),
    title: `Northwind Market project ${String(n)}`,
    fields: { key: `P${String(n)}` },
    concerns: [],
    relations: { complete: true, partOf: [teamRef(n % 2)], linked: [] },
    sourceUpdatedAt: AT,
  })),
  ...Array.from({ length: 2 }, (_, n) => ({
    kind: "team",
    ref: teamRef(n),
    title: `Team ${String(n)}`,
    fields: { key: `T${String(n)}` },
    concerns: [],
    sourceUpdatedAt: AT,
  })),
];

/**
 * Seeds a case: the plugin, one account (two with offers), the cards and the
 * places through `reconcile` as a poll stores them, a live Task on every
 * tenth card with a running run on every twentieth, and, as asked, an open
 * signal on every card and the workflows and repositories of the offers.
 */
const seed = (arrangement: Arrangement) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const host = yield* PluginHost;
    yield* host.boot([trackerPlugin]);
    const connections = yield* connectionRepository;
    const entities = yield* externalEntityRepository;
    const signals = yield* signalRepository;
    const declarations = yield* host.listEntityKinds(PLUGIN);

    const insertAccount = (accountId: string) =>
      Effect.map(
        inTransaction(
          connections.insert({
            pluginId: PLUGIN,
            type: "acme/acme",
            label: accountId,
            displayName: accountId,
            accountId,
            labels: [],
            config: {},
            at: AT,
          }),
        ),
        (inserted) => inserted.id,
      );

    const render = (observation: EntityObservation) =>
      Effect.map(
        renderEntitySlots(
          declarations.find((candidate) => candidate.word === `${PLUGIN}/${observation.kind}`)!,
          observation as Parameters<typeof renderEntitySlots>[1],
        ),
        (slots): ObservedEntity => ({
          kind: `${PLUGIN}/${observation.kind}`,
          observation,
          slots,
        }),
      );

    /** Stores what one Connection reports, one `reconcile` for each kind, as a poll does. */
    const report = (connectionId: string, observations: ReadonlyArray<EntityObservation>) =>
      Effect.gen(function* () {
        const observed = yield* Effect.forEach(observations, render);
        const byKind = new Map<string, Array<ObservedEntity>>();
        for (const entity of observed) {
          byKind.set(entity.kind, [...(byKind.get(entity.kind) ?? []), entity]);
        }
        for (const [kind, group] of byKind) {
          yield* inTransaction(
            entities.reconcile({
              connectionId,
              kind,
              complete: false,
              observed: group,
              actor: `plugin:${PLUGIN}`,
              environment: { now: AT, activePluginIds: [PLUGIN] },
            }),
          );
        }
      });

    const cardNumbers = Array.from({ length: arrangement.cards }, (_, n) => n + 1);
    const first = yield* insertAccount("acme-1");
    yield* report(first, [...buildPlaceObservations(), ...cardNumbers.map(buildCardObservation)]);
    if (arrangement.offers) {
      // A second account reads every other card, and no account can act on
      // every seventh card, so cards differ in their acting-account state.
      const second = yield* insertAccount("acme-2");
      yield* report(second, cardNumbers.filter((n) => n % 2 === 0).map(buildCardObservation));
      yield* inTransaction(sql`
        UPDATE external_entity_observations SET access = 'inaccessible'
        WHERE ref IN (SELECT value FROM json_each(${JSON.stringify(
          cardNumbers.filter((n) => n % 7 === 0).map(cardRef),
        )}))`);
    }

    yield* inTransaction(
      Effect.gen(function* () {
        const resourceIds = REMOTES.map(() => uuidToString(mintUuid()));
        const workflowIds = [mintUuid(), mintUuid(), mintUuid(), mintUuid()];
        if (arrangement.offers) {
          for (const [index, remote] of REMOTES.entries()) {
            yield* sql`
              INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include,
                                     created_at, updated_at)
              VALUES (${uuidFromString(resourceIds[index]!)}, 'repo', ${`https://${remote}.git`}, ${remote}, 1,
                      ${AT}, ${AT})`;
          }
          // Two workflows for each kind: one with no workspace, and one that
          // works in a repository, so a pull request in another one cannot use it.
          const definitions = [
            { name: "Plan the issue", kinds: [`${PLUGIN}/issue`], workspace: undefined },
            { name: "Fix the issue", kinds: [`${PLUGIN}/issue`], resource: 1 },
            { name: "Review the pull request", kinds: [`${PLUGIN}/pull`], resource: undefined },
            { name: "Fix the web pull request", kinds: [`${PLUGIN}/pull`], resource: 0 },
          ];
          for (const [index, definition] of definitions.entries()) {
            const workspace =
              definition.resource === undefined
                ? {}
                : {
                    workspace: {
                      kind: "ephemeral",
                      checkouts: [{ resourceId: resourceIds[definition.resource]! }],
                    },
                  };
            yield* sql`
              INSERT INTO workflows (id, source, definition, enabled, created_at, updated_at)
              VALUES (${workflowIds[index]!}, 'name: x', ${JSON.stringify({
                name: definition.name,
                inputs: [
                  { name: "item", entity: { kinds: definition.kinds }, required: true },
                  {
                    name: "account",
                    connection: { type: `${PLUGIN}/acme` },
                    required: true,
                  },
                ],
                ...workspace,
                steps: [{ id: "work", kind: "agent", prompt: "Do the work" }],
              })}, 1, ${AT}, ${AT})`;
          }
        }

        // A live Task on every tenth card, and a running run on every twentieth.
        for (const n of cardNumbers.filter((card) => card % 10 === 0)) {
          const taskId = mintUuid();
          yield* sql`
            INSERT INTO tasks (id, title, description, status, stage, priority, labels, created_at,
                               updated_at, status_changed_at, stage_changed_at)
            VALUES (${taskId}, ${`Task for card ${String(n)}`}, '', 'in-progress', 'building',
                    'normal', '[]', ${AT}, ${AT}, ${AT}, ${AT})`;
          yield* sql`
            INSERT INTO task_entity_links (task_id, ref, linked_at, linked_by, following)
            VALUES (${taskId}, ${cardRef(n)}, ${AT}, 'user', 1)`;
          if (n % 20 === 0) {
            yield* sql`
              INSERT INTO runs (id, workflow_id, plan, inputs, origin, status, created_at,
                                started_at, task_id)
              VALUES (${mintUuid()}, ${workflowIds[0]!}, '{"name":"Plan the issue","steps":[]}',
                      '{}', '{"kind":"manual","actor":"user"}', 'running', ${AT}, ${AT}, ${taskId})`;
          }
        }

        const { partialRecords = 0, doneTaskLinks = 0 } = arrangement;
        if (partialRecords > 0) {
          yield* sql`
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${partialRecords})
            INSERT INTO external_entities (id, ref, kind, noun, completeness, title,
                                           first_observed_at, updated_at)
            SELECT randomblob(16), 'acme:issue:old-' || i, ${`${PLUGIN}/issue`}, 'Issue',
                   'partial', 'Old issue ' || i, ${AT}, ${AT}
            FROM n`;
        }
        if (doneTaskLinks > 0) {
          yield* sql`
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${doneTaskLinks})
            INSERT INTO tasks (id, title, description, status, stage, priority, labels, created_at,
                               updated_at, status_changed_at, stage_changed_at)
            SELECT unhex(printf('%08x000070008000%012x', i, 0)), 'Done ' || i, '', 'done', 'done',
                   'normal', '[]', ${AT}, ${AT}, ${AT}, ${AT}
            FROM n`;
          yield* sql`
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${doneTaskLinks})
            INSERT INTO task_entity_links (task_id, ref, linked_at, linked_by, following)
            SELECT unhex(printf('%08x000070008000%012x', i, 0)), 'acme:issue:done-' || i, ${AT},
                   'user', 0
            FROM n`;
        }

        if (arrangement.signals) {
          for (const n of cardNumbers) {
            yield* signals.insert(
              {
                id: uuidToString(mintUuid()),
                kind: SIGNAL_KIND,
                origin: { type: "event", eventId: n, connectionId: first, threadRef: cardRef(n) },
                title: `Dana Whitfield asked for your review on card ${String(n)}`,
                place: "acme/web",
                priority: "normal",
                blocks: [],
                actions: [],
                match: {},
                status: "open",
                createdAt: new Date(Date.parse(AT) + n * 1000).toISOString(),
              },
              [],
            );
          }
        }
      }),
    );
  });

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

/**
 * Returns the fields of the cards that take the most bytes, with the bytes
 * each takes on an average card (its key and value), largest first.
 */
const measureFieldBytes = (
  cards: ReadonlyArray<Readonly<Record<string, unknown>>>,
  count: number,
): ReadonlyArray<string> => {
  const totals = new Map<string, number>();
  for (const card of cards) {
    for (const [key, value] of Object.entries(card)) {
      totals.set(key, (totals.get(key) ?? 0) + measureBytes({ [key]: value }) - 2);
    }
  }
  return [...totals]
    .toSorted(([, left], [, right]) => right - left)
    .slice(0, count)
    .map(([key, total]) => `${key} ${String(Math.round(total / cards.length))}`);
};

const format = (ms: number) => ms.toFixed(2).padStart(7);

const CASES: ReadonlyArray<readonly [string, Arrangement]> = [
  ["10 cards", { cards: 10, signals: false, offers: false }],
  ["300 cards", { cards: 300, signals: false, offers: false }],
  ["300 cards, 300 open signals", { cards: 300, signals: true, offers: false }],
  ["10 cards, signals, offers", { cards: 10, signals: true, offers: true }],
  ["300 cards, signals, offers", { cards: 300, signals: true, offers: true }],
  ["1,000 cards, signals, offers", { cards: 1000, signals: true, offers: true }],
  [
    "300 cards, signals, offers, 20,000 partial records",
    { cards: 300, signals: true, offers: true, partialRecords: 20_000 },
  ],
  [
    "300 cards, signals, offers, 20,000 links of done Tasks",
    { cards: 300, signals: true, offers: true, doneTaskLinks: 20_000 },
  ],
];

/** Shortens a statement to its first words, to name it in a printed list. */
const summarizeStatement = (text: string): string =>
  text.replaceAll(/\s+/g, " ").trim().slice(0, 100);

/** The statements each case sent, shortened, by case name, so a larger case can be compared with a smaller one. */
const statementsByCase = new Map<string, ReadonlyArray<string>>();

/** Returns the entries of `larger` that `smaller` does not have, each as often as it is missing. */
const listExtraStatements = (
  larger: ReadonlyArray<string>,
  smaller: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const left = [...smaller];
  return larger.filter((text) => {
    const index = left.indexOf(text);
    if (index === -1) return true;
    left.splice(index, 1);
    return false;
  });
};

describe.runIf(SPEED_TESTS_ENABLED)("the Inbox's reads", () => {
  it.each(CASES)("with %s", async (name, arrangement) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(arrangement);
        const service = yield* ExternalEntityService;
        const tasks = yield* TaskService;
        const { value: inbox, statements } = yield* captureStatements(service.queryInbox());
        const encoded = Schema.encodeSync(Inbox)(inbox);
        const counted = yield* captureStatements(service.countInbox());
        const attention = yield* captureStatements(tasks.readAttention());
        Schema.encodeSync(InboxCounts)(counted.value);
        Schema.encodeSync(TaskAttention)(attention.value);
        const signalQuery =
          arrangement.signals && arrangement.cards === 300
            ? yield* Effect.gen(function* () {
                const signals = yield* SignalService;
                const page = yield* captureStatements(signals.query({}));
                return {
                  statements: page.statements.length,
                  items: page.value.items.length,
                  withEntity: page.value.items.filter((item) => item.entity !== undefined).length,
                  bytes: measureBytes(Schema.encodeSync(SignalPage)(page.value)),
                  timing: yield* measure(signals.query({})),
                };
              }).pipe(Effect.provide(buildSignalServiceLayer(SignalEntitiesLayer)))
            : undefined;
        const signalQueryWithoutEntities =
          signalQuery === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                const signals = yield* SignalService;
                const page = yield* captureStatements(signals.query({}));
                return { statements: page.statements.length };
              }).pipe(Effect.provide(buildSignalServiceLayer(buildSignalEntitiesDouble().layer)));
        return {
          cards: inbox.cards.length,
          offerSets: Object.keys(inbox.offerSets).length,
          places: inbox.places.length,
          truncated: inbox.truncated,
          statements: statements.length,
          statementTexts: statements.map(([text]) => summarizeStatement(text)),
          bytes: measureBytes(encoded),
          cardBytes: measureBytes(encoded.cards),
          fieldBytes: measureFieldBytes(encoded.cards, 8),
          scans: arrangement.cards === 300 ? yield* findBigScans(statements) : [],
          countScans: arrangement.cards === 300 ? yield* findBigScans(counted.statements) : [],
          queryInbox: yield* measure(service.queryInbox()),
          countInbox: {
            statements: counted.statements.length,
            ...(yield* measure(service.countInbox())),
          },
          readAttention: {
            statements: attention.statements.length,
            ...(yield* measure(tasks.readAttention())),
          },
          signalQuery,
          signalQueryWithoutEntities,
        };
      }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer)),
    );

    statementsByCase.set(name, result.statementTexts);
    // The case of 10 cards with the same arrangement, when it ran before this
    // one; a case run on its own has nothing to compare with.
    const smaller =
      statementsByCase.get(arrangement.offers ? "10 cards, signals, offers" : "10 cards") ??
      result.statementTexts;
    const lines = [
      `${name}: ${String(result.cards)} cards, ${String(result.places)} places, ` +
        `${String(result.offerSets)} offer sets, truncated ${String(result.truncated)}, median and p95 of ${String(RUNS)}`,
      `  externalEntity.queryInbox  ${format(result.queryInbox.median)} ms ${format(result.queryInbox.p95)} ms ` +
        `${String(result.statements).padStart(3)} statements ${String(result.bytes).padStart(8)} B ` +
        `${String(Math.round(result.bytes / Math.max(result.cards, 1))).padStart(5)} B/card ` +
        `(the cards alone ${String(Math.round(result.cardBytes / Math.max(result.cards, 1)))} B/card)`,
      `  bytes of a card by field: ${result.fieldBytes.join(", ")}`,
      `  externalEntity.countInbox  ${format(result.countInbox.median)} ms ${format(result.countInbox.p95)} ms ` +
        `${String(result.countInbox.statements).padStart(3)} statements`,
      `  task.readAttention         ${format(result.readAttention.median)} ms ${format(result.readAttention.p95)} ms ` +
        `${String(result.readAttention.statements).padStart(3)} statements`,
      ...(result.signalQuery === undefined
        ? []
        : [
            `  signal.query (To do)       ${format(result.signalQuery.timing.median)} ms ${format(result.signalQuery.timing.p95)} ms ` +
              `${String(result.signalQuery.statements).padStart(3)} statements ` +
              `(${String(result.signalQueryWithoutEntities!.statements)} without SignalEntities), ` +
              `${String(result.signalQuery.items)} signals, ${String(result.signalQuery.withEntity)} with an entity, ` +
              `${String(result.signalQuery.bytes)} B`,
          ]),
      ...result.scans.map((scan) => `  queryInbox scans: ${scan}`),
      ...result.countScans.map((scan) => `  countInbox scans: ${scan}`),
      ...listExtraStatements(result.statementTexts, smaller).map(
        (text) => `  more than at 10 cards: ${text}`,
      ),
      ...listExtraStatements(smaller, result.statementTexts).map(
        (text) => `  fewer than at 10 cards: ${text}`,
      ),
    ];
    process.stderr.write(lines.join("\n") + "\n");

    expect(result.cards).toBe(arrangement.cards);
    if (!arrangement.signals || arrangement.offers) {
      expect(result.statements).toBe(smaller.length);
    }
    if (arrangement.cards === 300) {
      expect(result.queryInbox.median).toBeLessThan(INBOX_CEILING_MS);
      if (result.queryInbox.median >= INBOX_TARGET_MS) {
        process.stderr.write(`  MISSES the target of ${String(INBOX_TARGET_MS)} ms\n`);
      }
    }
    if (arrangement.cards === 1000) {
      expect(result.queryInbox.median).toBeLessThan(LARGE_INBOX_CEILING_MS);
    }
    expect(result.countInbox.median).toBeLessThan(SHELL_READ_CEILING_MS);
    expect(result.readAttention.median).toBeLessThan(SHELL_READ_CEILING_MS);
  });
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

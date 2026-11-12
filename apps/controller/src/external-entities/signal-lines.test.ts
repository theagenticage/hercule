/**
 * Tests how signals live inside their External Entity, through the External
 * Entities repository on a migrated database with an invented tracker plugin
 * (tickets are compact and fast, epics rich and slow, projects a place):
 *
 * - the join of a signal to its entity by exact ref, in every order it can
 *   happen, and what never joins
 * - Inbox membership, the counts and the arrival number a signal brings
 * - a snooze that ends with time, and a dismissal that holds
 * - the sentence a card and its lines say
 * - what the detail selects when a thing has many signals
 * - what a signal keeps wanted and kept, and what `listWanted` adds for it
 *
 * Every body runs in one transaction on a fresh database. Each step passes its
 * own minute, so the time is exact.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { MAX_ENTITY_SIGNALS, type Signal } from "@hercule/contract";
import { uuidFromString, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { signalRepository } from "../signals/repository";
import { externalEntityRepository, type ObservedEntity } from "./repository";
import type { EntitySlots, FullEntityObservation } from "./slots";

type Repository = Effect.Success<typeof externalEntityRepository>;

const BASE = Date.parse("2026-03-01T00:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const at = (minutes: number): string => new Date(BASE + minutes * MINUTE).toISOString();

const PLUGIN = "acme-tracker";
const ACCOUNT_A = "0190c000-0000-7000-8000-0000000000a1";
const ACCOUNT_B = "0190c000-0000-7000-8000-0000000000a2";
const TICKET_KIND = "acme-tracker/ticket";
const EPIC_KIND = "acme-tracker/epic";
const PROJECT_KIND = "acme-tracker/project";
const TICKET_PREFIX = "acme-tracker:ticket:";
const ticketRef = (name: string) => `${TICKET_PREFIX}${name}`;
const epicRef = (name: string) => `acme-tracker:epic:${name}`;
const PROJECT = "acme-tracker:project:harbour";

const MENTIONED_TEMPLATES = {
  mentioned: { say: "{person} mentioned you", tone: "attention" },
  "needs-nobody": { say: "Waiting on review", tone: "plain" },
} as const;

const TICKET_SLOTS: EntitySlots = {
  noun: "Ticket",
  card: "compact",
  pace: "fast",
  patience: 24,
  identifier: "T",
  facts: [],
  reasonTemplates: MENTIONED_TEMPLATES,
};
const EPIC_SLOTS: EntitySlots = {
  noun: "Epic",
  card: "rich",
  pace: "slow",
  patience: 336,
  identifier: "E",
  facts: [],
};
const PROJECT_SLOTS: EntitySlots = { noun: "Project", pace: "context", caption: "Tracker project" };

const baseObservation = {
  url: "https://tracker.example/x",
  lifecycle: "open",
  fields: {},
  concerns: [],
  sourceUpdatedAt: at(1),
} as const;

/** Builds a ticket nobody has a concern for, unless `concerns` says so. */
const ticket = (
  name: string,
  options: Partial<FullEntityObservation> & { readonly slots?: EntitySlots } = {},
): ObservedEntity => {
  const { slots, ...rest } = options;
  return {
    kind: TICKET_KIND,
    slots: slots ?? TICKET_SLOTS,
    observation: {
      ...baseObservation,
      kind: "ticket",
      ref: ticketRef(name),
      title: `Ticket ${name}`,
      ...rest,
    },
    fieldRows: [],
  };
};

const epic = (name: string): ObservedEntity => ({
  kind: EPIC_KIND,
  slots: EPIC_SLOTS,
  observation: { ...baseObservation, kind: "epic", ref: epicRef(name), title: `Epic ${name}` },
  fieldRows: [],
});

const project: ObservedEntity = {
  kind: PROJECT_KIND,
  slots: PROJECT_SLOTS,
  observation: {
    kind: "project",
    ref: PROJECT,
    title: "Harbour",
    fields: {},
    concerns: [],
    sourceUpdatedAt: at(1),
  },
  fieldRows: [],
};

const environment = (minutes: number) => ({ now: at(minutes), activePluginIds: [PLUGIN] });

let signalCounter = 0;
const signalId = () => `0199e0e7-0005-7000-8000-${String(++signalCounter).padStart(12, "0")}`;

interface SignalOptions {
  readonly kind?: string;
  readonly title?: string;
  readonly asker?: string;
  readonly connectionId?: string;
  readonly createdAt?: string;
  readonly resolved?: boolean;
  readonly snoozeUntil?: string;
}

/** Writes a signal raised from an event on the thread `threadRef`, and returns its id. */
const raiseSignal = (threadRef: string, options: SignalOptions = {}) =>
  Effect.gen(function* () {
    const signals = yield* signalRepository;
    const id = signalId();
    const signal: Signal = {
      id,
      kind: options.kind ?? "acme-tracker/mentioned",
      origin: {
        type: "event",
        eventId: 1,
        connectionId: options.connectionId ?? ACCOUNT_A,
        threadRef,
      },
      title: options.title ?? "Marta mentioned you",
      ...(options.asker === undefined ? {} : { asker: options.asker }),
      priority: "normal",
      blocks: [],
      actions: [],
      match: {},
      status: options.resolved === true ? "resolved" : "open",
      ...(options.resolved === true
        ? {
            resolution: {
              kind: "decided" as const,
              actionId: "done",
              outcome: "Marked done",
              actor: "user" as const,
              origin: "web",
              at: at(2),
            },
          }
        : {}),
      createdAt: options.createdAt ?? at(2),
    };
    yield* signals.insert(signal, []);
    if (options.snoozeUntil !== undefined) {
      yield* signals.snooze([id], { until: options.snoozeUntil, snoozedAt: at(2), actor: "user" });
    }
    return id;
  });

/** Runs `body` on a fresh migrated database with two Connections of the plugin, in one transaction. */
const run = <A>(
  body: (context: {
    readonly repository: Repository;
    readonly sql: SqlClient.SqlClient;
    readonly reconcile: (
      connectionId: string,
      observed: ReadonlyArray<ObservedEntity>,
      minutes: number,
    ) => Effect.Effect<unknown, unknown>;
    readonly refresh: (
      connectionId: string,
      observed: ReadonlyArray<ObservedEntity>,
      minutes: number,
    ) => Effect.Effect<unknown, unknown>;
  }) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
        VALUES (${PLUGIN}, 1, '{}', ${at(0)}, ${at(0)})`;
      for (const [id, name] of [
        [ACCOUNT_A, "a"],
        [ACCOUNT_B, "b"],
      ] as const) {
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (${uuidFromString(id)}, ${PLUGIN}, ${`${PLUGIN}/account`}, ${name}, ${name},
            ${name}, 'connected', '[]', '{}', ${at(0)}, ${at(0)})`;
      }
      const repository = yield* externalEntityRepository;
      return yield* body({
        repository,
        sql,
        reconcile: (connectionId, observed, minutes) =>
          repository.reconcile({
            connectionId,
            kind: TICKET_KIND,
            complete: false,
            observed,
            actor: `plugin:${PLUGIN}`,
            environment: environment(minutes),
          }),
        refresh: (connectionId, observed, minutes) =>
          repository.refresh({ connectionId, observed, environment: environment(minutes) }),
      });
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

/** The signal kinds the tests raise: the mention and the unlisted kind ask, the assignment does not. */
const ASKING_KINDS = ["acme-tracker/mentioned", "acme-tracker/unlisted"];

const inboxEnvironment = (minutes: number) => ({
  ...environment(minutes),
  signalKinds: [
    { kind: "acme-tracker/mentioned", noun: "mention", asks: true },
    { kind: "acme-tracker/unlisted", noun: "unlisted thing", asks: true },
    { kind: "acme-tracker/assigned", noun: "assignment", asks: false },
  ],
  savedQueries: [],
  askingKinds: ASKING_KINDS,
});

const readInbox = (repository: Repository, minutes: number) =>
  repository.queryInbox(inboxEnvironment(minutes), { list: { savedQuery: "everything" } });

const readCounts = (repository: Repository, minutes: number) =>
  repository.countInbox(inboxEnvironment(minutes), { pins: [], browseFolded: [] });

const cardRefs = (inbox: { readonly things: ReadonlyArray<{ readonly ref: string }> }) =>
  inbox.things.map((card) => card.ref);

const readDetail = (
  repository: Repository,
  sql: SqlClient.SqlClient,
  ref: string,
  minutes: number,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly id: Uint8Array }>`
      SELECT id FROM external_entities WHERE ref = ${ref}`;
    const found = yield* repository.readEntity(uuidToString(rows[0]!.id), {
      ...environment(minutes),
      activeKinds: new Set([TICKET_KIND, EPIC_KIND]),
    });
    if (found._tag === "None") throw new Error(`no detail for ${ref}`);
    return found.value;
  });

describe("the join of a signal to its entity", () => {
  interface JoinCase {
    readonly name: string;
    /** Arranges the rows and returns the refs on the Inbox at minute 10, and each one's live signal count. */
    readonly arrange: (
      context: Parameters<Parameters<typeof run>[0]>[0],
    ) => Effect.Effect<ReadonlyArray<readonly [string, number]>, unknown, SqlClient.SqlClient>;
    readonly expected: ReadonlyArray<readonly [string, number]>;
  }

  const summarize = (repository: Repository) =>
    Effect.map(readInbox(repository, 10), (inbox) =>
      inbox.things.map((card): readonly [string, number] => [card.ref, card.askCount]),
    );

  const cases: ReadonlyArray<JoinCase> = [
    {
      name: "a signal before its entity stays alone, then attaches when the entity appears",
      arrange: ({ repository, refresh }) =>
        Effect.gen(function* () {
          yield* raiseSignal(ticketRef("early"));
          expect(cardRefs(yield* readInbox(repository, 5))).toEqual([]);
          yield* refresh(ACCOUNT_A, [ticket("early")], 6);
          return yield* summarize(repository);
        }),
      expected: [[ticketRef("early"), 1]],
    },
    {
      name: "an entity before its signal gets the signal on its card",
      arrange: ({ repository, reconcile }) =>
        Effect.gen(function* () {
          yield* reconcile(ACCOUNT_A, [ticket("late", { concerns: ["assigned"] })], 1);
          yield* raiseSignal(ticketRef("late"));
          yield* raiseSignal(ticketRef("late"), { createdAt: at(3) });
          return yield* summarize(repository);
        }),
      expected: [[ticketRef("late"), 2]],
    },
    {
      name: "a core signal raised from an event joins like any other, and asks nothing",
      arrange: ({ repository, refresh }) =>
        Effect.gen(function* () {
          yield* refresh(ACCOUNT_A, [ticket("core")], 1);
          yield* raiseSignal(ticketRef("core"), { kind: "fyi", title: "Heads up" });
          return yield* summarize(repository);
        }),
      expected: [[ticketRef("core"), 0]],
    },
    {
      name: "a thread on a place stays alone before and after its record exists",
      arrange: ({ repository, reconcile }) =>
        Effect.gen(function* () {
          yield* raiseSignal(PROJECT);
          const before = yield* summarize(repository);
          yield* reconcile(ACCOUNT_A, [project], 2);
          const after = yield* summarize(repository);
          const entities = yield* repository.readSignalEntities([PROJECT]);
          expect([before, after, entities.size]).toEqual([[], [], 0]);
          return after;
        }),
      expected: [],
    },
    {
      name: "a ticket and an epic of the same name are different things",
      arrange: ({ repository, refresh }) =>
        Effect.gen(function* () {
          yield* refresh(ACCOUNT_A, [ticket("7")], 1);
          yield* refresh(ACCOUNT_A, [epic("7")], 1);
          yield* raiseSignal(ticketRef("7"));
          return yield* summarize(repository);
        }),
      expected: [[ticketRef("7"), 1]],
    },
    {
      name: "a resolved signal holds nothing",
      arrange: ({ repository, refresh }) =>
        Effect.gen(function* () {
          yield* refresh(ACCOUNT_A, [ticket("done")], 1);
          yield* raiseSignal(ticketRef("done"), { resolved: true });
          return yield* summarize(repository);
        }),
      expected: [],
    },
    {
      name: "an API signal has no thread and joins nothing",
      arrange: ({ repository, refresh, sql }) =>
        Effect.gen(function* () {
          yield* refresh(ACCOUNT_A, [ticket("api")], 1);
          const id = yield* raiseSignal(ticketRef("api"));
          // An API signal stores a null thread ref.
          yield* sql`UPDATE signals SET thread_ref = NULL WHERE id = ${uuidFromString(id)}`;
          return yield* summarize(repository);
        }),
      expected: [],
    },
  ];

  for (const joinCase of cases) {
    it(joinCase.name, async () => {
      const found = await run((context) => joinCase.arrange(context));
      expect(found).toEqual(joinCase.expected);
    });
  }

  it("keeps an entity the sweep would delete while one signal is open, snoozed or not, and drops it after", async () => {
    const steps = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("old")], 1);
        const id = yield* raiseSignal(ticketRef("old"), { snoozeUntil: at(10 * 24 * 60) });
        const withSignal = yield* repository.pruneEntities(new Date(BASE + 60 * DAY).toISOString());
        yield* sql`UPDATE signals SET status = 'resolved',
          resolution = '{"kind":"decided","outcome":"x","actor":"user","origin":"web","at":"2026-03-02T00:00:00.000Z"}'
          WHERE id = ${uuidFromString(id)}`;
        const withoutSignal = yield* repository.pruneEntities(
          new Date(BASE + 60 * DAY).toISOString(),
        );
        return { withSignal, withoutSignal };
      }),
    );
    expect(steps.withSignal.entities).toBe(0);
    expect(steps.withoutSignal.entities).toBe(1);
  });

  it("reads the full records of work kinds for the Intake, and nothing else", async () => {
    const found = await run(({ repository, refresh, reconcile }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("a")], 1);
        yield* reconcile(ACCOUNT_A, [project], 1);
        yield* refresh(
          ACCOUNT_A,
          [
            {
              kind: TICKET_KIND,
              slots: { noun: "Ticket", pace: "context" },
              observation: { kind: "ticket", ref: ticketRef("partial"), title: "P", partial: true },
            },
          ],
          1,
        );
        return yield* repository.readSignalEntities([
          ticketRef("a"),
          PROJECT,
          ticketRef("partial"),
          ticketRef("unknown"),
        ]);
      }),
    );
    expect([...found.keys()]).toEqual([ticketRef("a")]);
    expect(found.get(ticketRef("a"))).toMatchObject({
      kind: TICKET_KIND,
      identifier: "T",
      title: "Ticket a",
    });
  });
});

describe("Inbox membership and arrivals", () => {
  it("brings a card in with an open signal and no concern, takes it out when the signal ends, and leaves the counts consistent", async () => {
    const steps = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("quiet")], 1);
        const before = yield* readInbox(repository, 3);
        const id = yield* raiseSignal(ticketRef("quiet"));
        const during = yield* readInbox(repository, 3);
        const counts = yield* readCounts(repository, 3);
        yield* sql`UPDATE signals SET status = 'resolved',
          resolution = '{"kind":"decided","outcome":"x","actor":"user","origin":"web","at":"2026-03-01T00:04:00.000Z"}'
          WHERE id = ${uuidFromString(id)}`;
        const after = yield* readInbox(repository, 5);
        return { before, during, counts, after };
      }),
    );
    expect(cardRefs(steps.before)).toEqual([]);
    expect(cardRefs(steps.during)).toEqual([ticketRef("quiet")]);
    expect(steps.during.total).toBe(1);
    expect(steps.counts.savedQueries.find((query) => query.id === "everything")!.count).toBe(1);
    expect(steps.counts.savedQueries.find((query) => query.id === "waits")!.count).toBe(1);
    expect(cardRefs(steps.after)).toEqual([]);
  });

  it("makes a card that a signal alone creates an arrival, and a card it lands on no second one", async () => {
    const steps = await run(({ repository, refresh, reconcile }) =>
      Effect.gen(function* () {
        // The signal came first: the refresh creates the entity and the card arrives.
        yield* raiseSignal(ticketRef("new"));
        yield* refresh(ACCOUNT_A, [ticket("new")], 3);
        const created = (yield* readCounts(repository, 3)).newestArrival;

        // An entity that was off the clock gains a signal.
        yield* refresh(ACCOUNT_A, [ticket("known")], 4);
        yield* repository.recordArrivalAfter(
          ticketRef("known"),
          at(5),
          ASKING_KINDS,
          raiseSignal(ticketRef("known")),
        );
        const raised = (yield* readCounts(repository, 5)).newestArrival;

        // A second signal, from a second Connection, on a card on the clock already.
        yield* repository.recordArrivalAfter(
          ticketRef("known"),
          at(6),
          ASKING_KINDS,
          raiseSignal(ticketRef("known"), { connectionId: ACCOUNT_B }),
        );
        const afterSecond = (yield* readCounts(repository, 6)).newestArrival;

        // A signal on a card that concerns the user already.
        yield* reconcile(ACCOUNT_A, [ticket("mine", { concerns: ["assigned"] })], 7);
        const mineArrival = (yield* readCounts(repository, 7)).newestArrival;
        yield* repository.recordArrivalAfter(
          ticketRef("mine"),
          at(8),
          ASKING_KINDS,
          raiseSignal(ticketRef("mine")),
        );
        const afterMine = (yield* readCounts(repository, 8)).newestArrival;

        // A ref with no entity does nothing.
        yield* repository.recordArrivalAfter(ticketRef("nobody"), at(9), ASKING_KINDS, Effect.void);
        return { created, raised, afterSecond, mineArrival, afterMine };
      }),
    );
    expect(steps.created).toBe(1);
    expect(steps.raised).toBe(2);
    expect(steps.afterSecond).toBe(2);
    // The card concerned the user already, but it begins to ask: that is a new arrival of "Someone waits on me".
    expect(steps.afterMine).toBeGreaterThan(steps.mineArrival);
  });

  it("records no second arrival when a concern joins a card that a live ask holds, and one when an ask joins a concerned card", async () => {
    const steps = await run(({ repository, refresh, reconcile }) =>
      Effect.gen(function* () {
        // Signal first: the signal brings the quiet card onto the clock, then the first concern comes.
        yield* refresh(ACCOUNT_A, [ticket("signal-first")], 1);
        yield* repository.recordArrivalAfter(
          ticketRef("signal-first"),
          at(2),
          ASKING_KINDS,
          raiseSignal(ticketRef("signal-first")),
        );
        const signalArrival = (yield* readCounts(repository, 2)).newestArrival;
        yield* reconcile(ACCOUNT_A, [ticket("signal-first", { concerns: ["assigned"] })], 3);
        const afterConcern = (yield* readCounts(repository, 3)).newestArrival;

        // Concern first: a later signal finds the card on the clock already.
        yield* reconcile(ACCOUNT_A, [ticket("concern-first", { concerns: ["assigned"] })], 4);
        const concernArrival = (yield* readCounts(repository, 4)).newestArrival;
        yield* repository.recordArrivalAfter(
          ticketRef("concern-first"),
          at(5),
          ASKING_KINDS,
          raiseSignal(ticketRef("concern-first")),
        );
        const afterSignal = (yield* readCounts(repository, 5)).newestArrival;
        return { signalArrival, afterConcern, concernArrival, afterSignal };
      }),
    );
    expect(steps.signalArrival).toBe(1);
    expect(steps.afterConcern).toBe(steps.signalArrival);
    // The concerned card is not in "Someone waits on me", so its arrival is not the newest there.
    expect(steps.concernArrival).toBe(steps.signalArrival);
    // A thing that only begins to ask later arrives in "Someone waits on me" then, not before.
    expect(steps.afterSignal).toBeGreaterThan(steps.concernArrival);
  });

  it("keeps a dismissed card off the Inbox for a signal that asks nothing, and brings it back as an arrival for an ask", async () => {
    const steps = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("hidden")], 1);
        const rows = yield* sql<{ readonly id: Uint8Array }>`
          SELECT id FROM external_entities WHERE ref = ${ticketRef("hidden")}`;
        yield* repository.dismiss([uuidToString(rows[0]!.id)], "user", at(2));
        yield* repository.recordArrivalAfter(
          ticketRef("hidden"),
          at(3),
          ASKING_KINDS,
          raiseSignal(ticketRef("hidden"), { kind: "acme-tracker/assigned", createdAt: at(3) }),
        );
        const quiet = yield* readInbox(repository, 4);
        const quietArrival = (yield* readCounts(repository, 4)).newestArrival;
        const open = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM signals WHERE status = 'open'`;
        const suggestions = yield* repository.listSuggestions({
          contextRef: undefined,
          limit: 10,
          now: at(4),
          askingKinds: ASKING_KINDS,
        });
        yield* repository.recordArrivalAfter(
          ticketRef("hidden"),
          at(5),
          ASKING_KINDS,
          raiseSignal(ticketRef("hidden"), { createdAt: at(5) }),
        );
        const back = yield* readInbox(repository, 6);
        const backArrival = (yield* readCounts(repository, 6)).newestArrival;
        return { quiet, quietArrival, open: open[0]!.n, suggestions, back, backArrival };
      }),
    );
    expect(cardRefs(steps.quiet)).toEqual([]);
    expect(steps.quietArrival).toBe(0);
    expect(steps.open).toBe(1);
    expect(steps.suggestions).toEqual([]);
    expect(cardRefs(steps.back)).toEqual([ticketRef("hidden")]);
    expect(steps.back.things[0]!.dismissedAt).toBe(at(2));
    expect(steps.backArrival).toBeGreaterThan(0);
  });

  it("brings a card held only by a snoozed signal back when the snooze ends, and writes nothing", async () => {
    const steps = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("later")], 1);
        yield* raiseSignal(ticketRef("later"), { snoozeUntil: at(60) });
        const changes = sql<{ readonly n: number }>`SELECT total_changes() AS n`;
        const written = (yield* changes)[0]!.n;
        const during = yield* readInbox(repository, 30);
        const duringCounts = yield* readCounts(repository, 30);
        const duringSuggestions = yield* repository.listSuggestions({
          contextRef: undefined,
          limit: 5,
          now: at(30),
          askingKinds: ASKING_KINDS,
        });
        const atEnd = yield* readInbox(repository, 60);
        const afterEnd = yield* readInbox(repository, 61);
        const afterSuggestions = yield* repository.listSuggestions({
          contextRef: undefined,
          limit: 5,
          now: at(61),
          askingKinds: ASKING_KINDS,
        });
        return {
          during,
          duringCounts,
          duringSuggestions,
          atEnd,
          afterEnd,
          afterSuggestions,
          writes: (yield* changes)[0]!.n - written,
        };
      }),
    );
    expect(cardRefs(steps.during)).toEqual([]);
    expect(steps.duringCounts.savedQueries.find((query) => query.id === "everything")!.count).toBe(
      0,
    );
    expect(steps.duringSuggestions).toEqual([]);
    // The snooze ran out at `until`, so a read at that minute sees the card.
    expect(cardRefs(steps.atEnd)).toEqual([ticketRef("later")]);
    expect(steps.afterEnd.things[0]!.askCount).toBe(1);
    expect(steps.afterSuggestions.map((row) => row.ref)).toEqual([ticketRef("later")]);
    expect(steps.writes).toBe(0);
  });

  it("counts only signals that are not snoozed on the card, and all open ones in the detail", async () => {
    const steps = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("two")], 1);
        yield* raiseSignal(ticketRef("two"), { createdAt: at(2), title: "First" });
        yield* raiseSignal(ticketRef("two"), {
          createdAt: at(3),
          title: "Snoozed newest",
          snoozeUntil: at(99),
        });
        const inbox = yield* readInbox(repository, 5);
        const detail = yield* readDetail(repository, sql, ticketRef("two"), 5);
        return { inbox, detail };
      }),
    );
    expect(steps.inbox.things[0]!).toMatchObject({
      askCount: 1,
      asks: [{ say: { say: "First" } }],
      openKinds: ["acme-tracker/mentioned"],
    });
    expect(steps.detail.openCount).toBe(2);
    expect(steps.detail.signals.map((line) => [line.title, line.snoozed])).toEqual([
      ["First", false],
      ["Snoozed newest", true],
    ]);
  });

  it("lists the distinct kinds of all the open signals on a card, snoozed ones too and resolved ones never", async () => {
    const inbox = await run(({ repository, refresh, reconcile }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("two")], 1);
        yield* reconcile(ACCOUNT_A, [ticket("three", { concerns: ["assigned"] })], 1);
        yield* raiseSignal(ticketRef("two"), { kind: "acme-tracker/mentioned" });
        yield* raiseSignal(ticketRef("two"), { kind: "acme-tracker/mentioned", createdAt: at(3) });
        yield* raiseSignal(ticketRef("two"), {
          kind: "acme-tracker/assigned",
          snoozeUntil: at(99),
        });
        yield* raiseSignal(ticketRef("two"), { kind: "acme-tracker/closed", resolved: true });
        return yield* readInbox(repository, 5);
      }),
    );
    const kindsOf = (name: string) =>
      inbox.things.find((card) => card.ref === ticketRef(name))!.openKinds;
    expect(kindsOf("two")).toEqual(["acme-tracker/assigned", "acme-tracker/mentioned"]);
    expect(kindsOf("three")).toEqual([]);
  });

  it("cuts the open kinds of a card to the bound, keeping the first ones in order", async () => {
    const inbox = await run(({ repository, refresh }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("two")], 1);
        for (let index = MAX_ENTITY_SIGNALS + 5; index > 0; index--) {
          yield* raiseSignal(ticketRef("two"), {
            kind: `acme-tracker/kind-${String(index).padStart(3, "0")}`,
          });
        }
        return yield* readInbox(repository, 5);
      }),
    );
    const kinds = inbox.things[0]!.openKinds;
    expect(kinds).toHaveLength(MAX_ENTITY_SIGNALS);
    expect(kinds[0]).toBe("acme-tracker/kind-001");
    expect(kinds.at(-1)).toBe(`acme-tracker/kind-0${String(MAX_ENTITY_SIGNALS)}`);
  });

  it("picks the latest signal by creation time, then id", async () => {
    const latest = await run(({ repository, refresh }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("order")], 1);
        yield* raiseSignal(ticketRef("order"), { createdAt: at(5), title: "Older id, same time" });
        const newer = yield* raiseSignal(ticketRef("order"), {
          createdAt: at(5),
          title: "Newer id, same time",
        });
        yield* raiseSignal(ticketRef("order"), { createdAt: at(4), title: "Earlier" });
        const inbox = yield* readInbox(repository, 6);
        return { line: inbox.things[0]!.asks[0], newer };
      }),
    );
    expect(latest.line?.id).toBe(latest.newer);
  });

  it("sends the same number of statements for 3 cards with signals as for 40", async () => {
    const countStatements = (cards: number) =>
      run(({ repository, refresh }) =>
        Effect.gen(function* () {
          for (let index = 0; index < cards; index++) {
            yield* refresh(ACCOUNT_A, [ticket(`c${index}`)], 1);
            yield* raiseSignal(ticketRef(`c${index}`));
            yield* raiseSignal(ticketRef(`c${index}`));
          }
          const statements: Array<string> = [];
          const inbox = yield* readInbox(repository, 3).pipe(
            Effect.provideService(Statement.CurrentTransformer, (statement) =>
              Effect.sync(() => {
                statements.push(statement.compile()[0]);
                return statement;
              }),
            ),
          );
          return { statements, inbox };
        }),
      );
    const small = await countStatements(3);
    const large = await countStatements(40);
    expect(large.inbox.things.every((card) => card.askCount === 2)).toBe(true);
    expect(large.statements).toHaveLength(small.statements.length);
  });
});

describe("how the signal reads use the database", () => {
  it("reads signals through an index for the Inbox, the detail, its counts and an arrival, never scanning the table", async () => {
    const plans = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("indexed")], 1);
        yield* raiseSignal(ticketRef("indexed"));
        yield* raiseSignal(ticketRef("indexed"), { resolved: true });
        const captured: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* Effect.all([
          readInbox(repository, 3),
          readCounts(repository, 3),
          readDetail(repository, sql, ticketRef("indexed"), 3),
          repository.recordArrivalAfter(ticketRef("indexed"), at(3), ASKING_KINDS, Effect.void),
        ]).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              const [text, params] = statement.compile();
              if (/FROM signals s/.test(text)) captured.push([text, params]);
              return statement;
            }),
          ),
        );
        const plans: Array<string> = [];
        for (const [text, params] of captured) {
          const rows = yield* sql.unsafe<{ readonly detail: string }>(
            `EXPLAIN QUERY PLAN ${text}`,
            params,
          );
          plans.push(rows.map((row) => row.detail).join("\n"));
        }
        return plans;
      }),
    );
    // The detail seeks by thread ref. The Inbox membership (read by the page, the counts and the
    // arrival) reads each open signal once through the index of open signals.
    expect(plans.length).toBeGreaterThanOrEqual(3);
    for (const plan of plans) {
      expect(plan).toMatch(/(SEARCH|SCAN) s USING (COVERING )?INDEX signals_(thread_ref|open)/);
      expect(plan).not.toMatch(/SCAN s(\n|$)/);
    }
  });
});

describe("the sentence of an ask and the lines of a detail", () => {
  const sentences = (repository: Repository, sql: SqlClient.SqlClient, ref: string) =>
    Effect.gen(function* () {
      const inbox = yield* readInbox(repository, 10);
      const detail = yield* readDetail(repository, sql, ref, 10);
      const thing = inbox.things.find((candidate) => candidate.ref === ref)!;
      return {
        asks: thing.asks.map((ask) => ask.say),
        lines: detail.signals.map((line) => line.say),
      };
    });

  it("fills the kind's words for the signal with the asker, on the ask and on every line", async () => {
    const found = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("words")], 1);
        yield* raiseSignal(ticketRef("words"), { asker: "Marta", createdAt: at(2) });
        return yield* sentences(repository, sql, ticketRef("words"));
      }),
    );
    const expected = { say: "Marta mentioned you", tone: "attention" };
    expect(found.asks).toEqual([expected]);
    expect(found.lines).toEqual([expected]);
  });

  it("falls back to the title when the words are missing, need a person the signal lacks, or the kind is a core kind", async () => {
    const found = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("fallback")], 1);
        yield* raiseSignal(ticketRef("fallback"), { createdAt: at(2), title: "No person" });
        yield* raiseSignal(ticketRef("fallback"), {
          createdAt: at(3),
          kind: "acme-tracker/unlisted",
          title: "No words",
          asker: "Marta",
        });
        yield* raiseSignal(ticketRef("fallback"), {
          createdAt: at(4),
          kind: "fyi",
          title: "A core note",
        });
        return yield* sentences(repository, sql, ticketRef("fallback"));
      }),
    );
    expect(found.lines).toEqual([
      { say: "No person", tone: "plain" },
      { say: "No words", tone: "plain" },
      { say: "A core note", tone: "plain" },
    ]);
    // The core note asks nothing, so it is a line of the detail and no ask.
    expect(found.asks).toEqual([
      { say: "No words", tone: "plain" },
      { say: "No person", tone: "plain" },
    ]);
  });

  it("cuts a long title at a word to the length a sentence allows", async () => {
    const found = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("long")], 1);
        yield* raiseSignal(ticketRef("long"), {
          kind: "acme-tracker/unlisted",
          title: `${"word ".repeat(100)}end`,
        });
        return yield* sentences(repository, sql, ticketRef("long"));
      }),
    );
    expect(found.asks[0]!.say.length).toBeLessThanOrEqual(200);
    expect(found.asks[0]!.say.endsWith("word…")).toBe(true);
  });
});

describe("what the detail selects", () => {
  const raiseMany = (ref: string, count: number, options: (index: number) => SignalOptions) =>
    Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) => raiseSignal(ref, options(index)),
    );

  it("keeps the newest 50 open signals across two Connections, and counts the rest", async () => {
    const detail = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("busy")], 1);
        yield* raiseMany(ticketRef("busy"), 60, (index) => ({
          createdAt: at(10 + index),
          connectionId: index % 2 === 0 ? ACCOUNT_A : ACCOUNT_B,
          title: `Signal ${index}`,
        }));
        return yield* readDetail(repository, sql, ticketRef("busy"), 100);
      }),
    );
    expect(detail.signals).toHaveLength(50);
    expect(detail.openCount).toBe(60);
    expect(detail.signalCount).toBe(60);
    // The ten oldest are left out, and the rest is in time order.
    expect(detail.signals[0]!.title).toBe("Signal 10");
    expect(detail.signals[49]!.title).toBe("Signal 59");
  });

  it("lets open signals push resolved ones out, and returns what it selected oldest first", async () => {
    const detail = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("mixed")], 1);
        yield* raiseMany(ticketRef("mixed"), 60, (index) => ({
          createdAt: at(10 + index),
          resolved: true,
          title: `Resolved ${index}`,
        }));
        // Open signals sit between the resolved ones in time.
        yield* raiseMany(ticketRef("mixed"), 3, (index) => ({
          createdAt: at(20 + index * 10),
          title: `Open ${index}`,
        }));
        return yield* readDetail(repository, sql, ticketRef("mixed"), 100);
      }),
    );
    expect(detail.signals).toHaveLength(50);
    expect(detail.openCount).toBe(3);
    expect(detail.signalCount).toBe(63);
    const titles = detail.signals.map((line) => line.title);
    expect(titles.filter((title) => title.startsWith("Open"))).toEqual([
      "Open 0",
      "Open 1",
      "Open 2",
    ]);
    // 47 resolved ones fill the room: the newest 47, Resolved 13 to Resolved 59.
    expect(titles.filter((title) => title.startsWith("Resolved"))).toHaveLength(47);
    expect(titles).toContain("Resolved 59");
    expect(titles).not.toContain("Resolved 12");
    const times = detail.signals.map((line) => line.createdAt);
    expect(times).toEqual([...times].sort());
    expect(detail.signals.find((line) => line.title === "Resolved 59")).toMatchObject({
      status: "resolved",
      outcome: "Marked done",
      snoozed: false,
    });
  });

  it("returns no lines and zero counts for a thing with no signals", async () => {
    const detail = await run(({ repository, refresh, sql }) =>
      Effect.gen(function* () {
        yield* refresh(ACCOUNT_A, [ticket("empty", { concerns: ["assigned"] })], 1);
        return yield* readDetail(repository, sql, ticketRef("empty"), 2);
      }),
    );
    expect(detail).toMatchObject({ signals: [], openCount: 0, signalCount: 0 });
  });
});

describe("what a signal keeps wanted", () => {
  const wanted = (
    repository: Repository,
    connectionId: string,
    minutes: number,
    prefix: string,
    includesSignalRefs: boolean,
  ) =>
    repository.listWanted({
      connectionId,
      refPrefix: prefix,
      includesSignalRefs,
      limit: 50,
      now: at(minutes),
    });

  it("lists the open signals of a work kind that have no entity, for the Connection they came through, snoozed ones too", async () => {
    const found = await run(({ repository }) =>
      Effect.gen(function* () {
        yield* raiseSignal(ticketRef("mention"));
        yield* raiseSignal(ticketRef("snoozed"), { snoozeUntil: at(500) });
        yield* raiseSignal(ticketRef("resolved"), { resolved: true });
        yield* raiseSignal(ticketRef("theirs"), { connectionId: ACCOUNT_B });
        yield* raiseSignal(epicRef("elsewhere"));
        return {
          a: yield* wanted(repository, ACCOUNT_A, 5, TICKET_PREFIX, true),
          b: yield* wanted(repository, ACCOUNT_B, 5, TICKET_PREFIX, true),
          withoutSignals: yield* wanted(repository, ACCOUNT_A, 5, TICKET_PREFIX, false),
        };
      }),
    );
    expect(found.a).toEqual([ticketRef("mention"), ticketRef("snoozed")]);
    expect(found.b).toEqual([ticketRef("theirs")]);
    expect(found.withoutSignals).toEqual([]);
  });

  it("does not offer a signal on a place, and keeps asking for a ref that failed only after its backoff", async () => {
    const found = await run(({ repository }) =>
      Effect.gen(function* () {
        yield* raiseSignal(PROJECT);
        yield* raiseSignal(ticketRef("flaky"));
        const place = yield* wanted(repository, ACCOUNT_A, 5, "acme-tracker:project:", false);
        const first = yield* wanted(repository, ACCOUNT_A, 5, TICKET_PREFIX, true);
        yield* repository.reportMissing({
          connectionId: ACCOUNT_A,
          ref: ticketRef("flaky"),
          reason: "inaccessible",
          environment: environment(5),
        });
        const backingOff = yield* wanted(repository, ACCOUNT_A, 6, TICKET_PREFIX, true);
        const later = yield* wanted(repository, ACCOUNT_A, 8, TICKET_PREFIX, true);
        return { place, first, backingOff, later };
      }),
    );
    expect(found).toEqual({
      place: [],
      first: [ticketRef("flaky")],
      backingOff: [],
      later: [ticketRef("flaky")],
    });
  });

  it("creates the entity with no concern on refresh, never touches another Connection's concerns, and lets it go when the signal ends", async () => {
    const steps = await run(({ repository, reconcile, refresh, sql }) =>
      Effect.gen(function* () {
        // Another Connection already says this ticket concerns the user.
        yield* reconcile(ACCOUNT_B, [ticket("shared", { concerns: ["assigned"] })], 1);
        const id = yield* raiseSignal(ticketRef("shared"), { connectionId: ACCOUNT_A });
        yield* refresh(ACCOUNT_A, [ticket("shared")], 3);
        const concerns = yield* sql<{
          readonly connection_id: Uint8Array;
          readonly concerns: string;
        }>`
          SELECT connection_id, concerns FROM external_entity_observations
          WHERE ref = ${ticketRef("shared")} ORDER BY concerns`;

        // A mention of a thing nobody lists: the refresh creates it, with no concern.
        const mention = yield* raiseSignal(ticketRef("mention"));
        yield* refresh(ACCOUNT_A, [ticket("mention")], 4);
        const withSignal = cardRefs(yield* readInbox(repository, 5));
        yield* sql`UPDATE signals SET status = 'resolved',
          resolution = '{"kind":"decided","outcome":"x","actor":"user","origin":"web","at":"2026-03-01T00:06:00.000Z"}'
          WHERE id = ${uuidFromString(mention)}`;
        const withoutSignal = cardRefs(yield* readInbox(repository, 7));
        void id;
        return { concerns, withSignal, withoutSignal };
      }),
    );
    expect(steps.concerns.map((row) => row.concerns)).toEqual(['["assigned"]', "[]"]);
    expect([...steps.withSignal].sort()).toEqual([ticketRef("mention"), ticketRef("shared")]);
    expect(steps.withoutSignal).toEqual([ticketRef("shared")]);
  });

  it("keeps the observation of a ref a signal waits on when the sweep runs", async () => {
    const kept = await run(({ repository, sql }) =>
      Effect.gen(function* () {
        yield* raiseSignal(ticketRef("waiting"));
        yield* wanted(repository, ACCOUNT_A, 5, TICKET_PREFIX, true);
        yield* repository.reportMissing({
          connectionId: ACCOUNT_A,
          ref: ticketRef("waiting"),
          reason: "inaccessible",
          environment: environment(5),
        });
        const result = yield* repository.pruneEntities(new Date(BASE + 60 * DAY).toISOString());
        const rows = yield* sql<{ readonly attempt_count: number }>`
          SELECT attempt_count FROM external_entity_observations WHERE ref = ${ticketRef("waiting")}`;
        return { result, attempts: rows.map((row) => row.attempt_count) };
      }),
    );
    expect(kept.result.observations).toBe(0);
    expect(kept.attempts).toEqual([1]);
  });

  it("wants the ancestors of a thing a signal holds, so its card can show where it lives", async () => {
    const found = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(
          ACCOUNT_B,
          [
            ticket("held", {
              relations: { complete: true, partOf: [PROJECT], linked: [] },
            }),
          ],
          1,
        );
        yield* raiseSignal(ticketRef("held"));
        void sql;
        return yield* wanted(repository, ACCOUNT_A, 5, "acme-tracker:project:", false);
      }),
    );
    expect(found).toEqual([PROJECT]);
  });
});

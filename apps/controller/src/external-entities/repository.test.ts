/**
 * Tests the External Entities repository against a migrated database, with an
 * invented tracker plugin: tickets (a compact, fast kind), epics (a rich, slow
 * kind) and projects (a place with no card).
 *
 * - what a reconcile stores: first sight, several Connections, which one wins
 *   the shared fields, partial records, access, a deleted Connection
 * - the Inbox: counts, the arrival counter, dismissal, places and context
 * - what a Connection is asked to read (`listWanted`), and failed reads
 * - the sweep that prunes
 *
 * Every body runs in one transaction on a fresh database, as the service runs
 * the repository. Each step passes its own minute, so the time is exact.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { MAX_INBOX_CARDS } from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { taskRepository } from "../tasks";
import { externalEntityRepository, type ObservedEntity } from "./repository";
import type { EntitySlots, FullEntityObservation } from "./slots";

type Repository = Effect.Success<typeof externalEntityRepository>;

const BASE = Date.parse("2026-03-01T00:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Returns the instant `minutes` after the start of the test, as the ISO string the database stores. */
const at = (minutes: number): string => new Date(BASE + minutes * MINUTE).toISOString();
const atDay = (days: number): string => new Date(BASE + days * DAY).toISOString();

const PLUGIN = "acme-tracker";
const COPY_PLUGIN = "acme-tracker-copy";
const TICKET_KIND = "acme-tracker/ticket";
const EPIC_KIND = "acme-tracker/epic";
const PROJECT_KIND = "acme-tracker/project";
const TICKET_PREFIX = "acme-tracker:ticket:";

const ACCOUNT_A = "0190c000-0000-7000-8000-0000000000a1";
const ACCOUNT_B = "0190c000-0000-7000-8000-0000000000a2";
const COPY_ACCOUNT = "0190c000-0000-7000-8000-0000000000a3";

const ticketRef = (name: string) => `${TICKET_PREFIX}${name}`;
const epicRef = (name: string) => `acme-tracker:epic:${name}`;
const PROJECT = "acme-tracker:project:harbour";

const TICKET_SLOTS = (name: string): EntitySlots => ({
  noun: "Ticket",
  card: "compact",
  pace: "fast",
  patience: 24,
  identifier: name.toUpperCase(),
  facts: [],
});
const EPIC_SLOTS: EntitySlots = {
  noun: "Epic",
  card: "rich",
  pace: "slow",
  patience: 336,
  identifier: "EPIC",
  facts: [],
};
const PROJECT_SLOTS: EntitySlots = { noun: "Project", pace: "context", caption: "Tracker project" };

interface ObservationOptions extends Partial<Omit<FullEntityObservation, "kind" | "ref">> {
  readonly slots?: EntitySlots;
}

/** Builds the observation of a ticket: compact, fast, concerning the user unless told otherwise. */
const ticket = (name: string, options: ObservationOptions = {}): ObservedEntity => {
  const { slots, ...rest } = options;
  return {
    kind: TICKET_KIND,
    slots: slots ?? TICKET_SLOTS(name),
    observation: {
      kind: "ticket",
      ref: ticketRef(name),
      title: `Ticket ${name}`,
      url: `https://tracker.example/${name}`,
      lifecycle: "open",
      fields: {},
      concerns: ["assigned"],
      sourceUpdatedAt: at(1),
      ...rest,
    },
  };
};

/** Builds the observation of an epic: rich, slow. */
const epic = (name: string, options: Partial<FullEntityObservation> = {}): ObservedEntity => ({
  kind: EPIC_KIND,
  slots: EPIC_SLOTS,
  observation: {
    kind: "epic",
    ref: epicRef(name),
    title: `Epic ${name}`,
    url: `https://tracker.example/epic/${name}`,
    lifecycle: "open",
    fields: {},
    concerns: ["assigned"],
    sourceUpdatedAt: at(1),
    ...options,
  },
});

/** Builds the observation of the project: a place with no concern. */
const project = (options: Partial<FullEntityObservation> = {}): ObservedEntity => ({
  kind: PROJECT_KIND,
  slots: PROJECT_SLOTS,
  observation: {
    kind: "project",
    ref: PROJECT,
    title: "Harbour",
    fields: {},
    concerns: [],
    sourceUpdatedAt: at(1),
    ...options,
  },
});

/** Builds a partial observation of a ticket: only its kind, ref and title. */
const partialTicket = (name: string, title: string): ObservedEntity => ({
  kind: TICKET_KIND,
  slots: { noun: "Ticket", pace: "context" },
  observation: { kind: "ticket", ref: ticketRef(name), title, partial: true },
});

const environment = (
  minutes: number,
  activePluginIds: ReadonlyArray<string> = [PLUGIN, COPY_PLUGIN],
) => ({
  now: at(minutes),
  activePluginIds,
});

/** Runs `body` on a fresh migrated database with three Connections, in one transaction. */
const run = <A>(
  body: (context: {
    readonly repository: Repository;
    readonly sql: SqlClient.SqlClient;
    readonly reconcile: (
      connectionId: string,
      observed: ReadonlyArray<ObservedEntity>,
      options: { readonly minutes: number; readonly complete?: boolean; readonly kind?: string },
    ) => ReturnType<Repository["reconcile"]>;
  }) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const plugin of [PLUGIN, COPY_PLUGIN]) {
        yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
          VALUES (${plugin}, 1, '{}', ${at(0)}, ${at(0)})`;
      }
      for (const [id, plugin, name] of [
        [ACCOUNT_A, PLUGIN, "a"],
        [ACCOUNT_B, PLUGIN, "b"],
        [COPY_ACCOUNT, COPY_PLUGIN, "copy"],
      ] as const) {
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (${uuidFromString(id)}, ${plugin}, ${`${plugin}/account`}, ${name}, ${name},
            ${name}, 'connected', '[]', '{}', ${at(0)}, ${at(0)})`;
      }
      const repository = yield* externalEntityRepository;
      const reconcile = (
        connectionId: string,
        observed: ReadonlyArray<ObservedEntity>,
        options: { readonly minutes: number; readonly complete?: boolean; readonly kind?: string },
      ) =>
        repository.reconcile({
          connectionId,
          kind: options.kind ?? TICKET_KIND,
          complete: options.complete ?? true,
          observed,
          actor: `plugin:${PLUGIN}`,
          environment: environment(options.minutes),
        });
      return yield* body({ repository, sql, reconcile });
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

const readInbox = (repository: Repository, minutes: number) =>
  repository.queryInbox(environment(minutes));

const cardRefs = (inbox: { readonly cards: ReadonlyArray<{ readonly ref: string }> }) =>
  inbox.cards.map((card) => card.ref);

const countRows = (sql: SqlClient.SqlClient, table: string) =>
  Effect.map(
    sql.unsafe<{ readonly n: number }>(`SELECT count(*) AS n FROM ${table}`),
    (rows) => rows[0]!.n,
  );

/** Reads every row that a poll could write, to see that an unchanged poll leaves them as they were. */
const snapshotRows = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const entities = yield* sql`SELECT * FROM external_entities ORDER BY ref`;
    const observations =
      yield* sql`SELECT * FROM external_entity_observations ORDER BY ref, connection_id`;
    const claims = yield* sql`SELECT * FROM external_entity_relation_claims ORDER BY id`;
    return { entities, observations, claims };
  });

const readConnectionWarning = (sql: SqlClient.SqlClient, connectionId: string) =>
  Effect.map(
    sql<{ readonly warning: string | null }>`
      SELECT warning FROM connections WHERE id = ${uuidFromString(connectionId)}`,
    (rows) => rows[0]!.warning,
  );

const linkTaskToRef = (ref: string, minutes: number, stage: "planned" | "done" = "planned") =>
  Effect.gen(function* () {
    const tasks = yield* taskRepository;
    return yield* tasks.insert({
      title: `Work on ${ref}`,
      description: "",
      status: stage === "done" ? "done" : "open",
      stage,
      priority: "normal",
      labels: [],
      projectId: undefined,
      provenance: [{ ref }],
      at: at(minutes),
      actor: "user",
    });
  });

describe("reconcile: first sight and several Connections", () => {
  it("stores a thing seen for the first time as a card, with its first arrival number", async () => {
    const { changes, inbox } = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const changes = yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 5 });
        return { changes, inbox: yield* readInbox(repository, 6) };
      }),
    );
    expect(changes.changedRefs).toEqual([ticketRef("t1")]);
    expect(inbox.cards).toHaveLength(1);
    expect(inbox.cards[0]).toMatchObject({
      ref: ticketRef("t1"),
      concerns: ["assigned"],
      side: "requests",
      access: "ok",
      stale: false,
      firstObservedAt: at(5),
      waitingSince: at(5),
    });
    expect(inbox.counts).toEqual({
      onTheClock: 1,
      requests: 1,
      withSomeoneElse: 0,
      newestArrival: 1,
    });
  });

  it("keeps a thing listed while another Connection still lists it, and off the Inbox once none does", async () => {
    const steps = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1", { concerns: ["assigned"] })], { minutes: 1 });
        yield* reconcile(ACCOUNT_B, [ticket("t1", { concerns: ["review-requested"] })], {
          minutes: 2,
        });
        const both = yield* readInbox(repository, 3);
        yield* reconcile(ACCOUNT_A, [], { minutes: 4 });
        const onlyB = yield* readInbox(repository, 5);
        yield* reconcile(ACCOUNT_B, [], { minutes: 6 });
        const none = yield* readInbox(repository, 7);
        const standings = yield* repository.readStandings([ticketRef("t1")]);
        return { both, onlyB, none, standings };
      }),
    );
    expect(steps.both.cards[0]!.concerns).toEqual(["assigned", "review-requested"]);
    expect(steps.onlyB.cards[0]!.concerns).toEqual(["review-requested"]);
    expect(steps.none.cards).toEqual([]);
    // The row stays: an empty scan empties concerns and removes nothing.
    expect(steps.standings.get(ticketRef("t1"))).toEqual({ standing: "known", taskId: undefined });
  });

  it("removes nothing on an incomplete read, says so on the Connection, and clears its own warning later", async () => {
    const steps = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1"), ticket("t2")], { minutes: 1 });
        const partial = yield* reconcile(ACCOUNT_A, [ticket("t1")], {
          minutes: 2,
          complete: false,
        });
        const afterPartial = yield* readInbox(repository, 3);
        const warning = yield* readConnectionWarning(sql, ACCOUNT_A);
        const whole = yield* reconcile(ACCOUNT_A, [ticket("t1"), ticket("t2")], { minutes: 4 });
        return {
          partial,
          afterPartial,
          warning,
          whole,
          cleared: yield* readConnectionWarning(sql, ACCOUNT_A),
        };
      }),
    );
    expect(cardRefs(steps.afterPartial)).toEqual([ticketRef("t1"), ticketRef("t2")]);
    expect(steps.partial.warning).toContain("The Inbox may be missing items");
    expect(steps.warning).toBe(steps.partial.warning);
    expect(steps.whole.warning).toBeUndefined();
    expect(steps.cleared).toBeNull();
  });

  it("never overwrites or clears the warning that account setup wrote", async () => {
    const warnings = await run(({ reconcile, sql }) =>
      Effect.gen(function* () {
        yield* sql`UPDATE connections SET warning = 'The token expires soon'
          WHERE id = ${uuidFromString(ACCOUNT_A)}`;
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 1, complete: false });
        const afterIncomplete = yield* readConnectionWarning(sql, ACCOUNT_A);
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 2 });
        return { afterIncomplete, afterComplete: yield* readConnectionWarning(sql, ACCOUNT_A) };
      }),
    );
    expect(warnings).toEqual({
      afterIncomplete: "The token expires soon",
      afterComplete: "The token expires soon",
    });
  });

  it("records a loop as a conflict, applies the rest, and warns once the read is complete", async () => {
    const steps = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        const changes = yield* reconcile(
          ACCOUNT_A,
          [
            epic("a", { relations: { complete: true, partOf: [epicRef("b")], linked: [] } }),
            epic("b", { relations: { complete: true, partOf: [epicRef("a")], linked: [] } }),
          ],
          { minutes: 1, kind: EPIC_KIND },
        );
        return {
          changes,
          warning: yield* readConnectionWarning(sql, ACCOUNT_A),
          inbox: yield* readInbox(repository, 2),
        };
      }),
    );
    expect(steps.changes.conflicts).toHaveLength(1);
    expect(steps.changes.relationChangedRefs).toEqual([epicRef("a"), epicRef("b")]);
    expect(steps.warning).toContain("part of itself");
    expect(cardRefs(steps.inbox)).toEqual([epicRef("a"), epicRef("b")]);
  });
});

describe("reconcile: which Connection wins the shared fields", () => {
  /** Reports a ticket from account A at minute 5 as the presenter, then lets `report` try to change it. */
  const titleAfter = (
    report: (
      context: Parameters<Parameters<typeof run>[0]>[0],
    ) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
  ) =>
    run((context) =>
      Effect.gen(function* () {
        yield* context.reconcile(
          ACCOUNT_A,
          [ticket("t1", { title: "First", sourceUpdatedAt: at(5) })],
          { minutes: 6 },
        );
        yield* report(context);
        const inbox = yield* readInbox(context.repository, 30);
        return inbox.cards[0]!.title;
      }),
    );

  it.each([
    {
      name: "an older observation from another Connection",
      account: ACCOUNT_B,
      time: 4,
      revision: undefined,
      expected: "First",
    },
    {
      name: "a newer observation from another Connection",
      account: ACCOUNT_B,
      time: 6,
      revision: undefined,
      expected: "Second",
    },
    {
      name: "an equal time from the Connection that wrote last",
      account: ACCOUNT_A,
      time: 5,
      revision: undefined,
      expected: "Second",
    },
    {
      name: "an equal time from another Connection while the writer is healthy",
      account: ACCOUNT_B,
      time: 5,
      revision: undefined,
      expected: "First",
    },
  ])("$name gives the title $expected", async ({ account, time, expected }) => {
    const title = await titleAfter(({ reconcile }) =>
      reconcile(account, [ticket("t1", { title: "Second", sourceUpdatedAt: at(time) })], {
        minutes: 10,
      }),
    );
    expect(title).toBe(expected);
  });

  it.each([
    { name: "an equal time and the same revision", time: 5, revision: "r1", expected: "First" },
    { name: "an equal time and a new revision", time: 5, revision: "r2", expected: "Second" },
    { name: "a newer time and the same revision", time: 6, revision: "r1", expected: "Second" },
  ])(
    "a revision from the writer: $name gives the title $expected",
    async ({ time, revision, expected }) => {
      const title = await run((context) =>
        Effect.gen(function* () {
          yield* context.reconcile(
            ACCOUNT_A,
            [ticket("t1", { title: "First", sourceUpdatedAt: at(5), sourceRevision: "r1" })],
            { minutes: 6 },
          );
          yield* context.reconcile(
            ACCOUNT_A,
            [
              ticket("t1", {
                title: "Second",
                sourceUpdatedAt: at(time),
                sourceRevision: revision,
              }),
            ],
            { minutes: 10 },
          );
          return (yield* readInbox(context.repository, 30)).cards[0]!.title;
        }),
      );
      expect(title).toBe(expected);
    },
  );

  it.each([
    {
      name: "the writer's Connection was deleted",
      breakWriter: (sql: SqlClient.SqlClient) =>
        sql`DELETE FROM connections WHERE id = ${uuidFromString(ACCOUNT_A)}`,
      reporter: ACCOUNT_B,
      active: [PLUGIN, COPY_PLUGIN],
    },
    {
      name: "the writer's Connection was disabled",
      breakWriter: (sql: SqlClient.SqlClient) =>
        sql`UPDATE connections SET status = 'disabled' WHERE id = ${uuidFromString(ACCOUNT_A)}`,
      reporter: ACCOUNT_B,
      active: [PLUGIN, COPY_PLUGIN],
    },
    {
      name: "the writer's plugin is not active",
      breakWriter: () => Effect.void,
      reporter: COPY_ACCOUNT,
      active: [COPY_PLUGIN],
    },
  ])("another Connection takes over when $name", async ({ breakWriter, reporter, active }) => {
    const title = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1", { title: "First", sourceUpdatedAt: at(5) })], {
          minutes: 6,
        });
        yield* breakWriter(sql);
        yield* repository.reconcile({
          connectionId: reporter,
          kind: TICKET_KIND,
          complete: true,
          observed: [ticket("t1", { title: "Second", sourceUpdatedAt: at(5) })],
          actor: `plugin:${PLUGIN}`,
          environment: environment(10, active),
        });
        return (yield* readInbox(repository, 30)).cards[0]!.title;
      }),
    );
    expect(title).toBe("Second");
  });

  it("another Connection takes over when the writer lost access to the thing", async () => {
    const title = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1", { title: "First", sourceUpdatedAt: at(5) })], {
          minutes: 6,
        });
        yield* repository.reportMissing({
          connectionId: ACCOUNT_A,
          ref: ticketRef("t1"),
          reason: "inaccessible",
          environment: environment(7),
        });
        yield* reconcile(ACCOUNT_B, [ticket("t1", { title: "Second", sourceUpdatedAt: at(5) })], {
          minutes: 10,
        });
        return (yield* readInbox(repository, 30)).cards[0]!.title;
      }),
    );
    expect(title).toBe("Second");
  });

  it("rejects an inventory that names a ref twice, before writing anything", async () => {
    const outcome = await run(({ reconcile, sql }) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          reconcile(ACCOUNT_A, [ticket("t1"), ticket("t1")], { minutes: 1 }),
        );
        return { failure, entities: yield* countRows(sql, "external_entities") };
      }),
    );
    expect(outcome.failure._tag).toBe("InvalidInventory");
    expect(outcome.entities).toBe(0);
  });
});

describe("reconcile: writing only what changed", () => {
  it("writes nothing but the scan row when the same inventory comes again", async () => {
    const outcome = await run(({ reconcile, sql }) =>
      Effect.gen(function* () {
        const observed = [ticket("t1"), ticket("t2", { concerns: ["opened"], ownedByYou: true })];
        yield* reconcile(ACCOUNT_A, observed, { minutes: 1 });
        const before = yield* snapshotRows(sql);
        const scanBefore = yield* sql`SELECT last_complete_at FROM external_entity_scans`;
        const changes = yield* reconcile(ACCOUNT_A, observed, { minutes: 9 });
        return {
          changes,
          before,
          after: yield* snapshotRows(sql),
          scanBefore,
          scanAfter: yield* sql`SELECT last_complete_at FROM external_entity_scans`,
        };
      }),
    );
    expect(outcome.after).toEqual(outcome.before);
    expect(outcome.changes.changedRefs).toEqual([]);
    expect(outcome.changes.affectedTaskIds).toEqual([]);
    expect(outcome.scanBefore).toEqual([{ last_complete_at: at(1) }]);
    expect(outcome.scanAfter).toEqual([{ last_complete_at: at(9) }]);
  });

  it("changes what a card shows when its facts change, and reports the ref", async () => {
    const outcome = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1", { sourceUpdatedAt: at(1) })], { minutes: 1 });
        const changes = yield* reconcile(
          ACCOUNT_A,
          [ticket("t1", { title: "Renamed", sourceUpdatedAt: at(2) })],
          { minutes: 3 },
        );
        return { changes, inbox: yield* readInbox(repository, 4) };
      }),
    );
    expect(outcome.changes.changedRefs).toEqual([ticketRef("t1")]);
    expect(outcome.inbox.cards[0]!.title).toBe("Renamed");
  });

  it("reports the Tasks that link a changed ref", async () => {
    const outcome = await run(({ reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1", { sourceUpdatedAt: at(1) })], { minutes: 1 });
        const task = yield* linkTaskToRef(ticketRef("t1"), 2);
        const changes = yield* reconcile(
          ACCOUNT_A,
          [ticket("t1", { title: "Renamed", sourceUpdatedAt: at(3) })],
          { minutes: 4 },
        );
        return { task, changes };
      }),
    );
    expect(outcome.changes.affectedTaskIds).toEqual([outcome.task.id]);
  });
});

describe("access and Connections that go away", () => {
  it("shows ok while any account reads the thing, then deleted over inaccessible", async () => {
    const accesses = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 1 });
        yield* reconcile(ACCOUNT_B, [ticket("t1")], { minutes: 2 });
        const missing = (
          connectionId: string,
          reason: "inaccessible" | "deleted",
          minutes: number,
        ) =>
          repository.reportMissing({
            connectionId,
            ref: ticketRef("t1"),
            reason,
            environment: environment(minutes),
          });
        const read = (minutes: number) =>
          Effect.map(readInbox(repository, minutes), (inbox) => inbox.cards[0]!.access);
        yield* missing(ACCOUNT_A, "inaccessible", 3);
        const oneRefused = yield* read(4);
        const second = yield* missing(ACCOUNT_B, "inaccessible", 5);
        const bothRefused = yield* read(6);
        yield* missing(ACCOUNT_A, "deleted", 7);
        const oneDeleted = yield* read(8);
        return { oneRefused, bothRefused, oneDeleted, second };
      }),
    );
    expect(accesses.oneRefused).toBe("ok");
    expect(accesses.bothRefused).toBe("inaccessible");
    expect(accesses.oneDeleted).toBe("deleted");
    expect(accesses.second.changedRefs).toEqual([ticketRef("t1")]);
  });

  it("keeps the last known facts of a card that lost access, and marks it stale when nothing can poll", async () => {
    const card = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1", { title: "Known" })], { minutes: 1 });
        yield* sql`UPDATE connections SET status = 'disabled' WHERE id = ${uuidFromString(ACCOUNT_A)}`;
        return (yield* readInbox(repository, 2)).cards[0]!;
      }),
    );
    expect(card).toMatchObject({ title: "Known", access: "ok", stale: true });
  });

  it("keeps the entity when its only Connection is deleted, with nobody presenting it", async () => {
    const outcome = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 1 });
        yield* sql`DELETE FROM connections WHERE id = ${uuidFromString(ACCOUNT_A)}`;
        return {
          inbox: yield* readInbox(repository, 2),
          standings: yield* repository.readStandings([ticketRef("t1")]),
          presenters: yield* sql`SELECT presented_by FROM external_entities`,
          observations: yield* countRows(sql, "external_entity_observations"),
        };
      }),
    );
    expect(outcome.inbox.cards).toEqual([]);
    expect(outcome.standings.has(ticketRef("t1"))).toBe(true);
    expect(outcome.presenters).toEqual([{ presented_by: null }]);
    expect(outcome.observations).toBe(0);
  });

  it("shows how old the facts are only through observedAt: a failed refresh leaves it where it was", async () => {
    const times = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 1 });
        yield* linkTaskToRef(ticketRef("t1"), 2);
        // The inventory no longer lists it, but its Task keeps it on the Inbox and wanted.
        yield* reconcile(ACCOUNT_A, [], { minutes: 5 });
        const observedAt = (minutes: number) =>
          Effect.map(readInbox(repository, minutes), (inbox) => inbox.cards[0]!.observedAt);
        const wanted = yield* repository.listWanted({
          connectionId: ACCOUNT_A,
          refPrefix: TICKET_PREFIX,
          limit: 50,
          now: at(6),
        });
        const beforeRead = yield* observedAt(7);
        yield* reconcile(ACCOUNT_A, [], { minutes: 8 });
        yield* repository.reportMissing({
          connectionId: ACCOUNT_A,
          ref: ticketRef("t1"),
          reason: "inaccessible",
          environment: environment(9),
        });
        const afterFailure = yield* observedAt(10);
        yield* repository.refresh({
          connectionId: ACCOUNT_A,
          observed: [ticket("t1", { concerns: [] })],
          environment: environment(12),
        });
        return { wanted, beforeRead, afterFailure, afterRefresh: yield* observedAt(13) };
      }),
    );
    expect(times.wanted).toEqual([ticketRef("t1")]);
    expect(times.beforeRead).toBe(at(1));
    expect(times.afterFailure).toBe(at(1));
    expect(times.afterRefresh).toBe(at(12));
  });
});

describe("partial records", () => {
  it("makes a record with no card, then fills it in when the full record arrives", async () => {
    const steps = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [partialTicket("t1", "Only a title")], { minutes: 1 });
        const first = yield* readInbox(repository, 2);
        const standing = yield* repository.readStandings([ticketRef("t1")]);
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 3 });
        return { first, standing, second: yield* readInbox(repository, 4) };
      }),
    );
    expect(steps.first.cards).toEqual([]);
    expect(steps.standing.has(ticketRef("t1"))).toBe(true);
    expect(steps.second.cards[0]).toMatchObject({ title: "Ticket t1", identifier: "T1" });
    // The partial record had no concern, so the full one is an arrival.
    expect(steps.second.counts.newestArrival).toBe(1);
  });

  it("clears no known field and no concern when a partial read arrives after a full one", async () => {
    const card = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(
          ACCOUNT_A,
          [ticket("t1", { title: "Full title", sourceUpdatedAt: at(1) })],
          {
            minutes: 1,
          },
        );
        yield* repository.refresh({
          connectionId: ACCOUNT_A,
          observed: [partialTicket("t1", "Partial title")],
          environment: environment(2),
        });
        return (yield* readInbox(repository, 3)).cards[0]!;
      }),
    );
    expect(card).toMatchObject({
      title: "Full title",
      url: "https://tracker.example/t1",
      concerns: ["assigned"],
    });
  });

  it("has no detail for a partial record or a place, and a detail for a full work record", async () => {
    const details = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [partialTicket("t1", "Only a title"), ticket("t2")], {
          minutes: 1,
        });
        yield* reconcile(ACCOUNT_A, [project()], { minutes: 2, kind: PROJECT_KIND });
        const read = (ref: string) =>
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly id: Uint8Array }>`
              SELECT id FROM external_entities WHERE ref = ${ref}`;
            return yield* repository.readEntity(uuidToString(rows[0]!.id), {
              ...environment(3),
              activeKinds: new Set([TICKET_KIND]),
            });
          });
        return {
          partial: yield* read(ticketRef("t1")),
          place: yield* read(PROJECT),
          full: yield* read(ticketRef("t2")),
        };
      }),
    );
    expect(Option.isNone(details.partial)).toBe(true);
    expect(Option.isNone(details.place)).toBe(true);
    expect(Option.getOrThrow(details.full)).toMatchObject({
      ref: ticketRef("t2"),
      kindAvailable: true,
      places: [],
      links: [],
      conflicts: [],
    });
  });
});

describe("places and context", () => {
  const withProject = (
    extra: (
      context: Parameters<Parameters<typeof run>[0]>[0],
    ) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
  ) =>
    run((context) =>
      Effect.gen(function* () {
        const relations = { complete: true, partOf: [PROJECT], linked: [] };
        yield* context.reconcile(ACCOUNT_A, [ticket("t1", { relations })], { minutes: 1 });
        yield* extra(context);
        return yield* readInbox(context.repository, 5);
      }),
    );

  it("draws the project as a place above the card, and is complete while the project is read", async () => {
    const inbox = await withProject(({ reconcile }) =>
      reconcile(ACCOUNT_A, [project()], { minutes: 2, kind: PROJECT_KIND }),
    );
    expect(inbox.cards[0]).toMatchObject({ ancestors: [PROJECT], contextComplete: true });
    expect(inbox.places).toEqual([
      {
        ref: PROJECT,
        kind: PROJECT_KIND,
        noun: "Project",
        caption: "Tracker project",
        title: "Harbour",
        restricted: false,
      },
    ]);
    expect(inbox.edges).toEqual([{ fromRef: ticketRef("t1"), toRef: PROJECT }]);
  });

  it("says the context is incomplete when the parent was never read", async () => {
    const inbox = await withProject(() => Effect.void);
    expect(inbox.cards[0]).toMatchObject({ ancestors: [PROJECT], contextComplete: false });
    expect(inbox.places).toEqual([]);
  });

  it("restricts the place and marks the context when no account can read the parent now", async () => {
    const inbox = await withProject(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [project()], { minutes: 2, kind: PROJECT_KIND });
        yield* repository.reportMissing({
          connectionId: ACCOUNT_A,
          ref: PROJECT,
          reason: "inaccessible",
          environment: environment(3),
        });
      }),
    );
    expect(inbox.cards[0]).toMatchObject({ contextComplete: false });
    expect(inbox.places).toEqual([
      {
        ref: PROJECT,
        kind: PROJECT_KIND,
        noun: "Project",
        caption: "Tracker project",
        restricted: true,
      },
    ]);
  });

  it("reports the Tasks below a parent whose claims were replaced", async () => {
    const outcome = await run(({ reconcile }) =>
      Effect.gen(function* () {
        const relations = { complete: true, partOf: [PROJECT], linked: [] };
        yield* reconcile(ACCOUNT_A, [ticket("t1", { relations })], { minutes: 1 });
        const task = yield* linkTaskToRef(ticketRef("t1"), 2);
        // The ticket moves to another project: its own row did not change.
        const moved = yield* reconcile(
          ACCOUNT_A,
          [ticket("t1", { relations: { complete: true, partOf: [], linked: [] } })],
          { minutes: 3 },
        );
        return { task, moved };
      }),
    );
    expect(outcome.moved.relationChangedRefs).toEqual([ticketRef("t1")]);
    expect(outcome.moved.changedRefs).toEqual([ticketRef("t1")]);
    expect(outcome.moved.affectedTaskIds).toEqual([outcome.task.id]);
  });
});

describe("the Inbox: membership, sides and counts", () => {
  it("counts one thing seen by two accounts for two concerns once", async () => {
    const inbox = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1", { concerns: ["assigned", "opened"] })], {
          minutes: 1,
        });
        yield* reconcile(ACCOUNT_B, [ticket("t1", { concerns: ["review-requested"] })], {
          minutes: 2,
        });
        return yield* readInbox(repository, 3);
      }),
    );
    expect(inbox.cards).toHaveLength(1);
    expect(inbox.counts).toMatchObject({ onTheClock: 1, requests: 1, withSomeoneElse: 0 });
  });

  it("does not count a slow kind on the clock, and puts it under Ongoing", async () => {
    const inbox = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [epic("e1")], { minutes: 1, kind: EPIC_KIND });
        return yield* readInbox(repository, 2);
      }),
    );
    expect(inbox.cards[0]!.side).toBe("ongoing");
    expect(inbox.counts).toEqual({
      onTheClock: 0,
      requests: 0,
      withSomeoneElse: 0,
      newestArrival: 0,
    });
  });

  it("moves a card with a Task under With someone else, and counts it there only", async () => {
    const steps = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1"), ticket("t2")], { minutes: 1 });
        const task = yield* linkTaskToRef(ticketRef("t1"), 2);
        const inbox = yield* readInbox(repository, 3);
        const counts = yield* repository.countInbox();
        return { task, inbox, counts };
      }),
    );
    const byRef = new Map(steps.inbox.cards.map((card) => [card.ref, card]));
    expect(byRef.get(ticketRef("t1"))).toMatchObject({
      side: "with-someone-else",
      taskId: steps.task.id,
    });
    expect(byRef.get(ticketRef("t2"))!.side).toBe("requests");
    expect(steps.counts).toEqual(steps.inbox.counts);
    expect(steps.counts).toMatchObject({ onTheClock: 1, requests: 1, withSomeoneElse: 1 });
  });

  it("keeps a card on the Inbox for its live Task alone, with no concern left", async () => {
    const steps = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 1 });
        yield* linkTaskToRef(ticketRef("t1"), 2);
        yield* reconcile(ACCOUNT_A, [], { minutes: 3 });
        return yield* readInbox(repository, 4);
      }),
    );
    expect(steps.cards.map((card) => [card.ref, card.side, card.concerns])).toEqual([
      [ticketRef("t1"), "with-someone-else", []],
    ]);
  });

  it("lists the oldest first, and caps the cards while the counts cover all of them", async () => {
    const total = MAX_INBOX_CARDS + 1;
    const inbox = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const names = Array.from(
          { length: total },
          (_, index) => `t${String(index).padStart(4, "0")}`,
        );
        yield* reconcile(
          ACCOUNT_A,
          names.map((name) => ticket(name)),
          { minutes: 1 },
        );
        return yield* readInbox(repository, 2);
      }),
    );
    expect(inbox.cards).toHaveLength(MAX_INBOX_CARDS);
    expect(inbox.truncated).toBe(true);
    expect(inbox.counts.requests).toBe(total);
    expect(inbox.counts.onTheClock).toBe(total);
    const ids = inbox.cards.map((card) => card.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("sends the same number of statements for 10 cards as for 100", async () => {
    const countStatements = (cards: number) =>
      run(({ repository, reconcile }) =>
        Effect.gen(function* () {
          const relations = { complete: true, partOf: [PROJECT], linked: [] };
          yield* reconcile(
            ACCOUNT_A,
            Array.from({ length: cards }, (_, index) => ticket(`t${index}`, { relations })),
            { minutes: 1 },
          );
          yield* reconcile(ACCOUNT_A, [project()], { minutes: 2, kind: PROJECT_KIND });
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
    const small = await countStatements(10);
    const large = await countStatements(100);
    expect(small.inbox.cards).toHaveLength(10);
    expect(large.inbox.cards).toHaveLength(100);
    expect(large.statements).toHaveLength(small.statements.length);
    expect(small.statements.length).toBeLessThanOrEqual(6);
  });
});

describe("the arrival counter", () => {
  it("rises for a new card and a concern that returns, and for nothing else", async () => {
    const newest = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const read = (minutes: number) =>
          Effect.map(repository.countInbox(), (counts) => [minutes, counts.newestArrival] as const);
        const steps: Array<readonly [number, number]> = [];
        yield* reconcile(ACCOUNT_A, [ticket("t1", { sourceUpdatedAt: at(1) })], { minutes: 1 });
        steps.push(yield* read(1));
        // A refresh, a change of facts and a second Connection's concern are not arrivals.
        yield* repository.refresh({
          connectionId: ACCOUNT_A,
          observed: [ticket("t1", { sourceUpdatedAt: at(1) })],
          environment: environment(2),
        });
        steps.push(yield* read(2));
        yield* reconcile(ACCOUNT_A, [ticket("t1", { title: "Renamed", sourceUpdatedAt: at(3) })], {
          minutes: 3,
        });
        steps.push(yield* read(3));
        yield* reconcile(
          ACCOUNT_B,
          [ticket("t1", { concerns: ["opened"], sourceUpdatedAt: at(3) })],
          {
            minutes: 4,
          },
        );
        steps.push(yield* read(4));
        // The concern leaves and returns: a new arrival.
        yield* reconcile(ACCOUNT_A, [], { minutes: 5 });
        yield* reconcile(ACCOUNT_B, [], { minutes: 5 });
        yield* reconcile(ACCOUNT_A, [ticket("t1", { sourceUpdatedAt: at(3), title: "Renamed" })], {
          minutes: 6,
        });
        steps.push(yield* read(6));
        // A second ticket.
        yield* reconcile(
          ACCOUNT_A,
          [ticket("t1", { sourceUpdatedAt: at(3), title: "Renamed" }), ticket("t2")],
          {
            minutes: 7,
          },
        );
        steps.push(yield* read(7));
        return steps.map(([, value]) => value);
      }),
    );
    expect(newest).toEqual([1, 1, 1, 1, 2, 3]);
  });

  it("does not rise when a card comes back by restore, and never goes back after a prune", async () => {
    const steps = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 1 });
        const inbox = yield* readInbox(repository, 2);
        const id = inbox.cards[0]!.id;
        yield* repository.dismiss(id, "user", at(3));
        yield* repository.restore(id, at(4));
        const afterRestore = yield* repository.countInbox();
        yield* reconcile(ACCOUNT_A, [], { minutes: 5 });
        yield* repository.pruneEntities(atDay(40));
        yield* reconcile(ACCOUNT_A, [ticket("t2")], { minutes: 41 * 24 * 60 });
        return { afterRestore, last: yield* repository.countInbox() };
      }),
    );
    expect(steps.afterRestore.newestArrival).toBe(1);
    // The pruned ticket held number 1, and the counter went on from there.
    expect(steps.last.newestArrival).toBe(2);
  });
});

describe("dismissal", () => {
  it("keeps a dismissed card out through a new concern, its concerns emptying, 30 days and a concern returning, until restore", async () => {
    const steps = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 1 });
        const id = (yield* readInbox(repository, 2)).cards[0]!.id;
        const dismissed = yield* repository.dismiss(id, "user", at(3));
        const again = yield* repository.dismiss(id, "user", at(4));
        yield* reconcile(
          ACCOUNT_A,
          [ticket("t1", { concerns: ["assigned", "review-requested"] })],
          {
            minutes: 5,
          },
        );
        const afterNewConcern = yield* readInbox(repository, 6);
        yield* reconcile(ACCOUNT_A, [], { minutes: 7 });
        const pruned = yield* repository.pruneEntities(atDay(31));
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 32 * 24 * 60 });
        const afterReturn = yield* repository.queryInbox(environment(32 * 24 * 60 + 1));
        const restored = yield* repository.restore(id, atDay(33));
        const afterRestore = yield* repository.queryInbox(environment(33 * 24 * 60 + 1));
        const unknown = yield* repository.dismiss(uuidToString(mintUuid()), "user", at(1));
        return {
          dismissed,
          again,
          afterNewConcern,
          pruned,
          afterReturn,
          restored,
          afterRestore,
          unknown,
        };
      }),
    );
    expect(steps.dismissed).toEqual(Option.some({ ref: ticketRef("t1"), changed: true }));
    expect(steps.again).toEqual(Option.some({ ref: ticketRef("t1"), changed: false }));
    expect(steps.afterNewConcern.cards).toEqual([]);
    expect(steps.pruned.entities).toBe(0);
    expect(steps.afterReturn.cards).toEqual([]);
    expect(steps.restored).toEqual(Option.some({ ref: ticketRef("t1"), changed: true }));
    expect(cardRefs(steps.afterRestore)).toEqual([ticketRef("t1")]);
    expect(Option.isNone(steps.unknown)).toBe(true);
  });
});

describe("listWanted and failed reads", () => {
  const names = Array.from({ length: 51 }, (_, index) => `t${String(index).padStart(2, "0")}`);

  it("reads all 51 wanted refs over two calls with a limit of 50, though no read ever answers", async () => {
    const calls = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(
          ACCOUNT_A,
          names.map((name) => ticket(name)),
          { minutes: 1 },
        );
        const ask = (minutes: number) =>
          repository.listWanted({
            connectionId: ACCOUNT_B,
            refPrefix: TICKET_PREFIX,
            limit: 50,
            now: at(minutes),
          });
        return [yield* ask(2), yield* ask(3), yield* ask(4)];
      }),
    );
    expect(calls[0]).toHaveLength(50);
    expect(new Set([...calls[0]!, ...calls[1]!]).size).toBe(51);
    // The next call starts again with the oldest attempt, so no ref is left out.
    expect(calls[1]![0]).toBe(ticketRef(names[50]!));
  });

  it("does not ask a Connection to read what its own inventory lists, and only refs of the prefix", async () => {
    const wanted = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 1 });
        yield* reconcile(ACCOUNT_A, [epic("e1")], { minutes: 1, kind: EPIC_KIND });
        const own = yield* repository.listWanted({
          connectionId: ACCOUNT_A,
          refPrefix: TICKET_PREFIX,
          limit: 50,
          now: at(2),
        });
        const other = yield* repository.listWanted({
          connectionId: ACCOUNT_B,
          refPrefix: TICKET_PREFIX,
          limit: 50,
          now: at(2),
        });
        return { own, other };
      }),
    );
    expect(wanted).toEqual({ own: [], other: [ticketRef("t1")] });
  });

  it("wants the project above a concerned ticket, and the peers of a root once", async () => {
    const wanted = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const relations = { complete: true, partOf: [PROJECT], linked: [ticketRef("peer")] };
        yield* reconcile(ACCOUNT_A, [ticket("t1", { relations })], { minutes: 1 });
        const ask = (minutes: number, refPrefix: string) =>
          repository.listWanted({
            connectionId: ACCOUNT_A,
            refPrefix,
            limit: 50,
            now: at(minutes),
          });
        const project = yield* ask(2, "acme-tracker:project:");
        const peer = yield* ask(2, TICKET_PREFIX);
        // Once the peer is read, it is no longer wanted.
        yield* repository.refresh({
          connectionId: ACCOUNT_A,
          observed: [partialTicket("peer", "A peer")],
          environment: environment(3),
        });
        const peerAfter = yield* ask(10, TICKET_PREFIX);
        return { project, peer, peerAfter };
      }),
    );
    expect(wanted).toEqual({
      project: [PROJECT],
      peer: [ticketRef("peer")],
      peerAfter: [],
    });
  });

  it("makes a ref that failed wait 120 seconds, then 240, and a good read resets the wait", async () => {
    const waits = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 0 });
        const fail = (seconds: number) =>
          repository.reportMissing({
            connectionId: ACCOUNT_B,
            ref: ticketRef("t1"),
            reason: "inaccessible",
            environment: {
              now: new Date(BASE + seconds * 1000).toISOString(),
              activePluginIds: [PLUGIN],
            },
          });
        const asks = (seconds: number) =>
          Effect.map(
            repository.listWanted({
              connectionId: ACCOUNT_B,
              refPrefix: TICKET_PREFIX,
              limit: 50,
              now: new Date(BASE + seconds * 1000).toISOString(),
            }),
            (refs) => refs.length,
          );
        yield* fail(10);
        const results: Array<number> = [];
        results.push(yield* asks(100)); // 90 s after the first failure: waits
        results.push(yield* asks(130)); // 120 s after: asked again
        yield* fail(130);
        results.push(yield* asks(250)); // 120 s after the second failure: still waits (240 s)
        results.push(yield* asks(370)); // 240 s after: asked again
        yield* repository.refresh({
          connectionId: ACCOUNT_B,
          observed: [ticket("t1", { concerns: [] })],
          environment: { now: new Date(BASE + 400_000).toISOString(), activePluginIds: [PLUGIN] },
        });
        yield* fail(500);
        results.push(yield* asks(640)); // the first failure again: 120 s
        return results;
      }),
    );
    expect(waits).toEqual([0, 1, 0, 1, 1]);
  });
});

describe("pruning", () => {
  it("deletes only what nothing needs, and keeps the observations that are still wanted", async () => {
    const outcome = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        const relations = {
          complete: true,
          partOf: [PROJECT, "acme-tracker:project:unread"],
          linked: [],
        };
        yield* reconcile(
          ACCOUNT_A,
          [
            ticket("plain"),
            ticket("linked"),
            ticket("dismissed"),
            ticket("recent"),
            ticket("concerned", { relations }),
          ],
          { minutes: 0 },
        );
        yield* reconcile(ACCOUNT_A, [project(), project({ ref: "acme-tracker:project:orphan" })], {
          minutes: 0,
          kind: PROJECT_KIND,
        });
        const dismissedId = (yield* readInbox(repository, 1)).cards.find(
          (card) => card.ref === ticketRef("dismissed"),
        )!.id;
        yield* linkTaskToRef(ticketRef("linked"), 1, "done");
        yield* repository.dismiss(dismissedId, "user", atDay(1));
        // Day 1: everything but "concerned" leaves the inventory. "recent" leaves at day 25.
        yield* reconcile(ACCOUNT_A, [ticket("recent"), ticket("concerned", { relations })], {
          minutes: 24 * 60,
        });
        yield* reconcile(ACCOUNT_A, [ticket("concerned", { relations })], {
          minutes: 25 * 24 * 60,
        });
        yield* repository.reportMissing({
          connectionId: ACCOUNT_B,
          ref: ticketRef("ghost"),
          reason: "inaccessible",
          environment: environment(0),
        });
        yield* repository.reportMissing({
          connectionId: ACCOUNT_B,
          ref: "acme-tracker:project:unread",
          reason: "inaccessible",
          environment: environment(0),
        });

        const result = yield* repository.pruneEntities(atDay(32));
        const entities = yield* sql<{
          readonly ref: string;
        }>`SELECT ref FROM external_entities ORDER BY ref`;
        const observations = yield* sql<{ readonly ref: string }>`
          SELECT DISTINCT ref FROM external_entity_observations WHERE connection_id = ${uuidFromString(ACCOUNT_B)}
          ORDER BY ref`;
        return {
          result,
          entities: entities.map((row) => row.ref),
          observations: observations.map((row) => row.ref),
        };
      }),
    );
    expect(outcome.entities).toEqual([
      PROJECT,
      ticketRef("concerned"),
      ticketRef("dismissed"),
      ticketRef("linked"),
      ticketRef("recent"),
    ]);
    // The ghost has no record and nobody wants it. The unread parent is above a concerned ticket.
    expect(outcome.observations).toEqual(["acme-tracker:project:unread"]);
    // The two deleted entities (plain, orphan) take their own observation rows with them.
    expect(outcome.result).toEqual({ entities: 2, observations: 3 });
  });
});

describe("standings for a search", () => {
  it("marks a ref known, on-work with its Task, or leaves it out as new", async () => {
    const standings = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("known"), ticket("busy")], { minutes: 1 });
        const task = yield* linkTaskToRef(ticketRef("busy"), 2);
        const found = yield* repository.readStandings([
          ticketRef("known"),
          ticketRef("busy"),
          ticketRef("new"),
        ]);
        return { task, found };
      }),
    );
    expect([...standings.found.entries()].sort()).toEqual([
      [ticketRef("busy"), { standing: "on-work", taskId: standings.task.id }],
      [ticketRef("known"), { standing: "known", taskId: undefined }],
    ]);
  });
});

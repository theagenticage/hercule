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
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import {
  Inbox,
  MAX_CONTEXT_DEPTH,
  MAX_CONTEXT_PARENTS,
  MAX_ENTITY_ANCESTORS,
  MAX_INBOX_CARDS,
  MAX_INBOX_PLACES,
} from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { taskRepository } from "../tasks";
import {
  externalEntityRepository,
  type EntityWriteChanges,
  type ObservedEntity,
  type ReconcileChanges,
} from "./repository";
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

/** Adds `changedRefs` to what a write changed: the refs of the entities it names, sorted. */
const named = <Changes extends EntityWriteChanges>(sql: SqlClient.SqlClient, changes: Changes) =>
  Effect.gen(function* () {
    const refs: Array<string> = [];
    for (const id of changes.entityIds) {
      const rows = yield* sql<{ readonly ref: string }>`
        SELECT ref FROM external_entities WHERE id = ${uuidFromString(id)}`;
      refs.push(rows[0]!.ref);
    }
    return { ...changes, changedRefs: refs.sort() };
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
    ) => Effect.Effect<Effect.Success<ReturnType<typeof named<ReconcileChanges>>>, SqlError>;
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
        Effect.flatMap(
          repository.reconcile({
            connectionId,
            kind: options.kind ?? TICKET_KIND,
            complete: options.complete ?? true,
            observed,
            actor: `plugin:${PLUGIN}`,
            environment: environment(options.minutes),
          }),
          (changes) => named(sql, changes),
        );
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

  it("removes nothing on an incomplete read", async () => {
    const afterPartial = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1"), ticket("t2")], { minutes: 1 });
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 2, complete: false });
        return yield* readInbox(repository, 3);
      }),
    );
    expect(cardRefs(afterPartial)).toEqual([ticketRef("t1"), ticketRef("t2")]);
  });

  it("records a loop as a conflict and applies the rest", async () => {
    const steps = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const changes = yield* reconcile(
          ACCOUNT_A,
          [
            epic("a", { relations: { complete: true, partOf: [epicRef("b")], linked: [] } }),
            epic("b", { relations: { complete: true, partOf: [epicRef("a")], linked: [] } }),
          ],
          { minutes: 1, kind: EPIC_KIND },
        );
        return { changes, inbox: yield* readInbox(repository, 2) };
      }),
    );
    expect(steps.changes.conflicts).toHaveLength(1);
    expect(steps.changes.changedRefs).toEqual([epicRef("a"), epicRef("b")]);
    expect(cardRefs(steps.inbox)).toEqual([epicRef("a"), epicRef("b")]);
  });
});

describe("reconcile: relations of one inventory", () => {
  it("stores a reversed parent as current, and leaves an unchanged claim as it was", async () => {
    const outcome = await run(({ reconcile, sql }) =>
      Effect.gen(function* () {
        const partOf = (...refs: Array<string>) => ({ complete: true, partOf: refs, linked: [] });
        yield* reconcile(
          ACCOUNT_A,
          [
            epic("a", { relations: partOf(PROJECT) }),
            epic("b", { relations: partOf(epicRef("a")) }),
          ],
          { minutes: 1, kind: EPIC_KIND },
        );
        const readClaims = sql<{
          readonly id: number;
          readonly from_ref: string;
          readonly to_ref: string;
          readonly state: string;
          readonly observed_at: string;
        }>`SELECT id, from_ref, to_ref, state, observed_at
          FROM external_entity_relation_claims ORDER BY from_ref`;
        const before = yield* readClaims;
        // One inventory turns "b is part of a" around.
        const changes = yield* reconcile(
          ACCOUNT_A,
          [
            epic("a", { relations: partOf(PROJECT, epicRef("b")) }),
            epic("b", { relations: partOf() }),
          ],
          { minutes: 2, kind: EPIC_KIND },
        );
        return { before, changes, after: yield* readClaims };
      }),
    );
    expect(outcome.changes.conflicts).toEqual([]);
    expect(outcome.after.map((claim) => [claim.from_ref, claim.to_ref, claim.state])).toEqual([
      [epicRef("a"), PROJECT, "current"],
      [epicRef("a"), epicRef("b"), "current"],
    ]);
    const unchanged = (claims: typeof outcome.before) =>
      claims.find((claim) => claim.to_ref === PROJECT);
    expect(unchanged(outcome.after)).toEqual(unchanged(outcome.before));
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
    const accesses = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t1")], { minutes: 1 });
        yield* reconcile(ACCOUNT_B, [ticket("t1")], { minutes: 2 });
        const missing = (
          connectionId: string,
          reason: "inaccessible" | "deleted",
          minutes: number,
        ) =>
          Effect.flatMap(
            repository.reportMissing({
              connectionId,
              ref: ticketRef("t1"),
              reason,
              environment: environment(minutes),
            }),
            (changes) => named(sql, changes),
          );
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

  it("announces a card that turns stale or recovers while another account still reads it", async () => {
    const outcome = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_B, [epic("e1")], { minutes: 1, kind: EPIC_KIND });
        yield* reconcile(ACCOUNT_A, [epic("e1")], { minutes: 2, kind: EPIC_KIND });
        yield* reconcile(
          ACCOUNT_A,
          [ticket("t1", { relations: { complete: true, partOf: [epicRef("e1")], linked: [] } })],
          { minutes: 3 },
        );
        const task = yield* linkTaskToRef(ticketRef("t1"), 4);
        // Only A can poll. B still holds a good read, so the access stays ok.
        yield* sql`UPDATE connections SET status = 'disabled' WHERE id = ${uuidFromString(ACCOUNT_B)}`;
        const epicCard = (minutes: number) =>
          Effect.map(readInbox(repository, minutes), (inbox) =>
            inbox.cards.find((card) => card.ref === epicRef("e1")),
          );
        const lost = yield* repository.reportMissing({
          connectionId: ACCOUNT_A,
          ref: epicRef("e1"),
          reason: "inaccessible",
          environment: environment(5),
        });
        const staleCard = yield* epicCard(6);
        const repeated = yield* repository.reportMissing({
          connectionId: ACCOUNT_A,
          ref: epicRef("e1"),
          reason: "inaccessible",
          environment: environment(7),
        });
        const recovered = yield* repository.refresh({
          connectionId: ACCOUNT_A,
          observed: [epic("e1")],
          environment: environment(8),
        });
        const freshCard = yield* epicCard(9);
        const again = yield* repository.refresh({
          connectionId: ACCOUNT_A,
          observed: [epic("e1")],
          environment: environment(10),
        });
        return {
          task,
          lost: yield* named(sql, lost),
          staleCard,
          repeated: yield* named(sql, repeated),
          recovered: yield* named(sql, recovered),
          freshCard,
          again: yield* named(sql, again),
        };
      }),
    );
    expect(outcome.staleCard).toMatchObject({ access: "ok", stale: true });
    expect(outcome.lost.changedRefs).toEqual([epicRef("e1")]);
    // The Task of the ticket below the epic hears about it too.
    expect(outcome.lost.affectedTaskIds).toEqual([outcome.task.id]);
    expect(outcome.repeated.changedRefs).toEqual([]);
    expect(outcome.freshCard).toMatchObject({ access: "ok", stale: false });
    expect(outcome.recovered.changedRefs).toEqual([epicRef("e1")]);
    expect(outcome.recovered.affectedTaskIds).toEqual([outcome.task.id]);
    // Only the time of the read moved.
    expect(outcome.again.changedRefs).toEqual([]);
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

describe("observedAt of a listed record with no concerns", () => {
  it("is dated by the complete scan that lists it, with or without concerns, and by none once the inventory leaves it out", async () => {
    const times = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const observedAt = (minutes: number) =>
          Effect.map(readInbox(repository, minutes), (inbox) => inbox.cards[0]!.observedAt);
        yield* reconcile(ACCOUNT_A, [ticket("t1", { concerns: [] })], { minutes: 1 });
        yield* linkTaskToRef(ticketRef("t1"), 2);
        // The title changes in a later complete scan: the card shows facts read at minute 10.
        yield* reconcile(ACCOUNT_A, [ticket("t1", { concerns: [], title: "Renamed" })], {
          minutes: 10,
        });
        const listed = yield* observedAt(11);
        // A scan that leaves it out stops dating it: the record falls back to its first sight.
        yield* reconcile(ACCOUNT_A, [ticket("t2")], { minutes: 20 });
        return { listed, departed: yield* observedAt(21) };
      }),
    );
    expect(times).toEqual({ listed: at(10), departed: at(1) });
  });
});

describe("a complete inventory is the whole kind", () => {
  it("unlists what an earlier complete call listed, so the refresh wants it again", async () => {
    const wantedAfter = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [project()], { minutes: 1, kind: PROJECT_KIND });
        yield* reconcile(
          ACCOUNT_A,
          [ticket("t1", { relations: { complete: true, partOf: [PROJECT], linked: [] } })],
          {
            minutes: 1,
          },
        );
        const ask = (minutes: number) =>
          repository.listWanted({
            connectionId: ACCOUNT_A,
            refPrefix: "acme-tracker:project:",
            limit: 50,
            now: at(minutes),
          });
        const whileListed = yield* ask(2);
        // A second complete call for the same kind, with other members only.
        const other = {
          ...project(),
          observation: { ...project().observation, ref: "acme-tracker:project:other" },
        };
        yield* reconcile(ACCOUNT_A, [other], { minutes: 3, kind: PROJECT_KIND });
        return { whileListed, afterSecondCall: yield* ask(4) };
      }),
    );
    expect(wantedAfter).toEqual({ whileListed: [], afterSecondCall: [PROJECT] });
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

  it("cuts the places at the reply bound when every card has its own parents", async () => {
    const cardCount = 101;
    const parentsPerCard = MAX_ENTITY_ANCESTORS;
    const parentRef = (card: number, parent: number) => `acme-tracker:project:p${card}-${parent}`;
    const inbox = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const cards = Array.from({ length: cardCount }, (_, card) =>
          ticket(`t${String(card).padStart(3, "0")}`, {
            relations: {
              complete: true,
              partOf: Array.from({ length: parentsPerCard }, (_, parent) =>
                parentRef(card, parent),
              ),
              linked: [],
            },
          }),
        );
        yield* reconcile(ACCOUNT_A, cards, { minutes: 1 });
        const projects = cards.flatMap((_, card) =>
          Array.from({ length: parentsPerCard }, (_, parent) =>
            project({ ref: parentRef(card, parent), title: `Project ${card}-${parent}` }),
          ),
        );
        yield* reconcile(ACCOUNT_A, projects, { minutes: 2, kind: PROJECT_KIND });
        return yield* readInbox(repository, 3);
      }),
    );
    expect(() => Schema.encodeSync(Inbox)(inbox)).not.toThrow();
    expect(inbox.places).toHaveLength(MAX_INBOX_PLACES);
    const placeRefs = new Set(inbox.places.map((place) => place.ref));
    const cardRefSet = new Set(cardRefs(inbox));
    // A card that lost an ancestor lists none it cannot show, and says its context is incomplete.
    const cut = inbox.cards.filter((card) => card.ancestors.length < parentsPerCard);
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.every((card) => !card.contextComplete)).toBe(true);
    for (const card of inbox.cards) {
      expect(card.ancestors.every((ref) => placeRefs.has(ref))).toBe(true);
    }
    for (const edge of inbox.edges) {
      const known = (ref: string) => placeRefs.has(ref) || cardRefSet.has(ref);
      expect(known(edge.fromRef) && known(edge.toRef)).toBe(true);
    }
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
    expect(outcome.moved.changedRefs).toEqual([ticketRef("t1")]);
    expect(outcome.moved.affectedTaskIds).toEqual([outcome.task.id]);
  });
});

describe("readContext", () => {
  const partOf = (...parents: ReadonlyArray<string>) => ({
    complete: true,
    partOf: [...parents],
    linked: [],
  });
  const T2 = ticketRef("t2");
  const [E1, E2, E3] = [epicRef("e1"), epicRef("e2"), epicRef("e3")];

  /**
   * Stores a diamond (`t2` is part of `e1` and `e3`, both part of `e2`) and a
   * chain of ten epics, `c0` up to `c9`, then reads the context of `starts`.
   * The refs in `unread` are left unread, so they are refs with no record.
   */
  const read = (
    starts: ReadonlyArray<string>,
    options: {
      readonly maxAncestors?: number;
      readonly maxPlaces?: number;
      readonly alsoPlaces?: ReadonlyArray<string>;
      readonly unread?: ReadonlyArray<string>;
      readonly activePluginIds?: ReadonlyArray<string>;
    } = {},
  ) =>
    run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(ACCOUNT_A, [ticket("t2", { relations: partOf(E1, E3) })], { minutes: 1 });
        const chain = Array.from({ length: 10 }, (_, n) =>
          epic(`c${n}`, { relations: partOf(...(n < 9 ? [epicRef(`c${n + 1}`)] : [])) }),
        );
        const epics = [
          epic("e1", { relations: partOf(E2) }),
          epic("e2"),
          epic("e3", { relations: partOf(E2) }),
          ...chain,
        ].filter((entry) => !(options.unread ?? []).includes(entry.observation.ref));
        yield* reconcile(ACCOUNT_A, epics, { minutes: 2, kind: EPIC_KIND });
        return yield* repository.readContext({
          starts,
          alsoPlaces: options.alsoPlaces ?? [],
          maxAncestors: options.maxAncestors ?? MAX_ENTITY_ANCESTORS,
          maxPlaces: options.maxPlaces ?? MAX_INBOX_PLACES,
          environment: environment(3, options.activePluginIds),
        });
      }),
    );

  const sorted = (refs: Iterable<string>) => [...refs].sort();
  const edgePairs = (edges: ReadonlyArray<{ fromRef: string; toRef: string }>) =>
    sorted(edges.map((edge) => `${edge.fromRef} > ${edge.toRef}`));

  it("lists the ancestors of a diamond nearest first, with both paths as edges", async () => {
    const context = await read([T2]);
    expect(context.ancestors.get(T2)).toEqual([E1, E3, E2]);
    expect(sorted(context.places.map((place) => place.ref))).toEqual([E1, E2, E3]);
    expect(edgePairs(context.edges)).toEqual(
      sorted([`${T2} > ${E1}`, `${T2} > ${E3}`, `${E1} > ${E2}`, `${E3} > ${E2}`]),
    );
    expect(context.contextComplete.get(T2)).toBe(true);
  });

  it("stops at the depth limit, and says the context is incomplete", async () => {
    const start = epicRef("c0");
    const context = await read([start]);
    expect(context.ancestors.get(start)).toEqual(
      Array.from({ length: MAX_CONTEXT_DEPTH }, (_, n) => epicRef(`c${n + 1}`)),
    );
    expect(context.contextComplete.get(start)).toBe(false);
    expect(context.edges).toHaveLength(MAX_CONTEXT_DEPTH);
  });

  it("is complete when the chain ends exactly at the depth limit", async () => {
    const start = epicRef("c1");
    const context = await read([start]);
    expect(context.ancestors.get(start)).toHaveLength(MAX_CONTEXT_DEPTH);
    expect(context.contextComplete.get(start)).toBe(true);
  });

  it("keeps the nearest ancestors when the places run out, and drops the edges that touch a left-out ref", async () => {
    const context = await read([T2], { maxPlaces: 1 });
    expect(context.ancestors.get(T2)).toEqual([E1]);
    expect(context.places.map((place) => place.ref)).toEqual([E1]);
    expect(edgePairs(context.edges)).toEqual([`${T2} > ${E1}`]);
    expect(context.contextComplete.get(T2)).toBe(false);
  });

  it("drops the ancestors and edges beyond the most a start may show", async () => {
    const context = await read([T2], { maxAncestors: 1 });
    expect(context.ancestors.get(T2)).toEqual([E1]);
    expect(context.places.map((place) => place.ref)).toEqual([E1]);
    expect(edgePairs(context.edges)).toEqual([`${T2} > ${E1}`]);
    expect(context.contextComplete.get(T2)).toBe(false);
  });

  it("gives the places asked for first room, and says the context is incomplete when one is left out", async () => {
    const roomy = await read([T2], { alsoPlaces: [E2], maxPlaces: 2 });
    expect(roomy.places.map((place) => place.ref)).toEqual([E1, E2]);
    expect(roomy.contextComplete.get(T2)).toBe(false);
    const full = await read([T2], { alsoPlaces: [epicRef("c0")], maxPlaces: 4 });
    expect(sorted(full.places.map((place) => place.ref))).toEqual(
      sorted([E1, E2, E3, epicRef("c0")]),
    );
    expect(full.contextComplete.get(T2)).toBe(true);
    const crowded = await read([T2], { alsoPlaces: [E2, E1], maxPlaces: 1 });
    expect(crowded.places.map((place) => place.ref)).toEqual([E2]);
    expect(crowded.contextComplete.get(T2)).toBe(false);
  });

  it("is incomplete when an ancestor is stale, because no plugin that reads it is active", async () => {
    const context = await read([T2], { activePluginIds: [] });
    expect(context.ancestors.get(T2)).toEqual([E1, E3, E2]);
    expect(context.contextComplete.get(T2)).toBe(false);
  });

  it("keeps a ref that has no record as an ancestor and an edge, with no place, and says the context is incomplete", async () => {
    const context = await read([T2], { unread: [E3] });
    expect(context.ancestors.get(T2)).toEqual([E1, E3, E2]);
    expect(sorted(context.places.map((place) => place.ref))).toEqual([E1, E2]);
    expect(edgePairs(context.edges)).toContain(`${T2} > ${E3}`);
    expect(context.contextComplete.get(T2)).toBe(false);
  });

  it("judges each start on its own", async () => {
    const context = await read([T2, E2], { maxPlaces: 3 });
    expect(context.ancestors.get(E2)).toEqual([]);
    expect(context.contextComplete.get(E2)).toBe(true);
    expect(context.contextComplete.get(T2)).toBe(true);
  });
});

describe("listSuggestions under a context", () => {
  it("lists the things at any depth below the context, oldest first, and applies the limit in the same read", async () => {
    const { limited, all, unscoped } = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const under = (...parents: ReadonlyArray<string>) => ({
          relations: { complete: true, partOf: [...parents], linked: [] },
        });
        const add = (entity: ObservedEntity, minutes: number, kind = TICKET_KIND) =>
          reconcile(ACCOUNT_A, [entity], { minutes, complete: false, kind });
        yield* add(epic("e1", { concerns: [], ...under(PROJECT) }), 1, EPIC_KIND);
        yield* add(ticket("direct1", under(PROJECT)), 2);
        yield* add(ticket("deep1", under(epicRef("e1"))), 3);
        yield* add(ticket("outside"), 4);
        yield* add(ticket("direct2", under(PROJECT)), 5);
        yield* add(ticket("deep2", under(epicRef("e1"))), 6);
        const refsOf = (rows: ReadonlyArray<{ readonly ref: string }>) =>
          rows.map((row) => row.ref);
        return {
          limited: refsOf(yield* repository.listSuggestions({ contextRef: PROJECT, limit: 3 })),
          all: refsOf(yield* repository.listSuggestions({ contextRef: PROJECT, limit: 10 })),
          unscoped: refsOf(yield* repository.listSuggestions({ contextRef: undefined, limit: 10 })),
        };
      }),
    );
    expect(limited).toEqual([ticketRef("direct1"), ticketRef("deep1"), ticketRef("direct2")]);
    expect(all).toEqual([
      ticketRef("direct1"),
      ticketRef("deep1"),
      ticketRef("direct2"),
      ticketRef("deep2"),
    ]);
    expect(unscoped).toEqual([...all.slice(0, 2), ticketRef("outside"), ...all.slice(2)]);
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
        yield* repository.restore(id, "user", at(4));
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

describe("the sentence of a card", () => {
  const concernReasons = {
    assigned: { say: "Assigned to you", tone: "plain" as const },
    "review-requested": { say: "Mei asked for your review", tone: "plain" as const },
  };

  it("comes from the kind's reason for the first concern when the source names none, and the source's own wins", async () => {
    const reasons = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const slots = {
          noun: "Ticket",
          card: "compact",
          pace: "fast",
          patience: 24,
          identifier: "T",
          facts: [],
          concernReasons,
        } as const;
        yield* reconcile(
          ACCOUNT_A,
          [
            ticket("t1", { slots, concerns: ["review-requested"] }),
            ticket("t2", {
              slots: { ...slots, reason: { say: "Checks failed", tone: "bad" } },
              concerns: ["assigned"],
            }),
          ],
          { minutes: 1 },
        );
        const inbox = yield* readInbox(repository, 2);
        return inbox.cards.map((card) => [card.ref, card.reason?.say]);
      }),
    );
    expect(reasons).toEqual([
      [ticketRef("t1"), "Mei asked for your review"],
      [ticketRef("t2"), "Checks failed"],
    ]);
  });
});

describe("dismissal", () => {
  it("keeps a dismissed card out through a new concern, its concerns emptying, 30 days and a concern returning, until restore", async () => {
    const steps = await run(({ repository, reconcile, sql }) =>
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
        const restored = yield* repository.restore(id, "session:abc", atDay(33));
        const restoredBy = yield* sql<{
          readonly restored_by: string | null;
          readonly dismissed_by: string | null;
        }>`
          SELECT restored_by, dismissed_by FROM external_entities WHERE id = ${uuidFromString(id)}`;
        const afterRestore = yield* repository.queryInbox(environment(33 * 24 * 60 + 1));
        const unknown = yield* repository.dismiss(uuidToString(mintUuid()), "user", at(1));
        return {
          dismissed,
          again,
          afterNewConcern,
          pruned,
          afterReturn,
          restored,
          restoredBy,
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
    expect(steps.restoredBy).toEqual([{ restored_by: "session:abc", dismissed_by: null }]);
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

  it("does not ask a Connection to read a place its own complete inventory lists, and asks again once the inventory drops it", async () => {
    const outcome = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        const relations = { complete: true, partOf: [PROJECT], linked: [] };
        const listProject = (minutes: number) =>
          reconcile(ACCOUNT_A, [project()], { minutes, kind: PROJECT_KIND });
        const ask = (connectionId: string, minutes: number) =>
          repository.listWanted({
            connectionId,
            refPrefix: "acme-tracker:project:",
            limit: 50,
            now: at(minutes),
          });
        yield* reconcile(ACCOUNT_A, [ticket("t1", { relations })], { minutes: 1 });
        yield* listProject(2);
        const before = yield* snapshotRows(sql);
        const listedByOwner = yield* ask(ACCOUNT_A, 3);
        const unchanged =
          (yield* snapshotRows(sql)).observations.length === before.observations.length;
        const wantedByOther = yield* ask(ACCOUNT_B, 4);
        yield* reconcile(ACCOUNT_A, [], { minutes: 5, kind: PROJECT_KIND });
        const afterDropped = yield* ask(ACCOUNT_A, 6);
        return { listedByOwner, unchanged, wantedByOther, afterDropped };
      }),
    );
    expect(outcome).toEqual({
      listedByOwner: [],
      unchanged: true,
      wantedByOther: [PROJECT],
      afterDropped: [PROJECT],
    });
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

  it("reads at most 32 parents of one thing, the first by ref", async () => {
    const wanted = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const parents = Array.from(
          { length: 50 },
          (_, index) => `acme-tracker:project:p${String(index).padStart(2, "0")}`,
        );
        yield* reconcile(
          ACCOUNT_A,
          [ticket("t1", { relations: { complete: true, partOf: parents, linked: [] } })],
          { minutes: 1 },
        );
        return yield* repository.listWanted({
          connectionId: ACCOUNT_A,
          refPrefix: "acme-tracker:project:",
          limit: 50,
          now: at(2),
        });
      }),
    );
    expect(wanted).toHaveLength(MAX_CONTEXT_PARENTS);
    expect(wanted).toEqual(
      Array.from(
        { length: MAX_CONTEXT_PARENTS },
        (_, index) => `acme-tracker:project:p${String(index).padStart(2, "0")}`,
      ),
    );
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

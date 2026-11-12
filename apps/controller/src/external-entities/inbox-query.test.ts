/**
 * Tests the Inbox reads against a migrated database: who is on the Inbox,
 * the order and the pages of a list, every query key, the facets, the rail's
 * counts and the suggested values.
 *
 * The tracker plugin here is invented ("acme"): tickets with typed fields
 * (a team that is a facet of records, an enum, a number, an age, a bool and a
 * person), and a signal kind that asks (`acme/review`) beside one that does
 * not (`acme/note`). Every body runs in one transaction on a fresh database.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { CORE_INBOX_FIELDS, type InboxClause } from "@hercule/plugin-host";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { signalRepository } from "../signals/repository";
import { taskRepository } from "../tasks";
import type { ActiveEntityKind } from "./entity-records";
import { replaceFieldRows } from "./entity-fields";
import { externalEntityInbox, type InboxEnvironment } from "./inbox-query";
import { externalEntityRepository } from "./repository";

const BASE = Date.parse("2026-03-01T00:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const at = (minutes: number): string => new Date(BASE + minutes * MINUTE).toISOString();

const ACCOUNT_A = "0190c000-0000-7000-8000-0000000000a1";
const ACCOUNT_B = "0190c000-0000-7000-8000-0000000000a2";
const REVIEW = "acme/review";
const NOTE = "acme/note";
const TEAM_KIND = "acme/team";
const TICKET_KIND = "acme/ticket";
const CHECKOUT = "acme:team:checkout";
const SEARCH = "acme:team:search";

const TICKET: ActiveEntityKind = {
  kind: TICKET_KIND,
  noun: "Ticket",
  refPrefix: "acme:ticket:",
  fields: [
    { key: "team", label: "Team", type: "text", facet: { plural: "Teams", values: TEAM_KIND } },
    {
      key: "priority",
      label: "Priority",
      type: "enum",
      values: [
        { value: "p1", label: "Urgent" },
        { value: "p2", label: "Normal" },
      ],
    },
    { key: "size", label: "Size", type: "number" },
    { key: "opened", label: "Opened", type: "age" },
    { key: "flaky", label: "Flaky", type: "bool" },
    { key: "owner", label: "Owner", type: "person", facet: { plural: "Owners" } },
  ],
};

const environment = (minutes: number, extra: Partial<InboxEnvironment> = {}): InboxEnvironment => ({
  now: at(minutes),
  activePluginIds: ["acme"],
  activeEntityKinds: [TICKET],
  kindSources: [],
  signalKinds: [
    { kind: REVIEW, noun: "review request", asks: true },
    { kind: NOTE, noun: "note", asks: false },
  ],
  savedQueries: [],
  askingKinds: [REVIEW],
  ...extra,
});

type Repository = Effect.Success<typeof externalEntityRepository>;
type Inbox = Effect.Success<typeof externalEntityInbox>;

/** The Inbox's reads. Each one gets the Inbox service when it runs. */
const inbox = {
  queryInbox: (...args: Parameters<Inbox["queryInbox"]>) =>
    Effect.flatMap(externalEntityInbox, (reads) => reads.queryInbox(...args)),
  countInbox: (...args: Parameters<Inbox["countInbox"]>) =>
    Effect.flatMap(externalEntityInbox, (reads) => reads.countInbox(...args)),
  readInboxOutline: (...args: Parameters<Inbox["readInboxOutline"]>) =>
    Effect.flatMap(externalEntityInbox, (reads) => reads.readInboxOutline(...args)),
  suggestInboxValues: (...args: Parameters<Inbox["suggestInboxValues"]>) =>
    Effect.flatMap(externalEntityInbox, (reads) => reads.suggestInboxValues(...args)),
};

const run = <A>(
  body: (context: {
    readonly repository: Repository;
    readonly sql: SqlClient.SqlClient;
  }) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
        VALUES ('acme', 1, '{}', ${at(0)}, ${at(0)})`;
      for (const [id, label] of [
        [ACCOUNT_A, "work"],
        [ACCOUNT_B, "home"],
      ] as const) {
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (${uuidFromString(id)}, 'acme', 'acme/account', ${label}, ${label}, ${label},
            'connected', '[]', '{}', ${at(0)}, ${at(0)})`;
      }
      const repository = yield* externalEntityRepository;
      return yield* body({ repository, sql });
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

interface ThingOptions {
  readonly key: string;
  readonly title?: string;
  readonly updated?: number;
  readonly concerns?: ReadonlyArray<string>;
  readonly accounts?: ReadonlyArray<string>;
  readonly owned?: boolean;
  readonly person?: string;
  readonly fields?: ReadonlyArray<{
    readonly key: string;
    readonly text?: string;
    readonly number?: number;
  }>;
  readonly access?: "ok" | "inaccessible";
}

/** Writes a ticket, its observations and its field rows. Returns its ref. */
const insertTicket = (options: ThingOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ref = `acme:ticket:${options.key}`;
    yield* sql`
      INSERT INTO external_entities
        (id, ref, kind, noun, card, pace, patience, completeness, identifier, title, url,
         lifecycle, person, source_updated_at, first_observed_at, updated_at)
      VALUES (${mintUuid()}, ${ref}, ${TICKET_KIND}, 'Ticket', 'compact', 'fast', 24, 'full',
        ${options.key.toUpperCase()}, ${options.title ?? `Ticket ${options.key}`},
        ${`https://acme.example/${options.key}`}, 'open',
        ${options.person === undefined ? null : JSON.stringify({ name: options.person })},
        ${at(options.updated ?? 1)}, ${at(1)}, ${at(1)})`;
    for (const account of options.accounts ?? [ACCOUNT_A]) {
      yield* sql`
        INSERT INTO external_entity_observations (ref, connection_id, concerns, owned_by_you, access)
        VALUES (${ref}, ${uuidFromString(account)},
          ${JSON.stringify(options.concerns ?? ["assigned"])}, ${options.owned === true ? 1 : 0},
          ${options.access ?? "ok"})`;
    }
    yield* replaceFieldRows([
      {
        ref,
        fields: (options.fields ?? []).map((field) => ({
          key: field.key,
          text_value: field.text ?? null,
          number_value: field.number ?? null,
        })),
      },
    ]);
    return ref;
  });

/** Writes a team record: a place that some Connection can read. */
const insertTeam = (ref: string, title: string, health?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO external_entities
        (id, ref, kind, noun, pace, completeness, title, status, first_observed_at, updated_at)
      VALUES (${mintUuid()}, ${ref}, ${TEAM_KIND}, 'Team', 'context', 'full', ${title},
        ${health === undefined ? null : JSON.stringify({ shape: "dot", tone: "good", label: health })},
        ${at(1)}, ${at(1)})`;
    yield* sql`
      INSERT INTO external_entity_observations (ref, connection_id, access)
      VALUES (${ref}, ${uuidFromString(ACCOUNT_A)}, 'ok')`;
  });

/** Raises an open signal of `kind` on the thing, `minutes` into the test. Returns its id. */
const raise = (ref: string, kind: string, minutes: number, asker?: string) =>
  Effect.gen(function* () {
    const signals = yield* signalRepository;
    const id = uuidToString(mintUuid());
    yield* signals.insert(
      {
        id,
        kind,
        origin: { type: "event", eventId: 1, connectionId: ACCOUNT_A, threadRef: ref },
        title: `${kind} on ${ref}`,
        ...(asker === undefined ? {} : { asker }),
        place: "acme/web",
        priority: "normal",
        blocks: [],
        actions: [],
        match: {},
        status: "open",
        createdAt: at(minutes),
      },
      [],
    );
    return id;
  });

const everything = { savedQuery: "everything" } as const;
const refsOf = (page: { readonly things: ReadonlyArray<{ readonly ref: string }> }) =>
  page.things.map((thing) => thing.ref.replace("acme:ticket:", ""));

const list = (minutes: number, query: Partial<Parameters<Inbox["queryInbox"]>[1]> = {}) =>
  inbox.queryInbox(environment(minutes), { list: everything, ...query });

const withClause = (clause: InboxClause) => ({ clauses: [clause] });

describe("who is on the Inbox", () => {
  it("lists a thing for a concern, a live Task or an open signal, and no other", async () => {
    const refs = await run(() =>
      Effect.gen(function* () {
        yield* insertTicket({ key: "concern" });
        yield* insertTicket({ key: "task", concerns: [] });
        yield* insertTicket({ key: "signal", concerns: [] });
        yield* insertTicket({ key: "none", concerns: [] });
        const tasks = yield* taskRepository;
        yield* tasks.insert({
          title: "Work",
          description: "",
          status: "open",
          stage: "planned",
          priority: "normal",
          labels: [],
          projectId: undefined,
          provenance: [{ ref: "acme:ticket:task" }],
          at: at(2),
          actor: "user",
        });
        yield* raise("acme:ticket:signal", NOTE, 2);
        return refsOf(yield* list(5)).sort();
      }),
    );
    expect(refs).toEqual(["concern", "signal", "task"]);
  });

  it("does not list a signal that is snoozed until later", async () => {
    const refs = await run(({ sql }) =>
      Effect.gen(function* () {
        yield* insertTicket({ key: "a", concerns: [] });
        const id = yield* raise("acme:ticket:a", NOTE, 2);
        yield* sql`INSERT INTO signal_snoozes (signal_id, until, snoozed_at, actor)
          VALUES (${uuidFromString(id)}, ${at(60)}, ${at(3)}, 'user')`;
        return {
          before: refsOf(yield* list(10)),
          after: refsOf(yield* list(61)),
        };
      }),
    );
    expect(refs).toEqual({ before: [], after: ["a"] });
  });

  it("brings a dismissed thing back for an ask raised after the dismissal, and for nothing else", async () => {
    const steps = await run(({ repository }) =>
      Effect.gen(function* () {
        const ref = yield* insertTicket({ key: "a" });
        yield* raise(ref, REVIEW, 2);
        const [moved] = yield* Effect.map(
          repository.dismiss(
            [(yield* inbox.queryInbox(environment(3), { list: everything })).things[0]!.id],
            "user",
            at(4),
          ),
          (result) => ("moved" in result ? result.moved : []),
        );
        const afterDismiss = refsOf(yield* list(5));
        // Not an ask, and an ask that was open before: neither brings it back.
        yield* raise(ref, NOTE, 6);
        const afterNote = refsOf(yield* list(7));
        yield* raise(ref, REVIEW, 8, "Mei");
        const back = yield* list(9);
        // Dismissing the thing that came back moves the cutoff, so it goes again.
        const again = yield* repository.dismiss([back.things[0]!.id], "user", at(10));
        const afterSecondDismiss = refsOf(yield* list(11));
        yield* raise(ref, REVIEW, 12, "Omar");
        const backAgain = yield* list(13);
        return { moved, afterDismiss, afterNote, back, again, afterSecondDismiss, backAgain };
      }),
    );
    expect(steps.moved!.changed).toBe(true);
    expect(steps.afterDismiss).toEqual([]);
    expect(steps.afterNote).toEqual([]);
    expect(refsOf(steps.back)).toEqual(["a"]);
    expect(steps.back.things[0]!.dismissedAt).toBe(at(4));
    // The ask that was open at the dismissal is still an ask; it just did not bring the thing back.
    expect(steps.back.things[0]!.askCount).toBe(2);
    expect("moved" in steps.again && steps.again.moved[0]!.changed).toBe(true);
    expect(steps.afterSecondDismiss).toEqual([]);
    expect(refsOf(steps.backAgain)).toEqual(["a"]);
    expect(steps.backAgain.things[0]!.dismissedAt).toBe(at(10));
  });

  it("counts a thing that came back as a new arrival", async () => {
    const arrivals = await run(({ repository, sql }) =>
      Effect.gen(function* () {
        const ref = yield* insertTicket({ key: "a" });
        const id = (yield* inbox.queryInbox(environment(2), { list: everything })).things[0]!.id;
        yield* repository.dismiss([id], "user", at(3));
        const before = (yield* inbox.countInbox(environment(4))).newestArrival;
        yield* repository.recordArrivalAfter(ref, at(5), [REVIEW], raise(ref, REVIEW, 5));
        const after = (yield* inbox.countInbox(environment(6))).newestArrival;
        const stored = yield* sql<{ readonly arrival_sequence: number }>`
          SELECT arrival_sequence FROM external_entities WHERE ref = ${ref}`;
        return { before, after, stored: stored[0]!.arrival_sequence };
      }),
    );
    expect(arrivals.before).toBe(0);
    expect(arrivals.after).toBeGreaterThan(0);
    expect(arrivals.after).toBe(arrivals.stored);
  });

  it("takes an ask off the list only when the user took the thing on after it was raised", async () => {
    const steps = await run(() =>
      Effect.gen(function* () {
        const refs = {
          taken: yield* insertTicket({ key: "taken" }),
          handed: yield* insertTicket({ key: "handed" }),
          bySession: yield* insertTicket({ key: "by-session" }),
          byHand: yield* insertTicket({ key: "by-hand" }),
          before: yield* insertTicket({ key: "before" }),
        };
        for (const ref of Object.values(refs)) yield* raise(ref, REVIEW, 2);
        const tasks = yield* taskRepository;
        const makeTask = (
          ref: string,
          how: {
            readonly takenOn?: boolean;
            readonly runId?: string;
            readonly actor?: string;
            readonly minutes?: number;
          },
        ) =>
          tasks.insert({
            title: `Work on ${ref}`,
            description: "",
            status: "open",
            stage: "planned",
            priority: "normal",
            labels: [],
            projectId: undefined,
            provenance: [{ ref, ...(how.runId === undefined ? {} : { runId: how.runId }) }],
            ...(how.takenOn === true ? { takenOn: true } : {}),
            at: at(how.minutes ?? 3),
            actor: how.actor ?? "user",
          });
        // Take on and Add to Work set `takenOn`; nothing else does, whoever the actor is.
        yield* makeTask(refs.taken, { takenOn: true });
        yield* makeTask(refs.handed, { runId: uuidToString(mintUuid()) });
        yield* makeTask(refs.bySession, { actor: "session:0190c000-0000-7000-8000-0000000000e1" });
        yield* makeTask(refs.byHand, {});
        // Taken on before the ask was raised: the ask stays.
        yield* makeTask(refs.before, { takenOn: true, minutes: 1 });
        const waits = { savedQuery: "waits" } as const;
        const afterTake = refsOf(yield* list(4, { list: waits }));
        yield* raise(refs.taken, REVIEW, 5);
        const afterNewAsk = refsOf(yield* list(6, { list: waits }));
        return { afterTake, afterNewAsk };
      }),
    );
    expect(steps.afterTake.sort()).toEqual(["before", "by-hand", "by-session", "handed"]);
    expect(steps.afterNewAsk.sort()).toEqual([
      "before",
      "by-hand",
      "by-session",
      "handed",
      "taken",
    ]);
  });
});

describe("the order and the pages of a list", () => {
  it("orders the waiting list by the oldest ask, then the rest by the latest change, and newest by the latest change", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const a = yield* insertTicket({ key: "a", updated: 10 });
        const b = yield* insertTicket({ key: "b", updated: 30 });
        yield* insertTicket({ key: "c", updated: 20 });
        yield* insertTicket({ key: "d", updated: 40 });
        yield* raise(a, REVIEW, 7);
        yield* raise(b, REVIEW, 5);
        yield* raise(b, REVIEW, 9);
        return {
          waiting: yield* list(50, {
            list: { browse: { source: "acme", key: "source", value: "acme" } },
          }),
          newest: yield* list(50),
        };
      }),
    );
    expect(refsOf(result.waiting)).toEqual(["b", "a", "d", "c"]);
    expect(result.waiting.order).toBe("waiting");
    expect(result.waiting.things[0]).toMatchObject({ askCount: 2, waitingSince: at(5) });
    expect(refsOf(result.newest)).toEqual(["d", "b", "c", "a"]);
  });

  it("pages in keysets of 200 with a cursor bound to its query, and total counts the whole result", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        for (let index = 0; index < 205; index++) {
          const key = `t${String(index).padStart(3, "0")}`;
          const ref = yield* insertTicket({ key, updated: index });
          if (index % 2 === 0) yield* raise(ref, REVIEW, 300 - index);
        }
        const waits = { list: { savedQuery: "waits" } } as const;
        const first = yield* list(400, waits);
        const second = yield* list(400, { ...waits, cursor: first.nextCursor! });
        const newestFirst = yield* list(400);
        const newestSecond = yield* list(400, { cursor: newestFirst.nextCursor! });
        const wrong = yield* Effect.exit(
          list(400, { list: { savedQuery: "mine" }, cursor: newestFirst.nextCursor! }),
        );
        const garbage = yield* Effect.exit(list(400, { cursor: "not a cursor" }));
        const both = yield* Effect.exit(
          list(400, { cursor: newestFirst.nextCursor!, refs: ["acme:ticket:t001"] }),
        );
        return { first, second, newestFirst, newestSecond, wrong, garbage, both };
      }),
    );
    expect(result.first.total).toBe(103);
    expect(result.first.things).toHaveLength(103);
    expect(result.first.nextCursor).toBeUndefined();
    expect(result.newestFirst.things).toHaveLength(200);
    expect(result.newestFirst.total).toBe(205);
    expect(result.newestSecond.things).toHaveLength(5);
    expect(result.newestSecond.nextCursor).toBeUndefined();
    expect(result.newestSecond.facets).toBeUndefined();
    expect(result.newestSecond.total).toBeUndefined();
    const all = [...result.newestFirst.things, ...result.newestSecond.things].map((t) => t.ref);
    expect(new Set(all).size).toBe(205);
    for (const exit of [result.wrong, result.garbage, result.both]) {
      expect(exit._tag).toBe("Failure");
    }
    expect(JSON.stringify(result.wrong)).toContain("does not belong");
  });

  it("reads a refs request for those things only, in the list's order, with no total", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const a = yield* insertTicket({ key: "a", updated: 10 });
        const b = yield* insertTicket({ key: "b", updated: 30 });
        yield* insertTicket({ key: "c", updated: 20 });
        yield* raise(a, REVIEW, 2);
        const refs = yield* list(5, { refs: [a, b, "acme:ticket:missing"] });
        const first = yield* list(5);
        return { refs, first };
      }),
    );
    expect(result.refs.things.map((thing) => thing.ref)).toEqual([
      "acme:ticket:b",
      "acme:ticket:a",
    ]);
    expect(result.refs.things[1]!.askCount).toBe(1);
    expect(result.refs.total).toBeUndefined();
    expect(result.refs.facets).toBeUndefined();
    expect(result.first.total).toBe(3);
  });

  it("pages the waiting order across the two groups", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        for (let index = 0; index < 250; index++) {
          const ref = yield* insertTicket({
            key: `t${String(index).padStart(3, "0")}`,
            updated: index,
          });
          if (index < 120) yield* raise(ref, REVIEW, index + 1);
        }
        const browse = {
          list: { browse: { source: "acme", key: "source", value: "acme" } },
        } as const;
        const first = yield* list(400, browse);
        const second = yield* list(400, { ...browse, cursor: first.nextCursor! });
        return { first, second };
      }),
    );
    const all = [...result.first.things, ...result.second.things].map((t) => t.ref);
    expect(all).toHaveLength(250);
    expect(new Set(all).size).toBe(250);
    expect(result.first.things[0]!.ref).toBe("acme:ticket:t000");
    expect(result.first.things[119]!.ref).toBe("acme:ticket:t119");
    // After the asks, the latest change first.
    expect(result.first.things[120]!.ref).toBe("acme:ticket:t249");
  });

  it("reads only the named refs that still belong, in the list's order", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        yield* insertTicket({ key: "a", updated: 1 });
        yield* insertTicket({ key: "b", updated: 2 });
        yield* insertTicket({ key: "gone", concerns: [] });
        return yield* list(9, {
          refs: ["acme:ticket:a", "acme:ticket:b", "acme:ticket:gone", "acme:ticket:never"],
        });
      }),
    );
    expect(refsOf(result)).toEqual(["b", "a"]);
    expect(result.facets).toBeUndefined();
  });

  it("sends the same number of statements for 5 things as for 60", async () => {
    const countStatements = (things: number) =>
      run(() =>
        Effect.gen(function* () {
          for (let index = 0; index < things; index++) {
            const ref = yield* insertTicket({
              key: `t${index}`,
              fields: [{ key: "team", text: CHECKOUT }],
            });
            yield* raise(ref, REVIEW, 2 + index);
          }
          const statements: Array<string> = [];
          const record = Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            }),
          );
          const page = yield* list(100).pipe(record);
          const pageStatements = statements.splice(0);
          yield* inbox.countInbox(environment(100)).pipe(record);
          const sidebarStatements = statements.splice(0);
          yield* inbox
            .readInboxOutline(environment(100), { pins: [], browseFolded: [] })
            .pipe(record);
          const outlineStatements = statements.splice(0);
          yield* inbox
            .suggestInboxValues(environment(100), {
              list: everything,
              key: "team",
              prefix: "",
            })
            .pipe(record);
          return {
            page: pageStatements.length,
            sidebar: sidebarStatements.length,
            outline: outlineStatements.length,
            values: statements.length,
            things: page.things.length,
          };
        }),
      );
    const small = await countStatements(5);
    const large = await countStatements(60);
    expect(small.things).toBe(5);
    expect(large.things).toBe(60);
    expect(large).toEqual({ ...small, things: 60 });
    expect(small.page).toBeLessThanOrEqual(14);
    expect(small.sidebar).toBe(1);
    expect(small.outline).toBeLessThanOrEqual(6);
    expect(small.values).toBe(1);
  });
});

describe("what a thing carries", () => {
  it("carries its asks newest first with the kind's noun, the kinds, the face and its accounts", async () => {
    const thing = await run(() =>
      Effect.gen(function* () {
        const ref = yield* insertTicket({
          key: "a",
          accounts: [ACCOUNT_A, ACCOUNT_B],
          fields: [{ key: "owner", text: "Mei" }],
        });
        yield* raise(ref, REVIEW, 2, "Mei");
        yield* raise(ref, REVIEW, 4, "Omar");
        yield* raise(ref, NOTE, 5);
        return (yield* list(9)).things[0]!;
      }),
    );
    expect(thing.asks.map((ask) => [ask.noun, ask.asker, ask.createdAt])).toEqual([
      ["review request", "Omar", at(4)],
      ["review request", "Mei", at(2)],
    ]);
    expect(thing).toMatchObject({
      askCount: 2,
      askKinds: [REVIEW],
      openKinds: [NOTE, REVIEW],
      source: "acme",
      access: "ok",
      face: null,
    });
    expect(thing.accounts).toHaveLength(2);
    expect(thing.asks[0]!.say.say).toContain("review");
  });
});

describe("the clauses of a query", () => {
  const seed = Effect.gen(function* () {
    yield* insertTeam(CHECKOUT, "Checkout revamp", "On track");
    yield* insertTeam(SEARCH, "Search");
    const a = yield* insertTicket({
      key: "a",
      title: "Login is flaky",
      owned: true,
      person: "Omar",
      fields: [
        { key: "team", text: CHECKOUT },
        { key: "priority", text: "p1" },
        { key: "size", number: 5 },
        { key: "opened", number: BASE - 3 * DAY },
        { key: "flaky", number: 1 },
        { key: "owner", text: "Mei" },
      ],
    });
    const b = yield* insertTicket({
      key: "b",
      title: "Search is slow",
      accounts: [ACCOUNT_B],
      fields: [
        { key: "team", text: SEARCH },
        { key: "priority", text: "p2" },
        { key: "size", number: 20 },
        { key: "opened", number: BASE - 1 * DAY },
        { key: "flaky", number: 0 },
      ],
    });
    yield* raise(a, REVIEW, 1, "Mei");
    yield* raise(b, NOTE, 1);
    return { a, b };
  });

  const query = (clause: InboxClause | ReadonlyArray<InboxClause>, text?: string) =>
    run(() =>
      Effect.gen(function* () {
        yield* seed;
        const clauses = Array.isArray(clause) ? clause : [clause];
        return refsOf(
          yield* list(2 * 24 * 60, {
            clauses,
            ...(text === undefined ? {} : { text }),
          }),
        );
      }),
    );

  it("answers the core keys", async () => {
    expect(await query({ key: "asks", op: "is", value: true })).toEqual(["a"]);
    expect(await query({ key: "asks", op: "is", value: false })).toEqual(["b"]);
    expect(await query({ key: "held", op: "is", value: false })).toEqual(["a", "b"]);
    expect(await query({ key: "mine", op: "is", value: true })).toEqual(["a"]);
    expect(await query({ key: "signal", op: "is", value: REVIEW })).toEqual(["a"]);
    expect(await query({ key: "signal", op: "is", value: "NOTE" })).toEqual(["b"]);
    expect(await query({ key: "source", op: "is", value: "ACME" })).toHaveLength(2);
    expect(await query({ key: "source", op: "is", value: "other" })).toEqual([]);
    expect(await query({ key: "kind", op: "is", value: "ticket" })).toHaveLength(2);
    expect(await query({ key: "kind", op: "is", value: "acme/other" })).toEqual([]);
    expect(await query({ key: "account", op: "is", value: ACCOUNT_B })).toEqual(["b"]);
    expect(await query({ key: "account", op: "is", value: "work" })).toEqual(["a"]);
    expect(await query({ key: "from", op: "is", value: "mei" })).toEqual(["a"]);
    expect(await query({ key: "from", op: "is", value: "omar" })).toEqual([]);
    // A thing with no ask is "from" its own person.
    expect(await query({ key: "from", op: "is", value: "nobody" })).toEqual([]);
  });

  it("measures the wait of the oldest ask against the read clock", async () => {
    // The ask is about two days old at the read.
    expect(await query({ key: "waiting", op: "over", value: 86_400 })).toEqual(["a"]);
    expect(await query({ key: "waiting", op: "over", value: 3 * 86_400 })).toEqual([]);
    expect(await query({ key: "waiting", op: "under", value: 3 * 86_400 })).toEqual(["a"]);
  });

  it("answers declared fields by their type, case-insensitively, across sources", async () => {
    expect(await query({ key: "priority", op: "is", value: "urgent" })).toEqual(["a"]);
    expect(await query({ key: "priority", op: "is", value: "P2" })).toEqual(["b"]);
    expect(await query({ key: "priority", op: "is", value: "p3" })).toEqual([]);
    expect(await query({ key: "size", op: "over", value: 10 })).toEqual(["b"]);
    expect(await query({ key: "size", op: "under", value: 10 })).toEqual(["a"]);
    expect(await query({ key: "size", op: "is", value: 5 })).toEqual(["a"]);
    // At the read, `a` is five days old and `b` three.
    expect(await query({ key: "opened", op: "over", value: 4 * 86_400 })).toEqual(["a"]);
    expect(await query({ key: "opened", op: "under", value: 4 * 86_400 })).toEqual(["b"]);
    expect(await query({ key: "flaky", op: "is", value: true })).toEqual(["a"]);
    expect(await query({ key: "flaky", op: "is", value: false })).toEqual(["b"]);
    expect(await query({ key: "owner", op: "is", value: "MEI" })).toEqual(["a"]);
    // A value that does not fit the type matches nothing on that source.
    expect(await query({ key: "size", op: "is", value: "big" })).toEqual([]);
    // The raw words of the CLI are read for the field's type.
    expect(await query({ key: "size", op: "over", value: "10" })).toEqual(["b"]);
    expect(await query({ key: "flaky", op: "is", value: "no" })).toEqual(["b"]);
    expect(await query({ key: "opened", op: "over", value: "4d" })).toEqual(["a"]);
  });

  it("matches a facet of records by its ref or by the record's title", async () => {
    expect(await query({ key: "team", op: "is", value: CHECKOUT })).toEqual(["a"]);
    expect(await query({ key: "team", op: "is", value: "checkout revamp" })).toEqual(["a"]);
    expect(await query({ key: "team", op: "is", value: "Search" })).toEqual(["b"]);
  });

  it("does not match the title of a record no Connection can read", async () => {
    const found = await run(({ sql }) =>
      Effect.gen(function* () {
        yield* seed;
        yield* sql`UPDATE external_entity_observations SET access = 'inaccessible'
          WHERE ref = ${SEARCH}`;
        const byTitle = yield* list(9, withClause({ key: "team", op: "is", value: "Search" }));
        const byRef = yield* list(9, withClause({ key: "team", op: "is", value: SEARCH }));
        const byText = yield* list(9, { text: "Search" });
        return { byTitle: refsOf(byTitle), byRef: refsOf(byRef), byText: refsOf(byText) };
      }),
    );
    expect(found.byTitle).toEqual([]);
    expect(found.byRef).toEqual(["b"]);
    // "Search" is still in the title of the ticket itself.
    expect(found.byText).toEqual(["b"]);
  });

  it("ties a clause to one source or one account", async () => {
    expect(await query({ key: "team", op: "is", value: CHECKOUT, source: "acme" })).toEqual(["a"]);
    // A source that declares no such field is refused, not read as empty.
    await expect(
      query({ key: "team", op: "is", value: CHECKOUT, source: "other" }),
    ).rejects.toThrow();
    expect(await query({ key: "asks", op: "is", value: true, source: "other" })).toEqual([]);
    expect(
      await query({ key: "priority", op: "is", value: "p2", connectionId: ACCOUNT_B }),
    ).toEqual(["b"]);
    expect(
      await query({ key: "priority", op: "is", value: "p2", connectionId: ACCOUNT_A }),
    ).toEqual([]);
  });

  it("requires every word of the free text in the title, the identifier or a text field, in any case", async () => {
    expect(await query([], "login FLAKY")).toEqual(["a"]);
    expect(await query([], "login slow")).toEqual([]);
    expect(await query([], "b")).toEqual(["b"]);
    expect(await query([], "mei")).toEqual(["a"]);
    expect(await query([], "revamp")).toEqual(["a"]);
    expect(await query([], "100%")).toEqual([]);
    expect(await query([], "_")).toEqual([]);
  });

  it("combines the clauses with the list, and refuses a key nobody declares", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        yield* seed;
        const narrowed = yield* list(2 * 24 * 60, {
          list: { savedQuery: "waits" },
          clauses: [{ key: "size", op: "under", value: 10 }],
        });
        const empty = yield* list(2 * 24 * 60, {
          list: { savedQuery: "waits" },
          clauses: [{ key: "size", op: "over", value: 10 }],
        });
        const unknown = yield* Effect.exit(
          list(9, withClause({ key: "colour", op: "is", value: "red" })),
        );
        const badList = yield* Effect.exit(list(9, { list: { savedQuery: "nope" } }));
        const tooMany = yield* Effect.exit(list(9, { text: "a b c d e f g h i j k l m" }));
        return { narrowed: refsOf(narrowed), empty: refsOf(empty), unknown, badList, tooMany };
      }),
    );
    expect(result.narrowed).toEqual(["a"]);
    expect(result.empty).toEqual([]);
    expect(JSON.stringify(result.unknown)).toContain('no source declares a field \\"colour\\"');
    expect(JSON.stringify(result.badList)).toContain("there is no saved query");
    expect(result.tooMany._tag).toBe("Failure");
  });

  it("refuses an operator its key does not take, with a reason, on a core key and on a declared field", async () => {
    const refusals = await run(() =>
      Effect.gen(function* () {
        yield* seed;
        const refuse = (clause: InboxClause) =>
          Effect.map(Effect.exit(list(9, withClause(clause))), (exit) => JSON.stringify(exit));
        return [
          yield* refuse({ key: "asks", op: "over", value: 1 }),
          yield* refuse({ key: "waiting", op: "is", value: 5 }),
          yield* refuse({ key: "team", op: "over", value: 3 }),
        ];
      }),
    );
    expect(refusals[0]).toContain('asks takes \\"is\\", not \\"over\\"');
    expect(refusals[1]).toContain('waiting takes \\"over\\" or \\"under\\"');
    expect(refusals[2]).toContain('team takes \\"is\\", not \\"over\\"');
  });

  it("treats a hostile value as plain text, so it matches nothing and harms nothing", async () => {
    const hostile = "x'; DROP TABLE external_entities; --";
    const found = await run(() =>
      Effect.gen(function* () {
        yield* seed;
        return {
          byFrom: refsOf(yield* list(9, withClause({ key: "from", op: "is", value: hostile }))),
          byField: refsOf(yield* list(9, withClause({ key: "team", op: "is", value: hostile }))),
          byText: refsOf(yield* list(9, { text: hostile })),
          after: refsOf(yield* list(9)),
        };
      }),
    );
    expect(found).toEqual({ byFrom: [], byField: [], byText: [], after: ["a", "b"] });
  });

  it("matches the characters of free text literally, not as a pattern", async () => {
    const found = await run(() =>
      Effect.gen(function* () {
        yield* seed;
        return {
          percent: refsOf(yield* list(9, { text: "%" })),
          underscore: refsOf(yield* list(9, { text: "Login_is" })),
          words: refsOf(yield* list(9, { text: "login FLAKY" })),
        };
      }),
    );
    expect(found).toEqual({ percent: [], underscore: [], words: ["a"] });
  });

  it("counts the facets of the whole result on the first page", async () => {
    const page = await run(() =>
      Effect.gen(function* () {
        yield* seed;
        return yield* list(9);
      }),
    );
    // The source has two accounts here, so each has its own facets.
    const teams = page.facets!.filter((facet) => facet.key === "team");
    expect(teams.map((facet) => facet.connectionId).sort()).toEqual([ACCOUNT_A, ACCOUNT_B]);
    const work = teams.find((facet) => facet.connectionId === ACCOUNT_A)!;
    expect(work).toMatchObject({ source: "acme", label: "Team", plural: "Teams", more: 0 });
    expect(work.values.map((value) => [value.value, value.label, value.count])).toEqual([
      [CHECKOUT, "Checkout revamp", 1],
    ]);
    expect(work.values[0]!.health).toMatchObject({ label: "On track" });
    expect(
      teams.find((facet) => facet.connectionId === ACCOUNT_B)!.values.map((value) => value.label),
    ).toEqual(["Search"]);
    expect(
      page.facets!.find((facet) => facet.key === "owner" && facet.connectionId === ACCOUNT_A)!
        .values,
    ).toEqual([{ value: "Mei", label: "Mei", count: 1 }]);
  });
});

describe("the outline of the rail", () => {
  it("counts every saved query, each source and its accounts, and the sidebar's waits", async () => {
    const { counts, sidebar } = await run(() =>
      Effect.gen(function* () {
        const a = yield* insertTicket({ key: "a", owned: true });
        yield* insertTicket({ key: "b", accounts: [ACCOUNT_A, ACCOUNT_B] });
        yield* raise(a, REVIEW, 2);
        return {
          counts: yield* inbox.readInboxOutline(environment(9), {
            pins: [],
            browseFolded: [],
          }),
          sidebar: yield* inbox.countInbox(environment(9)),
        };
      }),
    );
    expect(sidebar.waiting).toBe(1);
    expect(counts.savedQueries.map((query) => [query.id, query.count])).toEqual([
      ["waits", 1],
      ["mine", 1],
      ["updates", 1],
      ["with-hercule", 0],
      ["everything", 2],
    ]);
    expect(counts.sources).toMatchObject([{ source: "acme", count: 2, folded: false }]);
    expect(counts.sources[0]!.accounts.map((account) => [account.label, account.count])).toEqual([
      ["home", 1],
      ["work", 2],
    ]);
    expect(counts.fields.filter((field) => field.source === undefined)).toHaveLength(
      CORE_INBOX_FIELDS.length,
    );
    expect(counts.fields.find((field) => field.key === "priority")).toMatchObject({
      type: "enum",
      source: "acme",
      values: [
        { value: "p1", label: "Urgent" },
        { value: "p2", label: "Normal" },
      ],
    });
    expect(counts.failing).toEqual([]);
  });

  it("lists every known record of a facet with count 0, per account when the source has several, and none for a folded source", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        yield* insertTeam(CHECKOUT, "Checkout", "Late");
        yield* insertTeam(SEARCH, "Search");
        yield* insertTicket({ key: "a", fields: [{ key: "team", text: CHECKOUT }] });
        const open = yield* inbox.readInboxOutline(environment(9), {
          pins: [],
          browseFolded: [],
        });
        const folded = yield* inbox.readInboxOutline(environment(9), {
          pins: [],
          browseFolded: [{ source: "acme" }],
        });
        yield* insertTicket({
          key: "b",
          accounts: [ACCOUNT_B],
          fields: [{ key: "team", text: SEARCH }],
        });
        const several = yield* inbox.readInboxOutline(environment(9), {
          pins: [],
          browseFolded: [],
        });
        return { open, folded, several };
      }),
    );
    const team = result.open.sources[0]!.facets!.find((facet) => facet.key === "team")!;
    expect(team.values.map((value) => [value.label, value.count])).toEqual([
      ["Checkout", 1],
      ["Search", 0],
    ]);
    expect(team.values[0]!.health).toMatchObject({ label: "Late" });
    expect(result.folded.sources[0]).toMatchObject({ folded: true });
    expect(result.folded.sources[0]!.facets).toBeUndefined();
    const perAccount = result.several.sources[0]!.facets!.filter((facet) => facet.key === "team");
    expect(perAccount.map((facet) => facet.connectionId).sort()).toEqual([ACCOUNT_A, ACCOUNT_B]);
    // Only account A observes the Checkout and Search records, so account B
    // lists no record it does not observe with count 0.
    const home = perAccount.find((facet) => facet.connectionId === ACCOUNT_B)!;
    expect(home.values.map((value) => [value.label, value.count])).toEqual([["Search", 1]]);
    const work = perAccount.find((facet) => facet.connectionId === ACCOUNT_A)!;
    expect(work.values.map((value) => [value.label, value.count])).toEqual([
      ["Checkout", 1],
      ["Search", 0],
    ]);
  });

  it("cuts a facet at 100 values and says how many more there are", async () => {
    const team = await run(() =>
      Effect.gen(function* () {
        for (let index = 0; index < 105; index++) {
          const ref = `acme:team:t${String(index).padStart(3, "0")}`;
          yield* insertTeam(ref, `Team ${String(index).padStart(3, "0")}`);
        }
        yield* insertTicket({ key: "a", fields: [{ key: "team", text: "acme:team:t104" }] });
        const counts = yield* inbox.readInboxOutline(environment(9), {
          pins: [],
          browseFolded: [],
        });
        return counts.sources[0]!.facets!.find((facet) => facet.key === "team")!;
      }),
    );
    expect(team.values).toHaveLength(100);
    expect(team.values[0]).toMatchObject({ value: "acme:team:t104", count: 1 });
    expect(team.more).toBe(5);
  });

  it("gives each pin its live label and count, and keeps the text of a value that is gone", async () => {
    const pins = await run(() =>
      Effect.gen(function* () {
        yield* insertTeam(CHECKOUT, "Checkout revamp");
        yield* insertTicket({ key: "a", fields: [{ key: "team", text: CHECKOUT }] });
        yield* insertTicket({ key: "b", fields: [{ key: "team", text: CHECKOUT }] });
        const counts = yield* inbox.readInboxOutline(environment(9), {
          pins: [
            { source: "acme", key: "team", value: CHECKOUT },
            { source: "acme", key: "team", value: "acme:team:gone" },
            { source: "acme", key: "owner", value: "Nobody", connectionId: ACCOUNT_B },
            { source: "acme", key: "undeclared", value: "x" },
          ],
          browseFolded: [],
        });
        return counts.pins;
      }),
    );
    expect(pins.map((pin) => [pin.label, pin.count])).toEqual([
      ["Checkout revamp", 2],
      ["acme:team:gone", 0],
      ["Nobody", 0],
      ["x", 0],
    ]);
  });

  it("lists a source with a Connection that needs signing in again as failing", async () => {
    const failing = await run(({ sql }) =>
      Effect.gen(function* () {
        yield* sql`UPDATE connections SET status = 'needs-reauth', updated_at = ${at(5)}
          WHERE id = ${uuidFromString(ACCOUNT_B)}`;
        return (yield* inbox.readInboxOutline(environment(9), { pins: [], browseFolded: [] }))
          .failing;
      }),
    );
    expect(failing).toEqual([{ source: "acme", updatedAt: at(5) }]);
  });
});

describe("suggested values", () => {
  const seed = Effect.gen(function* () {
    yield* insertTeam(CHECKOUT, "Checkout revamp");
    yield* insertTeam(SEARCH, "Search");
    yield* insertTicket({
      key: "a",
      person: "Omar",
      fields: [
        { key: "team", text: CHECKOUT },
        { key: "priority", text: "p1" },
        { key: "owner", text: "Mei" },
      ],
    });
    yield* insertTicket({
      key: "b",
      person: "Omar",
      fields: [
        { key: "team", text: CHECKOUT },
        { key: "priority", text: "p2" },
        { key: "owner", text: "Marie" },
      ],
    });
    const c = yield* insertTicket({ key: "c", fields: [{ key: "team", text: SEARCH }] });
    yield* raise(c, REVIEW, 2, "Mei");
  });

  const suggest = (key: string, prefix: string, extra: object = {}) =>
    run(() =>
      Effect.gen(function* () {
        yield* seed;
        return (yield* inbox.suggestInboxValues(environment(9), {
          list: everything,
          key,
          prefix,
          ...extra,
        })).values;
      }),
    );

  it("suggests the values of a field, most common first, matching the prefix of the label", async () => {
    expect((await suggest("team", "")).map((value) => [value.label, value.count])).toEqual([
      ["Checkout revamp", 2],
      ["Search", 1],
    ]);
    expect((await suggest("team", "chec")).map((value) => value.value)).toEqual([CHECKOUT]);
    expect((await suggest("owner", "ma")).map((value) => value.label).sort()).toEqual(["Marie"]);
    expect((await suggest("owner", "m")).map((value) => value.label).sort()).toEqual([
      "Marie",
      "Mei",
    ]);
  });

  it("also suggests the known records of a facet that nothing of yours holds, with count 0", async () => {
    const run2 = (extra: object, prefix: string) =>
      run(() =>
        Effect.gen(function* () {
          yield* seed;
          yield* insertTeam("acme:team:pay", "Payments");
          return (yield* inbox.suggestInboxValues(environment(9), {
            list: everything,
            key: "team",
            prefix,
            ...extra,
          })).values;
        }),
      );
    expect((await run2({}, "pay")).map((value) => [value.label, value.count])).toEqual([
      ["Payments", 0],
    ]);
    expect((await run2({ connectionId: ACCOUNT_A }, "pay")).map((value) => value.label)).toEqual([
      "Payments",
    ]);
    // Account B does not observe the record, so it cannot offer it.
    expect(await run2({ connectionId: ACCOUNT_B }, "pay")).toEqual([]);
  });

  it("suggests enum values by their label, and the core keys", async () => {
    expect((await suggest("priority", "urg")).map((value) => [value.value, value.label])).toEqual([
      ["p1", "Urgent"],
    ]);
    expect((await suggest("from", "")).map((value) => [value.label, value.count])).toEqual([
      ["Omar", 2],
      ["Mei", 1],
    ]);
    expect((await suggest("signal", "")).map((value) => value.label)).toEqual(["review request"]);
    expect((await suggest("source", "")).map((value) => value.value)).toEqual(["acme"]);
    expect((await suggest("account", "")).map((value) => value.value)).toEqual(["work"]);
    expect(await suggest("size", "")).toEqual([]);
  });

  it("limits the suggestions to the scope and at most 8", async () => {
    const scoped = await run(() =>
      Effect.gen(function* () {
        yield* seed;
        for (let index = 0; index < 12; index++) {
          yield* insertTicket({
            key: `x${index}`,
            fields: [{ key: "owner", text: `Zed ${index}` }],
          });
        }
        return {
          waiting: (yield* inbox.suggestInboxValues(environment(9), {
            list: { savedQuery: "waits" },
            key: "team",
            prefix: "",
          })).values,
          many: (yield* inbox.suggestInboxValues(environment(9), {
            list: everything,
            key: "owner",
            prefix: "zed",
          })).values,
          other: (yield* inbox.suggestInboxValues(environment(9), {
            list: everything,
            key: "team",
            prefix: "",
            source: "other",
          })).values,
        };
      }),
    );
    // The thing that waits holds Search; Checkout is a known record that nothing in the scope holds.
    expect(scoped.waiting.map((value) => [value.value, value.count])).toEqual([
      [SEARCH, 1],
      [CHECKOUT, 0],
    ]);
    expect(scoped.many).toHaveLength(8);
    expect(scoped.other).toEqual([]);
  });
});

describe("signals by noun, readable records and plugin saved queries", () => {
  /** Writes a thing of another source, `beta`, that concerns the user. Returns its ref. */
  const insertBetaIssue = (key: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ref = `beta:issue:${key}`;
      yield* sql`
        INSERT INTO external_entities
          (id, ref, kind, noun, card, pace, patience, completeness, identifier, title, url,
           lifecycle, source_updated_at, first_observed_at, updated_at)
        VALUES (${mintUuid()}, ${ref}, 'beta/issue', 'Issue', 'compact', 'fast', 24, 'full',
          ${key}, ${`Issue ${key}`}, ${`https://beta.example/${key}`}, 'open',
          ${at(1)}, ${at(1)}, ${at(1)})`;
      yield* sql`
        INSERT INTO external_entity_observations (ref, connection_id, concerns, access)
        VALUES (${ref}, ${uuidFromString(ACCOUNT_A)}, '["assigned"]', 'ok')`;
      return ref;
    });

  it("matches a signal clause by the kind's noun and suggests signals by their noun", async () => {
    const found = await run(() =>
      Effect.gen(function* () {
        const a = yield* insertTicket({ key: "a" });
        yield* insertTicket({ key: "b" });
        yield* raise(a, REVIEW, 2);
        return {
          byNoun: refsOf(
            yield* list(9, withClause({ key: "signal", op: "is", value: "Review Request" })),
          ),
          suggested: (yield* inbox.suggestInboxValues(environment(9), {
            list: everything,
            key: "signal",
            prefix: "review r",
          })).values,
          byWord: (yield* inbox.suggestInboxValues(environment(9), {
            list: everything,
            key: "signal",
            prefix: "rev",
          })).values,
        };
      }),
    );
    expect(found.byNoun).toEqual(["a"]);
    expect(found.suggested.map((value) => [value.value, value.label])).toEqual([
      [REVIEW, "review request"],
    ]);
    expect(found.byWord.map((value) => value.value)).toEqual([REVIEW]);
  });

  it("does not match an account that was refused and holds no concern", async () => {
    const found = await run(() =>
      Effect.gen(function* () {
        const ref = yield* insertTicket({
          key: "a",
          accounts: [ACCOUNT_A, ACCOUNT_B],
          concerns: [],
        });
        yield* raise(ref, REVIEW, 2);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE external_entity_observations SET access = 'inaccessible'
          WHERE ref = ${ref} AND connection_id = ${uuidFromString(ACCOUNT_B)}`;
        return {
          refused: refsOf(yield* list(9, withClause({ key: "account", op: "is", value: "home" }))),
          reading: refsOf(yield* list(9, withClause({ key: "account", op: "is", value: "work" }))),
        };
      }),
    );
    expect(found.refused).toEqual([]);
    expect(found.reading).toEqual(["a"]);
  });

  it("names a record nobody can read by its kind, and lists no unreadable known record", async () => {
    const outline = await run(({ sql }) =>
      Effect.gen(function* () {
        yield* insertTeam(CHECKOUT, "Checkout revamp");
        yield* insertTeam(SEARCH, "Search");
        yield* insertTicket({ key: "a", fields: [{ key: "team", text: CHECKOUT }] });
        // Nobody reads Search any more.
        yield* sql`UPDATE external_entity_observations SET access = 'inaccessible'
          WHERE ref = ${SEARCH}`;
        yield* insertTicket({
          key: "b",
          accounts: [ACCOUNT_B],
          fields: [{ key: "team", text: "acme:team:hidden" }],
        });
        yield* sql`
          INSERT INTO external_entities
            (id, ref, kind, noun, pace, completeness, title, first_observed_at, updated_at)
          VALUES (${mintUuid()}, 'acme:team:hidden', ${TEAM_KIND}, 'Team', 'context', 'full',
            'Secret team', ${at(1)}, ${at(1)})`;
        return yield* inbox.readInboxOutline(environment(9), {
          pins: [{ source: "acme", key: "team", value: "acme:team:hidden" }],
          browseFolded: [],
        });
      }),
    );
    const teams = outline.sources[0]!.facets!.filter((facet) => facet.key === "team");
    const labels = teams.flatMap((facet) => facet.values.map((value) => value.label));
    expect(labels).toContain("Checkout revamp");
    expect(labels).toContain("A team you cannot open");
    // Neither the title nor the ref of an unreadable record shows, and Search is not listed.
    expect(labels).not.toContain("Secret team");
    expect(labels).not.toContain("Search");
    expect(labels.filter((label) => label.startsWith("acme:"))).toEqual([]);
    expect(outline.pins[0]!.label).toBe("A team you cannot open");
  });

  it("ties a plugin's saved query to its own source", async () => {
    const found = await run(() =>
      Effect.gen(function* () {
        yield* insertTicket({ key: "a" });
        yield* insertBetaIssue("1");
        const saved = {
          id: "acme/quiet",
          source: "acme",
          name: "Quiet",
          order: "newest" as const,
          clauses: [{ key: "asks", op: "is", value: false } satisfies InboxClause],
        };
        const withQuery = environment(9, { savedQueries: [saved] });
        const outline = yield* inbox.readInboxOutline(withQuery, {
          pins: [],
          browseFolded: [],
        });
        return {
          page: refsOf(yield* inbox.queryInbox(withQuery, { list: { savedQuery: "acme/quiet" } })),
          counted: outline.savedQueries.find((query) => query.id === "acme/quiet")!.count,
          everything: outline.savedQueries.find((query) => query.id === "everything")!.count,
        };
      }),
    );
    expect(found.page).toEqual(["a"]);
    expect(found.counted).toBe(1);
    expect(found.everything).toBe(2);
  });

  it("labels the pin of an enum value by the value's label", async () => {
    const pins = await run(() =>
      Effect.gen(function* () {
        yield* insertTicket({ key: "a", fields: [{ key: "priority", text: "p1" }] });
        return (yield* inbox.readInboxOutline(environment(9), {
          pins: [{ source: "acme", key: "priority", value: "p1" }],
          browseFolded: [],
        })).pins;
      }),
    );
    expect(pins).toMatchObject([{ label: "Urgent", count: 1 }]);
  });

  it("answers an empty first page with a total of zero and no second count", async () => {
    const found = await run(() =>
      Effect.gen(function* () {
        const statements: Array<string> = [];
        const record = Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile()[0]);
            return statement;
          }),
        );
        const page = yield* list(9).pipe(record);
        return {
          page,
          counts: statements.filter((text) => text.includes("COUNT(*) AS n FROM matched")),
        };
      }),
    );
    expect(found.page.total).toBe(0);
    expect(found.counts).toEqual([]);
  });
});

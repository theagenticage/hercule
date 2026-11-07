/**
 * Tests the reads of links against a migrated database, with an invented
 * tracker: tickets (a compact, fast kind) and epics (a rich, slow kind).
 *
 * - the Inbox: who rides on whom, the Requests count, the links and peers of
 *   a page, and the number of statements
 * - the pairs of Tasks that Work may draw as a stack
 *
 * Which lead is the most pressing is decided by the pure `decideRiding` and is
 * tested in `riding.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { MAX_BOARD_STACK_CANDIDATES, MAX_INBOX_CARDS } from "@hercule/contract";
import { uuidFromString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { taskRepository } from "../tasks";
import { externalEntityRepository, type ObservedEntity } from "./repository";
import type { EntitySlots, FullEntityObservation } from "./slots";

const BASE = Date.parse("2026-03-01T00:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number): string => new Date(BASE + minutes * MINUTE).toISOString();

const PLUGIN = "acme-tracker";
const TICKET_KIND = "acme-tracker/ticket";
const EPIC_KIND = "acme-tracker/epic";
const ACCOUNT = "0190c000-0000-7000-8000-0000000000a1";

const ticketRef = (name: string) => `acme-tracker:ticket:${name}`;
const epicRef = (name: string) => `acme-tracker:epic:${name}`;

const TICKET_SLOTS: EntitySlots = {
  noun: "Ticket",
  card: "compact",
  pace: "fast",
  patience: 24,
  identifier: "T",
  facts: [],
};
const EPIC_SLOTS: EntitySlots = {
  noun: "Epic",
  card: "rich",
  pace: "slow",
  patience: 336,
  identifier: "E",
  facts: [],
};

/** Builds the observation of a ticket, concerning the user unless told otherwise. */
const ticket = (name: string, options: Partial<FullEntityObservation> = {}): ObservedEntity => ({
  kind: TICKET_KIND,
  slots: TICKET_SLOTS,
  observation: {
    kind: "ticket",
    ref: ticketRef(name),
    title: `Ticket ${name}`,
    url: `https://tracker.example/${name}`,
    lifecycle: "open",
    fields: {},
    concerns: ["assigned"],
    sourceUpdatedAt: at(1),
    ...options,
  },
});

/** Builds the observation of an epic. It reports `linked` tickets as its own source claims. */
const epic = (name: string, linked: ReadonlyArray<string> = []): ObservedEntity => ({
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
    relations: { complete: true, partOf: [], linked },
  },
});

const environment = (minutes: number) => ({ now: at(minutes), activePluginIds: [PLUGIN] });

/** Runs `body` on a fresh migrated database with one Connection, in one transaction. */
const run = <A>(
  body: (context: {
    readonly repository: Effect.Success<typeof externalEntityRepository>;
    readonly sql: SqlClient.SqlClient;
    readonly reconcile: (
      kind: string,
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
      yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
          status, labels, config, created_at, updated_at)
        VALUES (${uuidFromString(ACCOUNT)}, ${PLUGIN}, 'acme-tracker/account', 'a', 'a', 'a',
          'connected', '[]', '{}', ${at(0)}, ${at(0)})`;
      const repository = yield* externalEntityRepository;
      const reconcile = (kind: string, observed: ReadonlyArray<ObservedEntity>, minutes: number) =>
        repository.reconcile({
          connectionId: ACCOUNT,
          kind,
          complete: true,
          observed,
          actor: `plugin:${PLUGIN}`,
          environment: environment(minutes),
        });
      return yield* body({ repository, sql, reconcile });
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

/** Stores a claim between two refs that a person or a hint made, which a reconcile cannot write. */
const insertClaim = (
  sql: SqlClient.SqlClient,
  claim: {
    readonly from: string;
    readonly to: string;
    readonly type: "person" | "text";
  },
) =>
  claim.type === "person"
    ? sql`INSERT INTO external_entity_relation_claims
        (from_ref, relation, to_ref, claim_type, actor, evidence_key, state, observed_at)
        VALUES (${claim.from}, 'linked', ${claim.to}, 'person', 'user', '', 'current', ${at(1)})`
    : sql`INSERT INTO external_entity_relation_claims
        (from_ref, relation, to_ref, claim_type, connection_id, evidence_key, state, observed_at)
        VALUES (${claim.from}, 'linked', ${claim.to}, 'text', ${uuidFromString(ACCOUNT)},
          'description', 'current', ${at(1)})`;

/** Makes a live Task that links every one of `refs`, and returns its id. */
const makeTaskLinking = (refs: ReadonlyArray<string>, minutes: number) =>
  Effect.gen(function* () {
    const tasks = yield* taskRepository;
    const task = yield* tasks.insert({
      title: `Work on ${refs.join(" and ")}`,
      description: "",
      status: "open",
      stage: "planned",
      priority: "normal",
      labels: [],
      projectId: undefined,
      provenance: refs.map((ref) => ({ ref })),
      at: at(minutes),
      actor: "user",
    });
    return task.id;
  });

describe("riding on the Inbox", () => {
  it("rides a ticket on the epic that reports it, and leaves it out of Requests, the same in the page and the count", async () => {
    const { inbox, counts } = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1"), ticket("t2")], 1);
        yield* reconcile(EPIC_KIND, [epic("e1", [ticketRef("t1")])], 2);
        return {
          inbox: yield* repository.queryInbox(environment(3)),
          counts: yield* repository.countInbox(at(3)),
        };
      }),
    );
    const ridesOn = new Map(inbox.cards.map((card) => [card.ref, card.ridesOn]));
    expect(ridesOn.get(ticketRef("t1"))).toBe(epicRef("e1"));
    expect(ridesOn.get(ticketRef("t2"))).toBeUndefined();
    expect(ridesOn.get(epicRef("e1"))).toBeUndefined();
    // t2 stays in Requests. t1 rides, and still has its clock.
    expect(inbox.counts).toMatchObject({ requests: 1, onTheClock: 2 });
    expect(counts).toEqual(inbox.counts);
    expect(inbox.links.map((link) => [link.fromRef, link.toRef, link.claim.type])).toEqual([
      [epicRef("e1"), ticketRef("t1"), "source"],
    ]);
  });

  it("rides on a person's link too, and a hint rides on nothing but shows as a link with its text", async () => {
    const inbox = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1"), ticket("t2")], 1);
        yield* reconcile(EPIC_KIND, [epic("e1")], 2);
        yield* insertClaim(sql, { from: ticketRef("t1"), to: epicRef("e1"), type: "person" });
        yield* insertClaim(sql, { from: ticketRef("t2"), to: epicRef("e1"), type: "text" });
        return yield* repository.queryInbox(environment(3));
      }),
    );
    const ridesOn = new Map(inbox.cards.map((card) => [card.ref, card.ridesOn]));
    expect(ridesOn.get(ticketRef("t1"))).toBe(epicRef("e1"));
    expect(ridesOn.get(ticketRef("t2"))).toBeUndefined();
    expect(inbox.counts.requests).toBe(1);
    const hint = inbox.links.find((link) => link.fromRef === ticketRef("t2"));
    expect(hint?.claim).toEqual({ type: "text", plugin: PLUGIN, evidenceKey: "description" });
  });

  it("stands a ticket alone when its only lead is dismissed", async () => {
    const inbox = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1")], 1);
        yield* reconcile(EPIC_KIND, [epic("e1", [ticketRef("t1")])], 2);
        const before = yield* repository.queryInbox(environment(3));
        const lead = before.cards.find((card) => card.ref === epicRef("e1"))!;
        yield* repository.dismiss(lead.id, "user", at(4));
        return yield* repository.queryInbox(environment(5));
      }),
    );
    expect(inbox.cards.map((card) => [card.ref, card.ridesOn])).toEqual([
      [ticketRef("t1"), undefined],
    ]);
    expect(inbox.counts.requests).toBe(1);
  });

  it("keeps a ticket a live Task holds on the with-someone-else side, counted there, with its link in the page", async () => {
    const inbox = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1")], 1);
        yield* reconcile(EPIC_KIND, [epic("e1", [ticketRef("t1")])], 2);
        yield* makeTaskLinking([ticketRef("t1")], 3);
        return yield* repository.queryInbox(environment(4));
      }),
    );
    const held = inbox.cards.find((card) => card.ref === ticketRef("t1"))!;
    expect(held.side).toBe("with-someone-else");
    expect(held.ridesOn).toBeUndefined();
    expect(inbox.counts).toMatchObject({ requests: 0, withSomeoneElse: 1 });
    expect(inbox.links).toHaveLength(1);
  });

  it("keeps a rider's ride when the page limit cuts its lead: the rider leaves the page with it, so Requests cards and the count agree", async () => {
    const riders = MAX_INBOX_CARDS;
    const inbox = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        // "solo" is the oldest card and rides on nothing. The riders fill the rest of the page.
        // A complete inventory forgets what it leaves out, so each reconcile lists all it keeps.
        yield* reconcile(TICKET_KIND, [ticket("solo")], 1);
        yield* reconcile(
          TICKET_KIND,
          [ticket("solo"), ...Array.from({ length: riders }, (_, index) => ticket(`t${index}`))],
          2,
        );
        // The epic is the newest card, so the page of 1000 leaves it out.
        yield* reconcile(EPIC_KIND, [epic("e1")], 3);
        yield* sql`INSERT INTO external_entity_relation_claims
          (from_ref, relation, to_ref, claim_type, actor, evidence_key, state, observed_at)
          SELECT ref, 'linked', ${epicRef("e1")}, 'person', 'user', '', 'current', ${at(4)}
          FROM external_entities WHERE kind = ${TICKET_KIND} AND ref <> ${ticketRef("solo")}`;
        return yield* repository.queryInbox(environment(5));
      }),
    );
    expect(inbox.truncated).toBe(true);
    expect(inbox.cards.map((card) => card.ref)).toEqual([ticketRef("solo")]);
    expect(inbox.cards.filter((card) => card.side === "requests")).toHaveLength(
      inbox.counts.requests,
    );
    expect(inbox.counts.requests).toBe(1);
  });

  it("sends the same number of statements for 2 riders as for 40", async () => {
    const countStatements = (riders: number) =>
      run(({ repository, reconcile }) =>
        Effect.gen(function* () {
          const names = Array.from({ length: riders }, (_, index) => `t${index}`);
          yield* reconcile(
            TICKET_KIND,
            names.map((name) => ticket(name)),
            1,
          );
          yield* reconcile(EPIC_KIND, [epic("e1", names.map(ticketRef))], 2);
          const statements: Array<string> = [];
          const inbox = yield* repository.queryInbox(environment(3)).pipe(
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
    const small = await countStatements(2);
    const large = await countStatements(40);
    expect(large.inbox.cards.filter((card) => card.ridesOn !== undefined)).toHaveLength(40);
    expect(large.inbox.links).toHaveLength(40);
    expect(large.statements).toHaveLength(small.statements.length);
  });
});

describe("links and peers", () => {
  it("lists the far end that has no card as a peer, and leaves out a pending target", async () => {
    const inbox = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        // t2 is a full record that concerns nobody, so it has no card.
        yield* reconcile(TICKET_KIND, [ticket("t1"), ticket("t2", { concerns: [] })], 1);
        yield* insertClaim(sql, { from: ticketRef("t1"), to: ticketRef("t2"), type: "person" });
        yield* insertClaim(sql, {
          from: ticketRef("t1"),
          to: "unresolved:acme-tracker:ticket:SHOP/12",
          type: "person",
        });
        return yield* repository.queryInbox(environment(2));
      }),
    );
    expect(inbox.links.map((link) => link.toRef)).toEqual([ticketRef("t2")]);
    expect(inbox.peers).toHaveLength(1);
    expect(inbox.peers[0]).toMatchObject({
      ref: ticketRef("t2"),
      noun: "Ticket",
      title: "Ticket t2",
      yours: false,
      restricted: false,
    });
    expect(inbox.peers[0]!.id).toEqual(expect.any(String));
  });

  it("gives a restricted peer only its ref, kind and noun", async () => {
    const inbox = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1"), ticket("t2", { concerns: [] })], 1);
        yield* repository.reportMissing({
          connectionId: ACCOUNT,
          ref: ticketRef("t2"),
          reason: "inaccessible",
          environment: environment(2),
        });
        yield* insertClaim(sql, { from: ticketRef("t1"), to: ticketRef("t2"), type: "person" });
        return yield* repository.queryInbox(environment(3));
      }),
    );
    expect(inbox.peers).toEqual([
      {
        ref: ticketRef("t2"),
        kind: TICKET_KIND,
        noun: "Ticket",
        yours: false,
        restricted: true,
      },
    ]);
  });

  it("gives a card no peer for a link between two cards, and one link for a pair claimed twice", async () => {
    const inbox = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1")], 1);
        yield* reconcile(EPIC_KIND, [epic("e1", [ticketRef("t1")])], 2);
        yield* insertClaim(sql, { from: ticketRef("t1"), to: epicRef("e1"), type: "text" });
        return yield* repository.queryInbox(environment(3));
      }),
    );
    expect(inbox.peers).toEqual([]);
    // The source's claim is firmer than the hint, and carries no evidence key.
    expect(inbox.links).toEqual([
      {
        fromRef: epicRef("e1"),
        toRef: ticketRef("t1"),
        claim: { type: "source", plugin: PLUGIN },
      },
    ]);
  });

  it("gives a locked row to a link target that no Connection ever read, named by the kind that owns its ref", async () => {
    const ghost = ticketRef("ghost");
    const kinds = [{ kind: TICKET_KIND, noun: "Ticket", refPrefix: "acme-tracker:ticket:" }];
    const outcome = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1")], 1);
        yield* insertClaim(sql, { from: ticketRef("t1"), to: ghost, type: "person" });
        yield* insertClaim(sql, { from: ticketRef("t1"), to: "other:thing:9", type: "person" });
        return {
          named: yield* repository.queryInbox({ ...environment(2), activeEntityKinds: kinds }),
          anonymous: yield* repository.queryInbox(environment(2)),
        };
      }),
    );
    // The ref no active kind owns is left out, and so is every ref when no kinds are given.
    expect(outcome.named.peers).toEqual([
      { ref: ghost, kind: TICKET_KIND, noun: "Ticket", yours: false, restricted: true },
    ]);
    expect(outcome.anonymous.peers).toEqual([]);
  });

  it("keeps every peer's access apart when many peers have several observations", async () => {
    const outcome = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        const names = Array.from({ length: 30 }, (_, index) => `p${index}`);
        yield* reconcile(
          TICKET_KIND,
          [ticket("t1"), ...names.map((name) => ticket(name, { concerns: [] }))],
          1,
        );
        for (const name of names.filter((_, index) => index % 2 === 1)) {
          yield* repository.reportMissing({
            connectionId: ACCOUNT,
            ref: ticketRef(name),
            reason: "inaccessible",
            environment: environment(2),
          });
          yield* insertClaim(sql, { from: ticketRef("t1"), to: ticketRef(name), type: "person" });
        }
        for (const name of names.filter((_, index) => index % 2 === 0)) {
          yield* insertClaim(sql, { from: ticketRef("t1"), to: ticketRef(name), type: "person" });
        }
        return yield* repository.queryInbox(environment(3));
      }),
    );
    const restricted = outcome.peers.filter((peer) => peer.restricted).map((peer) => peer.ref);
    expect(outcome.peers).toHaveLength(30);
    expect(restricted.sort()).toEqual(
      Array.from({ length: 15 }, (_, index) => ticketRef(`p${index * 2 + 1}`)).sort(),
    );
  });

  it("stops naming a linked thing in the timeline when it becomes inaccessible", async () => {
    const outcome = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const linkedTo = { complete: true, partOf: [], linked: [ticketRef("t2")] };
        yield* reconcile(TICKET_KIND, [ticket("t1"), ticket("t2", { concerns: [] })], 1);
        yield* reconcile(
          TICKET_KIND,
          [
            ticket("t1", { relations: linkedTo, sourceUpdatedAt: at(2) }),
            ticket("t2", { concerns: [] }),
          ],
          3,
        );
        const readDetail = (minutes: number) =>
          Effect.gen(function* () {
            const inbox = yield* repository.queryInbox(environment(minutes));
            const detail = yield* repository.readEntity(inbox.cards[0]!.id, {
              ...environment(minutes),
              activeKinds: new Set([TICKET_KIND]),
            });
            return {
              timeline: detail._tag === "Some" ? detail.value.timeline : [],
              latestChange: inbox.cards[0]!.latestChange,
            };
          });
        const open = yield* readDetail(4);
        yield* repository.reportMissing({
          connectionId: ACCOUNT,
          ref: ticketRef("t2"),
          reason: "inaccessible",
          environment: environment(5),
        });
        return { open, locked: yield* readDetail(6) };
      }),
    );
    expect(outcome.open.timeline.map((change) => change.say.say)).toEqual(["Linked T"]);
    expect(outcome.open.latestChange?.say.say).toBe("Linked T");
    const locked = ["Linked a ticket you cannot open"];
    expect(outcome.locked.timeline.map((change) => change.say.say)).toEqual(locked);
    expect(outcome.locked.timeline[0]!.ref).toBe(ticketRef("t2"));
    expect(outcome.locked.latestChange?.say.say).toBe(locked[0]);
  });

  it("gives the detail the same peers", async () => {
    const detail = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1"), ticket("t2", { concerns: [] })], 1);
        yield* insertClaim(sql, { from: ticketRef("t1"), to: ticketRef("t2"), type: "person" });
        const inbox = yield* repository.queryInbox(environment(2));
        const id = inbox.cards[0]!.id;
        return {
          inbox,
          detail: yield* repository.readEntity(id, {
            ...environment(2),
            activeKinds: new Set([TICKET_KIND]),
          }),
        };
      }),
    );
    expect(detail.detail._tag).toBe("Some");
    if (detail.detail._tag === "Some") {
      expect(detail.detail.value.peers).toEqual(detail.inbox.peers);
    }
  });
});

describe("stack candidates on Work", () => {
  it("pairs the Task of a ticket with the Tasks of the pull requests it reports", async () => {
    const result = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1"), ticket("t2")], 1);
        yield* reconcile(EPIC_KIND, [epic("e1", [ticketRef("t1"), ticketRef("t2")])], 2);
        const lead = yield* makeTaskLinking([epicRef("e1")], 3);
        const first = yield* makeTaskLinking([ticketRef("t1")], 4);
        const second = yield* makeTaskLinking([ticketRef("t2")], 5);
        const found = yield* repository.listStackCandidates([lead, first, second]);
        return { lead, first, second, found };
      }),
    );
    const { lead, first, second } = result;
    expect(result.found.truncated).toBe(false);
    expect(result.found.candidates).toHaveLength(2);
    expect(result.found.candidates).toEqual(
      expect.arrayContaining([
        { leadTaskId: lead, memberTaskId: first, noun: "Ticket" },
        { leadTaskId: lead, memberTaskId: second, noun: "Ticket" },
      ]),
    );
  });

  it("makes no candidate for a Task that links both things, and one for a pair found through two links", async () => {
    const result = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1"), ticket("t2")], 1);
        yield* reconcile(EPIC_KIND, [epic("e1", [ticketRef("t1"), ticketRef("t2")])], 2);
        const both = yield* makeTaskLinking([epicRef("e1"), ticketRef("t1")], 3);
        const alone = yield* repository.listStackCandidates([both]);

        const lead = yield* makeTaskLinking([epicRef("e1")], 4);
        const member = yield* makeTaskLinking([ticketRef("t1"), ticketRef("t2")], 5);
        const twice = yield* repository.listStackCandidates([lead, member]);
        return { alone, twice, lead, member };
      }),
    );
    expect(result.alone.candidates).toEqual([]);
    expect(result.twice.candidates).toEqual([
      { leadTaskId: result.lead, memberTaskId: result.member, noun: "Ticket" },
    ]);
  });

  it("never stacks on a hint, on two rich things, or on a Task outside the board", async () => {
    const result = await run(({ repository, reconcile, sql }) =>
      Effect.gen(function* () {
        yield* reconcile(TICKET_KIND, [ticket("t1"), ticket("t2")], 1);
        yield* reconcile(EPIC_KIND, [epic("e1", [ticketRef("t2")]), epic("e2")], 2);
        yield* insertClaim(sql, { from: ticketRef("t1"), to: epicRef("e1"), type: "text" });
        yield* insertClaim(sql, { from: epicRef("e2"), to: epicRef("e1"), type: "person" });
        const lead = yield* makeTaskLinking([epicRef("e1")], 3);
        const hinted = yield* makeTaskLinking([ticketRef("t1")], 4);
        const otherRich = yield* makeTaskLinking([epicRef("e2")], 5);
        const offBoard = yield* makeTaskLinking([ticketRef("t2")], 6);
        return yield* repository
          .listStackCandidates([lead, hinted, otherRich])
          .pipe(Effect.map((found) => ({ found, offBoard })));
      }),
    );
    expect(result.found.candidates).toEqual([]);
  });

  it("returns at most MAX_BOARD_STACK_CANDIDATES pairs and says there are more", async () => {
    const result = await run(({ repository, reconcile }) =>
      Effect.gen(function* () {
        const names = Array.from({ length: MAX_BOARD_STACK_CANDIDATES + 1 }, (_, n) => `t${n}`);
        yield* reconcile(
          TICKET_KIND,
          names.map((name) => ticket(name)),
          1,
        );
        yield* reconcile(EPIC_KIND, [epic("e1", names.map(ticketRef))], 2);
        const lead = yield* makeTaskLinking([epicRef("e1")], 3);
        const members: Array<string> = [];
        for (const name of names) members.push(yield* makeTaskLinking([ticketRef(name)], 4));
        const exact = yield* repository.listStackCandidates([lead, ...members.slice(1)]);
        const over = yield* repository.listStackCandidates([lead, ...members]);
        return { exact, over };
      }),
    );
    expect(result.exact.candidates).toHaveLength(MAX_BOARD_STACK_CANDIDATES);
    expect(result.exact.truncated).toBe(false);
    expect(result.over.candidates).toHaveLength(MAX_BOARD_STACK_CANDIDATES);
    expect(result.over.truncated).toBe(true);
  });
});

/**
 * Tests the adapter that answers the signals domain's `SignalEntities` port,
 * over the real External Entity records on a migrated database: a signal's
 * thread finds the entity of a work kind and only that, and a signal that
 * lands on an entity that is off the clock makes it an arrival.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Signal } from "@hercule/contract";
import { uuidFromString } from "../../db";
import { inTransaction, TestDatabase } from "../../db/testing";
import { externalEntityRepository, type ObservedEntity } from "../../external-entities";
import { SignalEntities, signalRepository } from "../../signals";
import { SignalEntitiesLayer } from "./signal-entities";

const PLUGIN = "acme-tracker";
const CONNECTION_ID = "0190c000-0000-7000-8000-0000000000a1";
const AT = "2026-03-01T00:00:00.000Z";
const TICKET = "acme-tracker:ticket:t1";
const PROJECT = "acme-tracker:project:harbour";

/** A ticket nobody is assigned: a work kind that is off the clock until a signal puts it on. */
const UNASSIGNED_TICKET: ObservedEntity = {
  kind: "acme-tracker/ticket",
  slots: {
    noun: "Ticket",
    card: "compact",
    pace: "fast",
    patience: 24,
    identifier: "T1",
    facts: [],
  },
  observation: {
    kind: "ticket",
    ref: TICKET,
    title: "Ticket t1",
    url: "https://tracker.example/t1",
    lifecycle: "open",
    fields: {},
    concerns: [],
    sourceUpdatedAt: AT,
  },
};

/** A project: a place, which has no card. */
const HARBOUR: ObservedEntity = {
  kind: "acme-tracker/project",
  slots: { noun: "Project", pace: "context", caption: "Tracker project" },
  observation: {
    kind: "project",
    ref: PROJECT,
    title: "Harbour",
    fields: {},
    concerns: [],
    sourceUpdatedAt: AT,
  },
};

const buildSignal = (id: string, threadRef: string): Signal => ({
  id,
  kind: "acme-tracker/mentioned",
  origin: { type: "event", eventId: 1, connectionId: CONNECTION_ID, threadRef },
  title: "Mentioned",
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: AT,
});

const runWithEntities = <A>(
  body: Effect.Effect<A, unknown, SqlClient.SqlClient | SignalEntities>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
        VALUES (${PLUGIN}, 1, '{}', ${AT}, ${AT})`;
      yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
          status, labels, config, created_at, updated_at)
        VALUES (${uuidFromString(CONNECTION_ID)}, ${PLUGIN}, ${`${PLUGIN}/account`}, 'a', 'a', 'a',
          'connected', '[]', '{}', ${AT}, ${AT})`;
      const repository = yield* externalEntityRepository;
      for (const observed of [UNASSIGNED_TICKET, HARBOUR]) {
        yield* repository.reconcile({
          connectionId: CONNECTION_ID,
          kind: observed.kind,
          complete: true,
          observed: [observed],
          actor: `plugin:${PLUGIN}`,
          environment: { now: AT, activePluginIds: [PLUGIN] },
        });
      }
      return yield* body;
    }).pipe(
      inTransaction,
      Effect.provide(SignalEntitiesLayer),
      Effect.provide(TestDatabase),
      Effect.orDie,
    ),
  );

describe("the Signal Entities port", () => {
  it("returns the entity of a work kind by ref, and leaves out a place and an unknown ref", async () => {
    const found = await runWithEntities(
      Effect.flatMap(SignalEntities, (entities) =>
        entities.readByRefs([TICKET, PROJECT, "acme-tracker:ticket:unknown"]),
      ),
    );

    expect([...found.keys()]).toEqual([TICKET]);
    expect(found.get(TICKET)).toMatchObject({
      kind: "acme-tracker/ticket",
      identifier: "T1",
      title: "Ticket t1",
    });
  });

  it("makes an entity that no one concerns an arrival when an open signal lands on it, and does nothing for a place", async () => {
    const arrivals = await runWithEntities(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const signals = yield* signalRepository;
        const entities = yield* SignalEntities;
        const readArrivals = Effect.map(
          sql<{ readonly ref: string; readonly arrival_sequence: number | null }>`
            SELECT ref, arrival_sequence FROM external_entities ORDER BY ref`,
          (rows) => rows.map((row) => [row.ref, row.arrival_sequence] as const),
        );
        const before = yield* readArrivals;
        yield* signals.insert(buildSignal("0199e0e7-0005-7000-8000-000000000001", TICKET), []);
        yield* entities.recordArrival(TICKET);
        yield* signals.insert(buildSignal("0199e0e7-0005-7000-8000-000000000002", PROJECT), []);
        yield* entities.recordArrival(PROJECT);
        return { before, after: yield* readArrivals };
      }),
    );

    expect(arrivals.before).toEqual([
      [PROJECT, null],
      [TICKET, null],
    ]);
    expect(arrivals.after).toEqual([
      [PROJECT, null],
      [TICKET, expect.any(Number)],
    ]);
  });
});

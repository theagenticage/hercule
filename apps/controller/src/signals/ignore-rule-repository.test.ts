/**
 * Tests the Ignore Rule repository against a migrated test database:
 * rules are written, read, listed oldest first and deleted, and each rule's
 * catches are counted on it. That an event is caught once per kind is tested in
 * `raises.test.ts`, and that a catch outlives its rule in
 * `ignore-rules.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { IgnoreRule } from "@hercule/contract";
import { mintUuid, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { ignoreRuleRepository } from "./ignore-rule-repository";

const KIND = "acme/asked";
const OTHER_KIND = "acme/mentioned";

/**
 * Runs an effect in one transaction on a fresh database, as a service does
 * when it calls the repository.
 */
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(inTransaction(effect), TestDatabase));

/** Builds a rule of `KIND` created at `createdAt`, with a new id. */
const buildRule = (createdAt: string, changes: Partial<IgnoreRule> = {}): IgnoreRule => ({
  id: uuidToString(mintUuid()),
  kind: KIND,
  match: { repo: "acme/webshop", author: "dependabot[bot]" },
  text: "Asked · Repository acme/webshop · Author dependabot[bot]",
  createdAt,
  actor: "user",
  ...changes,
});

/** Writes one event with a dedup key unique to it, and returns its id. */
const insertEvent = (dedupKey: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly id: number }>`
        INSERT INTO events (source, system, kind, occurred_at, received_at, dedup_key, payload)
        VALUES ('acme', 'acme', 'acme.thing.done', '2026-10-12T00:00:00.000Z',
                '2026-10-12T00:00:00.000Z', ${dedupKey}, '{}')
        RETURNING id`,
      (rows) => rows[0]!.id,
    ),
  );

describe("rules", () => {
  it("reads a rule back whole, with its values sorted by name", async () => {
    const rule = buildRule("2026-10-12T10:00:00.000Z");
    const listed = await run(
      Effect.gen(function* () {
        const rules = yield* ignoreRuleRepository;
        yield* rules.insert(rule);
        return yield* rules.list(KIND);
      }),
    );

    expect(listed).toEqual([rule]);
    expect(Object.keys(listed[0]!.match)).toEqual(["author", "repo"]);
  });

  it("lists the rules oldest first, all of them or those of one kind", async () => {
    const newest = buildRule("2026-10-12T12:00:00.000Z");
    const oldest = buildRule("2026-10-12T10:00:00.000Z");
    const other = buildRule("2026-10-12T11:00:00.000Z", { kind: OTHER_KIND });
    const listed = await run(
      Effect.gen(function* () {
        const rules = yield* ignoreRuleRepository;
        for (const rule of [newest, oldest, other]) yield* rules.insert(rule);
        return {
          all: yield* rules.listWithCatches(),
          ofKind: yield* rules.list(KIND),
          ofNoRule: yield* rules.list("acme/unused"),
        };
      }),
    );

    expect(listed.all.map((rule) => rule.id)).toEqual([oldest.id, other.id, newest.id]);
    expect(listed.ofKind.map((rule) => rule.id)).toEqual([oldest.id, newest.id]);
    expect(listed.ofNoRule).toEqual([]);
  });

  it("deletes a rule once and returns it, and returns nothing for it afterwards", async () => {
    const rule = buildRule("2026-10-12T10:00:00.000Z");
    const checked = await run(
      Effect.gen(function* () {
        const rules = yield* ignoreRuleRepository;
        yield* rules.insert(rule);
        const deleted = yield* rules.delete(rule.id);
        const deletedAgain = yield* rules.delete(rule.id);
        return { deleted, deletedAgain, listed: yield* rules.list(KIND) };
      }),
    );

    expect(checked).toEqual({
      deleted: Option.some(rule),
      deletedAgain: Option.none(),
      listed: [],
    });
  });
});

describe("catches", () => {
  it("counts each rule's catches and the time of its last one, and leaves the time out while it caught nothing", async () => {
    const catching = buildRule("2026-10-12T10:00:00.000Z");
    const idle = buildRule("2026-10-12T11:00:00.000Z", { match: { repo: "acme/api" } });
    const listed = await run(
      Effect.gen(function* () {
        const rules = yield* ignoreRuleRepository;
        yield* rules.insert(catching);
        yield* rules.insert(idle);
        for (const [dedupKey, at] of [
          ["k1", "2026-10-12T14:00:00.000Z"],
          ["k2", "2026-10-12T13:00:00.000Z"],
        ] as const) {
          yield* rules.insertCatch({
            eventId: yield* insertEvent(dedupKey),
            ruleId: catching.id,
            kind: KIND,
            ruleText: catching.text,
            at,
          });
        }
        return {
          all: yield* rules.listWithCatches(),
          ofOtherKind: yield* rules.listWithCatches(OTHER_KIND),
        };
      }),
    );

    expect(listed.all).toEqual([
      { ...catching, caughtCount: 2, lastCaughtAt: "2026-10-12T14:00:00.000Z" },
      { ...idle, caughtCount: 0 },
    ]);
    expect(listed.all[1]).not.toHaveProperty("lastCaughtAt");
    expect(listed.ofOtherKind).toEqual([]);
  });
});

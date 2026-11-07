/**
 * Tests the relation claims against a migrated database, with an invented
 * graph: a purchase order delivered in two rounds, both rounds under one site.
 *
 * - writing source claims: repeats, complete and partial reads, two reporters
 * - loops: one reporter and two reporters
 * - the walk up: each ancestor once, the edges, the limits, the statement count
 * - the walk down and the detail read
 * - the query plans of the walks
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { MAX_CONTEXT_DEPTH, MAX_GRAPH_EDGES } from "@hercule/contract";
import { uuidFromString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { relationClaimRepository } from "./relation-claims";

const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

const ORDER = "acme-erp:purchase-order:PO-1";
const ROUND_ONE = "acme-erp:delivery-round:R1";
const ROUND_TWO = "acme-erp:delivery-round:R2";
const SITE = "acme-erp:site:north";

const ERP_ACCOUNT = "0190c000-0000-7000-8000-0000000000c1";
const OTHER_ERP_ACCOUNT = "0190c000-0000-7000-8000-0000000000c2";

/** Runs `body` on a fresh migrated database with two Connections of one plugin. */
const run = <A>(
  body: (
    claims: Effect.Success<typeof relationClaimRepository>,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
        VALUES ('acme-erp', 1, '{}', ${AT}, ${AT})`;
      for (const [id, account] of [
        [ERP_ACCOUNT, "a-1"],
        [OTHER_ERP_ACCOUNT, "a-2"],
      ] as const) {
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (${uuidFromString(id)}, 'acme-erp', 'acme-erp/erp', ${account}, ${account},
            ${account}, 'connected', '[]', '{}', ${AT}, ${AT})`;
      }
      const claims = yield* relationClaimRepository;
      return yield* body(claims, sql);
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

type Claims = Effect.Success<typeof relationClaimRepository>;

/** Reports `partOf` and `linked` from `fromRef` as a complete (default) or partial read. */
const report = (
  claims: Claims,
  connectionId: string,
  fromRef: string,
  partOf: ReadonlyArray<string>,
  options: { complete?: boolean; linked?: ReadonlyArray<string>; now?: string } = {},
) =>
  claims.applySourceRelations({
    connectionId,
    fromRef,
    relations: { complete: options.complete ?? true, partOf, linked: options.linked ?? [] },
    observedRevision: undefined,
    now: options.now ?? AT,
  });

/** Reads the stored claims from `fromRef`, the way a test can see what was kept. */
const readStored = (sql: SqlClient.SqlClient, fromRef: string) =>
  sql<{
    readonly id: number;
    readonly to_ref: string;
    readonly state: string;
    readonly observed_at: string;
    readonly claim_type: string;
  }>`SELECT id, to_ref, state, observed_at, claim_type FROM external_entity_relation_claims
    WHERE from_ref = ${fromRef} ORDER BY to_ref, id`;

describe("writing source claims", () => {
  it("keeps one claim, with its first id and time, when the same observation or a repeated partial read arrives again", async () => {
    const { first, second, third, stored } = await run((claims, sql) =>
      Effect.gen(function* () {
        const first = yield* report(claims, ERP_ACCOUNT, ORDER, [ROUND_ONE, ROUND_TWO]);
        const before = yield* readStored(sql, ORDER);
        const second = yield* report(claims, ERP_ACCOUNT, ORDER, [ROUND_ONE, ROUND_TWO], {
          now: LATER,
        });
        const third = yield* report(claims, ERP_ACCOUNT, ORDER, [ROUND_ONE], {
          complete: false,
          now: LATER,
        });
        const stored = yield* readStored(sql, ORDER);
        return { first, second, third, stored: { before, after: stored } };
      }),
    );

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(third.changed).toBe(false);
    expect(stored.after).toEqual(stored.before);
    expect(stored.after.map((claim) => [claim.to_ref, claim.observed_at])).toEqual([
      [ROUND_ONE, AT],
      [ROUND_TWO, AT],
    ]);
  });

  it("replaces only its own Connection's claims on a complete read", async () => {
    const stored = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, ERP_ACCOUNT, ORDER, [ROUND_ONE, ROUND_TWO]);
        yield* report(claims, OTHER_ERP_ACCOUNT, ORDER, [ROUND_ONE]);
        yield* sql`INSERT INTO external_entity_relation_claims
          (from_ref, relation, to_ref, claim_type, actor, evidence_key, state, observed_at)
          VALUES (${ORDER}, 'part-of', ${SITE}, 'person', 'user', '', 'current', ${AT})`;

        const write = yield* report(claims, ERP_ACCOUNT, ORDER, [ROUND_TWO]);
        const rows = yield* sql<{ readonly to_ref: string; readonly claim_type: string }>`
          SELECT to_ref, claim_type FROM external_entity_relation_claims
          WHERE from_ref = ${ORDER} ORDER BY to_ref, claim_type`;
        return { write, rows };
      }),
    );

    expect(stored.write.changed).toBe(true);
    expect(stored.rows).toEqual([
      // The other Connection still reports round one.
      { to_ref: ROUND_ONE, claim_type: "source" },
      { to_ref: ROUND_TWO, claim_type: "source" },
      { to_ref: SITE, claim_type: "person" },
    ]);
  });

  it("removes nothing on a partial read or when the observation has no relations", async () => {
    const rows = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, ERP_ACCOUNT, ORDER, [ROUND_ONE, ROUND_TWO]);
        const partial = yield* report(claims, ERP_ACCOUNT, ORDER, [], { complete: false });
        yield* claims.applySourceRelations({
          connectionId: ERP_ACCOUNT,
          fromRef: ORDER,
          relations: { complete: false, partOf: [], linked: [] },
          observedRevision: "7",
          now: LATER,
        });
        return { partial, rows: yield* readStored(sql, ORDER) };
      }),
    );

    expect(rows.partial.changed).toBe(false);
    expect(rows.rows.map((claim) => claim.to_ref)).toEqual([ROUND_ONE, ROUND_TWO]);
  });

  it("makes two claims and one link when two Connections report one edge", async () => {
    const { rows, detail } = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, ERP_ACCOUNT, ORDER, [], { linked: [SITE] });
        yield* report(claims, OTHER_ERP_ACCOUNT, ORDER, [], { linked: [SITE] });
        return {
          rows: yield* readStored(sql, ORDER),
          detail: yield* claims.readClaimsFor(ORDER),
        };
      }),
    );

    expect(rows).toHaveLength(2);
    expect(detail.links).toEqual([
      { fromRef: ORDER, toRef: SITE, claim: { type: "source", plugin: "acme-erp" } },
    ]);
  });

  it("shows a pair once under its firmest claim, whichever way the claims point", async () => {
    const detail = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO external_entity_relation_claims
          (from_ref, relation, to_ref, claim_type, connection_id, evidence_key, state, observed_at)
          VALUES (${SITE}, 'linked', ${ORDER}, 'text', ${uuidFromString(ERP_ACCOUNT)}, 'note-1',
                  'current', ${AT})`;
        yield* sql`INSERT INTO external_entity_relation_claims
          (from_ref, relation, to_ref, claim_type, actor, evidence_key, state, observed_at)
          VALUES (${ORDER}, 'linked', ${SITE}, 'person', 'user', '', 'current', ${AT})`;
        const withPerson = yield* claims.readClaimsFor(ORDER);
        yield* report(claims, OTHER_ERP_ACCOUNT, SITE, [], { linked: [ORDER] });
        return { withPerson, withSource: yield* claims.readClaimsFor(ORDER) };
      }),
    );

    expect(detail.withPerson.links).toEqual([
      { fromRef: ORDER, toRef: SITE, claim: { type: "person", actor: "user" } },
    ]);
    expect(detail.withSource.links).toEqual([
      { fromRef: SITE, toRef: ORDER, claim: { type: "source", plugin: "acme-erp" } },
    ]);
  });
});

describe("loops in part-of", () => {
  it("stores a claim that closes a loop as conflicted, returns it, and applies the rest", async () => {
    const { write, again, rows, detail } = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, ERP_ACCOUNT, ROUND_ONE, [SITE]);
        // The site is part of the round it contains, and of a new parent.
        const write = yield* report(claims, ERP_ACCOUNT, SITE, [ROUND_ONE, ORDER]);
        const again = yield* report(claims, ERP_ACCOUNT, SITE, [ROUND_ONE, ORDER]);
        return {
          write,
          again,
          rows: yield* readStored(sql, SITE),
          detail: yield* claims.readClaimsFor(ROUND_ONE),
        };
      }),
    );

    expect(write.conflicts.map((c) => [c.fromRef, c.relation, c.toRef])).toEqual([
      [SITE, "part-of", ROUND_ONE],
    ]);
    expect(write.conflicts[0]!.reason).not.toBe("");
    expect(write.changed).toBe(true);
    // A repeat changes nothing and still reports the standing conflict.
    expect(again.changed).toBe(false);
    expect(again.conflicts).toEqual(write.conflicts);
    expect(rows.map((claim) => [claim.to_ref, claim.state])).toEqual([
      [ROUND_ONE, "conflicted"],
      [ORDER, "current"],
    ]);
    expect(detail.conflicts).toEqual(write.conflicts);
  });

  it("refuses a loop closed by a claim of another reporter, and a thing that is part of itself", async () => {
    const { loop, self } = await run((claims) =>
      Effect.gen(function* () {
        yield* report(claims, ERP_ACCOUNT, ORDER, [ROUND_ONE]);
        yield* report(claims, ERP_ACCOUNT, ROUND_ONE, [SITE]);
        const loop = yield* report(claims, OTHER_ERP_ACCOUNT, SITE, [ORDER]);
        const self = yield* report(claims, OTHER_ERP_ACCOUNT, ROUND_TWO, [ROUND_TWO]);
        return { loop, self };
      }),
    );

    expect(loop.conflicts.map((c) => c.toRef)).toEqual([ORDER]);
    expect(self.conflicts.map((c) => c.toRef)).toEqual([ROUND_TWO]);
  });

  it("drops a conflicted claim when a complete read no longer reports it", async () => {
    const { write, rows } = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, ERP_ACCOUNT, ROUND_ONE, [SITE]);
        yield* report(claims, ERP_ACCOUNT, SITE, [ROUND_ONE]);
        const write = yield* report(claims, ERP_ACCOUNT, SITE, []);
        return { write, rows: yield* readStored(sql, SITE) };
      }),
    );

    expect(write).toEqual({ changed: true, conflicts: [] });
    expect(rows).toEqual([]);
  });
});

describe("readAncestors", () => {
  it("lists each ancestor once, nearest first, and every edge of a multi-parent graph", async () => {
    const walk = await run((claims) =>
      Effect.gen(function* () {
        yield* report(claims, ERP_ACCOUNT, ORDER, [ROUND_TWO, ROUND_ONE]);
        yield* report(claims, ERP_ACCOUNT, ROUND_ONE, [SITE]);
        // A second reporter says the same of round two, so the edge is claimed twice.
        yield* report(claims, ERP_ACCOUNT, ROUND_TWO, [SITE]);
        yield* report(claims, OTHER_ERP_ACCOUNT, ROUND_TWO, [SITE]);
        return yield* claims.readAncestors([ORDER, ROUND_ONE, ORDER]);
      }),
    );

    expect(walk.ancestors.get(ORDER)).toEqual([ROUND_ONE, ROUND_TWO, SITE]);
    expect(walk.ancestors.get(ROUND_ONE)).toEqual([SITE]);
    expect(walk.edges).toEqual(
      [
        { fromRef: ROUND_ONE, toRef: SITE },
        { fromRef: ROUND_TWO, toRef: SITE },
        { fromRef: ORDER, toRef: ROUND_ONE },
        { fromRef: ORDER, toRef: ROUND_TWO },
      ].sort((a, b) => a.fromRef.localeCompare(b.fromRef) || a.toRef.localeCompare(b.toRef)),
    );
    expect(walk.cutRefs.size).toBe(0);
    expect(walk.cutAll).toBe(false);
  });

  it("gives an ancestor reached by two paths its minimum depth, and keeps the edges of both paths", async () => {
    // `c` is one step up from `a` and two steps up through `y`. It sorts before
    // `y`, so it comes first only if it is placed by its minimum depth.
    const [a, y, c] = ["acme-erp:node:a", "acme-erp:node:y", "acme-erp:node:c"] as const;
    const walk = await run((claims) =>
      Effect.gen(function* () {
        yield* report(claims, ERP_ACCOUNT, a, [y, c]);
        yield* report(claims, ERP_ACCOUNT, y, [c]);
        return yield* claims.readAncestors([a]);
      }),
    );

    expect(walk.ancestors.get(a)).toEqual([c, y]);
    expect(walk.edges).toEqual([
      { fromRef: a, toRef: c },
      { fromRef: a, toRef: y },
      { fromRef: y, toRef: c },
    ]);
  });

  it("marks the whole walk as cut when it crosses more edges than a reply may carry", async () => {
    const walk = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* sql`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_GRAPH_EDGES + 1})
          INSERT INTO external_entity_relation_claims
            (from_ref, relation, to_ref, claim_type, connection_id, evidence_key, state, observed_at)
          SELECT ${ORDER}, 'part-of', 'acme-erp:site:s' || i, 'source', ${uuidFromString(ERP_ACCOUNT)},
                 '', 'current', ${AT} FROM n`;
        return yield* claims.readAncestors([ORDER]);
      }),
    );

    expect(walk.cutAll).toBe(true);
    expect(walk.edges).toHaveLength(MAX_GRAPH_EDGES);
  });

  it("returns an empty list for a ref with no parents, and nothing for no refs", async () => {
    const { lonely, none } = await run((claims) =>
      Effect.gen(function* () {
        return {
          lonely: yield* claims.readAncestors([SITE]),
          none: yield* claims.readAncestors([]),
        };
      }),
    );

    expect(lonely.ancestors.get(SITE)).toEqual([]);
    expect(none.ancestors.size).toBe(0);
  });

  /** Writes a chain of `length` edges, `chain[0]` part of `chain[1]` and so on. */
  const writeChain = (claims: Claims, length: number) =>
    Effect.gen(function* () {
      const chain = Array.from({ length: length + 1 }, (_, index) => `acme-erp:node:n${index}`);
      for (let index = 0; index < length; index++) {
        yield* report(claims, ERP_ACCOUNT, chain[index]!, [chain[index + 1]!]);
      }
      return chain;
    });

  it("stops at the depth limit and marks the start as cut only when an edge lies beyond it", async () => {
    const { exact, beyond, chain } = await run((claims) =>
      Effect.gen(function* () {
        const exactChain = yield* writeChain(claims, MAX_CONTEXT_DEPTH);
        const exact = yield* claims.readAncestors([exactChain[0]!]);
        // One more edge on top of the same chain.
        yield* report(claims, ERP_ACCOUNT, exactChain[MAX_CONTEXT_DEPTH]!, ["acme-erp:node:top"]);
        const beyond = yield* claims.readAncestors([exactChain[0]!]);
        return { exact, beyond, chain: exactChain };
      }),
    );

    expect(exact.ancestors.get(chain[0]!)).toEqual(chain.slice(1));
    expect(exact.cutRefs.size).toBe(0);
    expect(beyond.ancestors.get(chain[0]!)).toEqual(chain.slice(1));
    expect([...beyond.cutRefs]).toEqual([chain[0]]);
    expect(beyond.edges).toHaveLength(MAX_CONTEXT_DEPTH);
    expect(beyond.cutAll).toBe(false);
  });

  it("runs one statement however many refs it reads", async () => {
    const refs = Array.from({ length: 300 }, (_, index) => `acme-erp:purchase-order:PO-${index}`);
    const { statements, walk } = await run((claims) =>
      Effect.gen(function* () {
        for (const ref of refs.slice(0, 5)) {
          yield* report(claims, ERP_ACCOUNT, ref, [ROUND_ONE]);
        }
        yield* report(claims, ERP_ACCOUNT, ROUND_ONE, [SITE]);
        const statements: Array<string> = [];
        const walk = yield* claims.readAncestors(refs).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            }),
          ),
        );
        return { statements, walk };
      }),
    );

    expect(statements).toHaveLength(1);
    expect(walk.ancestors.size).toBe(300);
    expect(walk.ancestors.get(refs[0]!)).toEqual([ROUND_ONE, SITE]);
  });
});

describe("listRefsBelow", () => {
  it("finds every descendant several levels down, and the refs it started from", async () => {
    const below = await run((claims) =>
      Effect.gen(function* () {
        yield* report(claims, ERP_ACCOUNT, ORDER, [ROUND_ONE, ROUND_TWO]);
        yield* report(claims, ERP_ACCOUNT, ROUND_ONE, [SITE]);
        yield* report(claims, ERP_ACCOUNT, ROUND_TWO, [SITE]);
        const noise = "acme-erp:site:south";
        yield* report(claims, ERP_ACCOUNT, "acme-erp:purchase-order:PO-2", [noise]);
        return {
          fromSite: yield* claims.listRefsBelow([SITE]),
          fromRound: yield* claims.listRefsBelow([ROUND_TWO]),
          none: yield* claims.listRefsBelow([]),
        };
      }),
    );

    expect(below.fromSite).toEqual([ROUND_ONE, ROUND_TWO, ORDER, SITE]);
    expect(below.fromRound).toEqual([ROUND_TWO, ORDER]);
    expect(below.none).toEqual([]);
  });
});

describe("the query plans of the walks", () => {
  /** Returns the plan SQLite chooses for each recursive statement `read` sends. */
  const planOf = (read: (claims: Claims) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
    run((claims, sql) =>
      Effect.gen(function* () {
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* read(claims).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile());
              return statement;
            }),
          ),
        );
        const plans: Array<string> = [];
        for (const [text, params] of statements.filter(([text]) => text.includes("RECURSIVE"))) {
          const rows = yield* sql.unsafe<{ readonly detail: string }>(
            `EXPLAIN QUERY PLAN ${text}`,
            params,
          );
          plans.push(...rows.map((row) => row.detail));
        }
        return plans;
      }),
    );

  it("walks up on the partial index of current claims by from_ref, and down on the one by to_ref", async () => {
    const up = await planOf((claims) => claims.readAncestors([ORDER]));
    const down = await planOf((claims) => claims.listRefsBelow([SITE]));
    const loop = await planOf((claims) => report(claims, ERP_ACCOUNT, ORDER, [SITE]));

    expect(
      up.some((step) => step.includes("external_entity_claims_from (from_ref=? AND relation=?)")),
    ).toBe(true);
    expect(up.some((step) => /^SCAN c( |$)/.test(step))).toBe(false);
    expect(
      down.some((step) => step.includes("external_entity_claims_to (to_ref=? AND relation=?)")),
    ).toBe(true);
    expect(
      loop.some((step) => step.includes("external_entity_claims_from (from_ref=? AND relation=?)")),
    ).toBe(true);
  });
});

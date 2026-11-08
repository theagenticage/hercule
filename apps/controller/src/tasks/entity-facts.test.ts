/** Tests the cost of the reads of `entityFactRepository` that must not scan a table. */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { TestDatabase } from "../db/testing";
import { entityFactRepository } from "./entity-facts";

describe("listLiveLinkRefsOf", () => {
  it("finds the links of one Task by the key on the Task id, without scanning every link", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const facts = yield* entityFactRepository;
        const captured: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* Effect.provideService(
          facts.listLiveLinkRefsOf("0199e0e7-0004-7000-8000-000000000001"),
          Statement.CurrentTransformer,
          (statement) =>
            Effect.sync(() => {
              captured.push(statement.compile());
              return statement;
            }),
        );
        const [text, params] = captured[0]!;
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params,
        );
        return rows.map((row) => row.detail);
      }).pipe(Effect.provide(TestDatabase)),
    );
    expect(plan.some((detail) => detail.includes("USING PRIMARY KEY (task_id=?)"))).toBe(true);
    expect(plan.some((detail) => detail.startsWith("SCAN"))).toBe(false);
  });
});

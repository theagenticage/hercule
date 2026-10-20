/**
 * Tests the Task lookup of a handoff against a migrated test database: which
 * thread refs it accepts, and how SQLite runs the query. The handoff itself is
 * tested over HTTP in `handoffs.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import { inTransaction, TestDatabase } from "../db/testing";
import { taskRepository } from "../tasks";
import { findTaskToContinue, readThreadRef } from "./handoffs";

const REF = "github:issue:acme/api#7";

describe("readThreadRef", () => {
  const origin = (threadRef: string) =>
    ({ type: "event", eventId: 1, connectionId: "c", threadRef }) as const;

  it("returns the thread ref of a plugin signal when it is an External Ref", () => {
    expect(readThreadRef(origin(REF))).toEqual(Option.some(REF));
  });

  it("returns none for a thread ref in another form, and for a signal raised through the API", () => {
    expect(readThreadRef(origin("19b2c"))).toEqual(Option.none());
    expect(readThreadRef(origin("Github:issue:a#1"))).toEqual(Option.none());
    expect(readThreadRef({ type: "api", actor: "user", eventIds: [], reason: "r" })).toEqual(
      Option.none(),
    );
  });
});

describe("findTaskToContinue", () => {
  // The describe line runs this lookup for every distinct thread on every
  // read of To do, so it must start from the few provenance rows of the ref.
  // Without statistics SQLite otherwise starts from the status index and scans
  // every open task.
  it("starts from the provenance of the ref, not from the status index or a scan of the tasks", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        // The statements the repository runs, as SQLite receives them.
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* findTaskToContinue(tasks, REF).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) => {
            statements.push(statement.compile());
            return Effect.succeed(statement);
          }),
        );
        const [text, params] = statements.find(([text]) => text.includes("FROM tasks"))!;
        return yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params);
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    const details = plan.map((step) => step.detail);
    expect(details.some((detail) => detail.includes("task_provenance"))).toBe(true);
    expect(details.some((detail) => detail.includes("tasks_status_updated_at"))).toBe(false);
    expect(details.some((detail) => detail.startsWith("SCAN tasks"))).toBe(false);
  });
});

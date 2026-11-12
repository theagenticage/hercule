/**
 * Tests the Inbox's saved query list: the core's five come first, then the
 * plugins' in load order, and an unknown id is refused with the ids that exist.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { RegisteredSavedQuery } from "../plugins";
import { CORE_SAVED_QUERIES, listSavedQueries, findSavedQuery } from "./saved-queries";

const REVIEW_REQUESTS: RegisteredSavedQuery = {
  id: "github/review-requests",
  source: "github",
  name: "Review requests",
  order: "waiting",
  clauses: [{ key: "signal", op: "is", value: "github/review-requested" }],
};

describe("listSavedQueries", () => {
  it("lists the five core queries in order, then the plugins' queries with their source", () => {
    const queries = listSavedQueries([REVIEW_REQUESTS]);

    expect(queries.map((query) => query.id)).toEqual([
      "waits",
      "mine",
      "updates",
      "with-hercule",
      "everything",
      "github/review-requests",
    ]);
    expect(queries.map((query) => query.source)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "github",
    ]);
  });

  it("declares the clauses and order of each core query", () => {
    expect(
      CORE_SAVED_QUERIES.map(({ id, order, clauses }) => [
        id,
        order,
        clauses.map((clause) => `${clause.key} ${clause.op} ${String(clause.value)}`),
      ]),
    ).toEqual([
      ["waits", "waiting", ["asks is true"]],
      ["mine", "newest", ["mine is true"]],
      ["updates", "newest", ["asks is false", "held is false"]],
      ["with-hercule", "newest", ["held is true"]],
      ["everything", "newest", []],
    ]);
  });
});

describe("findSavedQuery", () => {
  it("returns a core query and a plugin's query by id", async () => {
    expect((await Effect.runPromise(findSavedQuery("waits", []))).name).toBe("Someone waits on me");
    expect(
      (await Effect.runPromise(findSavedQuery("github/review-requests", [REVIEW_REQUESTS]))).source,
    ).toBe("github");
  });

  it("fails with a validation error that names the id and lists the ids that exist", async () => {
    const error = await Effect.runPromise(
      Effect.flip(findSavedQuery("github/review-requests", [])),
    );

    expect(error.error.message).toContain('unknown saved query "github/review-requests"');
    expect(JSON.stringify(error.error.details)).toContain("waits, mine, updates");
  });
});

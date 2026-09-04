import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "./testing";
import {
  decodeCursor,
  decodeIdCursor,
  decodeOffsetCursor,
  encodeCursor,
  encodeIdCursor,
  encodeOffsetCursor,
  keysetOver,
  pageOf,
  type CursorScope,
} from "./page";

const KEYS: CursorScope = { op: "apiKey.query", field: "createdAt", direction: "desc" };
const NAMES: CursorScope = { op: "secret.query", field: "name", direction: "asc" };
const ID = "0192ce07-8c4f-7d66-afec-2482b5c9b03c";

/** The decode's failure message, or `null` when it succeeded. */
const refusal = (
  cursor: string,
  scope: CursorScope,
  keyType: "string" | "number" = "string",
): Promise<string | null> =>
  Effect.runPromise(
    decodeCursor(cursor, scope, keyType).pipe(
      Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }),
    ),
  );

describe("keyset cursors", () => {
  it("round-trips the sort key and the id", async () => {
    const cursor = encodeCursor(KEYS, "2026-09-04T09:21:33.084Z", ID);
    expect(await Effect.runPromise(decodeCursor(cursor, KEYS, "string"))).toEqual([
      "2026-09-04T09:21:33.084Z",
      ID,
    ]);
  });

  it("round-trips a sort key holding the separator characters", async () => {
    const key = 'a:name["with"] , punctuation';
    const cursor = encodeCursor(NAMES, key, ID);
    expect(await Effect.runPromise(decodeCursor(cursor, NAMES, "string"))).toEqual([key, ID]);
  });

  it("round-trips a numeric sort key as a number", async () => {
    const ranks: CursorScope = { op: "task.query", field: "priority", direction: "asc" };
    expect(
      await Effect.runPromise(decodeCursor(encodeCursor(ranks, 2, ID), ranks, "number")),
    ).toEqual([2, ID]);
  });

  it("refuses another listing's cursor", async () => {
    const cursor = encodeCursor(NAMES, "controller.signing-key", ID);
    expect(await refusal(cursor, { ...KEYS, direction: "asc" })).toMatch(/not one this listing/);
  });

  it("refuses its own cursor replayed under the other direction", async () => {
    const cursor = encodeCursor(KEYS, "2026-09-04T09:21:33.084Z", ID);
    expect(await refusal(cursor, { ...KEYS, direction: "asc" })).toMatch(/different sort order/);
  });

  it.each([
    ["not base64url", "not a cursor at all"],
    ["not JSON", Buffer.from("nonsense", "utf8").toString("base64url")],
    ["not an array", Buffer.from(JSON.stringify({ id: ID }), "utf8").toString("base64url")],
    [
      "the old two-element shape",
      Buffer.from(JSON.stringify(["x", ID]), "utf8").toString("base64url"),
    ],
    [
      "an id that is not a UUID",
      Buffer.from(
        JSON.stringify(["apiKey.query", "createdAt", "desc", "x", "-".repeat(36)]),
        "utf8",
      ).toString("base64url"),
    ],
    [
      // A sort key is whatever the ordered column holds, and this column holds
      // text: a boolean is not a value it ever had.
      "a sort key that is not what the column holds",
      Buffer.from(JSON.stringify(["apiKey.query", "createdAt", "desc", true, ID]), "utf8").toString(
        "base64url",
      ),
    ],
    [
      // SQLite orders every number below every string, so a number compared
      // against a text column makes the boundary always true or always false:
      // the walk restarts or ends, and neither is a page.
      "a numeric sort key where the column holds text",
      Buffer.from(JSON.stringify(["apiKey.query", "createdAt", "desc", 1757, ID]), "utf8").toString(
        "base64url",
      ),
    ],
  ])("refuses %s", async (_case, cursor) => {
    expect(await refusal(cursor, KEYS)).toMatch(/not one this listing/);
  });
});

/** The event log walks integer ids; a relevance walk over tasks counts rows. */
const EVENTS: CursorScope = { op: "event.query", field: "id", direction: "desc" };
const RELEVANCE: CursorScope = { op: "task.query", field: "relevance", direction: "asc" };

/** The tag of the failure, or `null` when the decode succeeded. */
const refused = <A>(effect: Effect.Effect<A, { readonly _tag: string }>): Promise<string | null> =>
  Effect.runPromise(
    effect.pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => null })),
  );

const edited = (cursor: string): string =>
  Buffer.from(
    Buffer.from(cursor, "base64url").toString("utf8").replace("desc", "asc"),
    "utf8",
  ).toString("base64url");

describe("integer keyset cursors", () => {
  it("round-trips the id", async () => {
    const cursor = encodeIdCursor(EVENTS, 4210);
    expect(await Effect.runPromise(decodeIdCursor(cursor, EVENTS))).toBe(4210);
  });

  it("refuses another operation's cursor", async () => {
    const cursor = encodeIdCursor({ ...EVENTS, op: "task.query" }, 7);
    expect(await refused(decodeIdCursor(cursor, EVENTS))).toBe("CursorError");
  });

  it("refuses its own cursor replayed on another field or direction", async () => {
    const cursor = encodeIdCursor(EVENTS, 7);
    expect(await refused(decodeIdCursor(cursor, { ...EVENTS, field: "createdAt" }))).toBe(
      "CursorError",
    );
    expect(await refused(decodeIdCursor(cursor, { ...EVENTS, direction: "asc" }))).toBe(
      "CursorError",
    );
  });

  it("refuses an edited cursor", async () => {
    expect(await refused(decodeIdCursor(edited(encodeIdCursor(EVENTS, 7)), EVENTS))).toBe(
      "CursorError",
    );
    expect(await refused(decodeIdCursor("not a cursor at all", EVENTS))).toBe("CursorError");
  });

  it("refuses a UUID keyset cursor, and hands its own to no other decoder", async () => {
    const uuid = encodeCursor(EVENTS, "2026-09-04T09:21:33.084Z", ID);
    expect(await refused(decodeIdCursor(uuid, EVENTS))).toBe("CursorError");
    expect(await refused(decodeCursor(encodeIdCursor(EVENTS, 7), EVENTS, "string"))).toBe(
      "CursorError",
    );
  });
});

describe("offset cursors", () => {
  it("round-trips the offset, zero included", async () => {
    expect(
      await Effect.runPromise(decodeOffsetCursor(encodeOffsetCursor(RELEVANCE, 40), RELEVANCE)),
    ).toBe(40);
    expect(
      await Effect.runPromise(decodeOffsetCursor(encodeOffsetCursor(RELEVANCE, 0), RELEVANCE)),
    ).toBe(0);
  });

  it("refuses another operation's cursor", async () => {
    const cursor = encodeOffsetCursor({ ...RELEVANCE, op: "event.query" }, 40);
    expect(await refused(decodeOffsetCursor(cursor, RELEVANCE))).toBe("CursorError");
  });

  it("refuses its own cursor replayed on another field or direction", async () => {
    const cursor = encodeOffsetCursor(RELEVANCE, 40);
    expect(await refused(decodeOffsetCursor(cursor, { ...RELEVANCE, field: "updatedAt" }))).toBe(
      "CursorError",
    );
    expect(await refused(decodeOffsetCursor(cursor, { ...RELEVANCE, direction: "desc" }))).toBe(
      "CursorError",
    );
  });

  it("refuses an edited cursor", async () => {
    const cursor = encodeOffsetCursor({ ...RELEVANCE, direction: "desc" }, 40);
    expect(
      await refused(decodeOffsetCursor(edited(cursor), { ...RELEVANCE, direction: "desc" })),
    ).toBe("CursorError");
    expect(await refused(decodeOffsetCursor("not a cursor at all", RELEVANCE))).toBe("CursorError");
  });

  it("refuses a UUID keyset cursor", async () => {
    const uuid = encodeCursor(RELEVANCE, "2026-09-04T09:21:33.084Z", ID);
    expect(await refused(decodeOffsetCursor(uuid, RELEVANCE))).toBe("CursorError");
  });
});

/**
 * The walk itself, against a real table: the fragments and the page decision
 * are what every listing is now made of, so they are tested once here rather
 * than through each of them.
 */
const LETTERS = ["a", "b", "c", "d", "e"] as const;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE walked (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)`;
  for (const [index, name] of LETTERS.entries()) {
    yield* sql`INSERT INTO walked (id, name)
               VALUES (${`0192ce07-8c4f-7d66-afec-2482b5c9b03${String(index)}`}, ${name})`;
  }
  return sql;
});

/** Every row a keyset walk of that page size reaches, plus how many pages it took. */
const walkAll = (direction: "asc" | "desc", limit: number) =>
  Effect.gen(function* () {
    const sql = yield* seed;
    const scope: CursorScope = { op: "secret.query", field: "name", direction };
    const names: Array<string> = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const after = cursor === undefined ? undefined : yield* decodeCursor(cursor, scope, "string");
      const { keyset, order } = keysetOver(sql, ["name", "id"], after, direction);
      const rows = yield* sql<{ readonly id: string; readonly name: string }>`
        SELECT id, name FROM walked WHERE ${keyset} ${order} LIMIT ${limit + 1}
      `;
      const page = yield* pageOf(rows, limit, Effect.succeed, (last) =>
        encodeCursor(scope, last.name, last.id),
      );
      pages++;
      names.push(...page.items.map((row) => row.name));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    return { names, pages };
  }).pipe(Effect.provide(TestDatabase), Effect.runPromise);

describe("the keyset walk", () => {
  it("reads every row exactly once, in the direction it was given", async () => {
    expect(await walkAll("asc", 2)).toEqual({ names: ["a", "b", "c", "d", "e"], pages: 3 });
    expect(await walkAll("desc", 2)).toEqual({ names: ["e", "d", "c", "b", "a"], pages: 3 });
  });

  it("issues no cursor when the last page is exactly full", async () => {
    // Five rows at a page of five: the sixth row the walk asked for is not
    // there, so there is no next page and no cursor promising one.
    expect(await walkAll("asc", 5)).toEqual({ names: ["a", "b", "c", "d", "e"], pages: 1 });
  });
});

import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "./testing";
import {
  decodeCursor,
  decodeIntegerKeyCursor,
  decodeOffsetCursor,
  decodeOwnedCursor,
  encodeCursor,
  encodeIntegerKeyCursor,
  encodeOffsetCursor,
  encodeOwnedCursor,
  buildKeyset,
  buildPage,
  type CursorScope,
} from "./page";

const KEYS: CursorScope = { op: "apiKey.query", field: "createdAt", direction: "desc" };
const NAMES: CursorScope = { op: "secret.query", field: "name", direction: "asc" };
const ID = "0192ce07-8c4f-7d66-afec-2482b5c9b03c";

/** Returns the decode's failure message, or `null` when the decode succeeded. */
const readDecodeFailure = (
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

  it("rejects another operation's cursor", async () => {
    const cursor = encodeCursor(NAMES, "controller.signing-key", ID);
    expect(await readDecodeFailure(cursor, { ...KEYS, direction: "asc" })).toMatch(
      /not one this listing/,
    );
  });

  it("rejects its own cursor used with the other direction", async () => {
    const cursor = encodeCursor(KEYS, "2026-09-04T09:21:33.084Z", ID);
    expect(await readDecodeFailure(cursor, { ...KEYS, direction: "asc" })).toMatch(
      /different sort order/,
    );
  });

  it("rejects a cursor for another sort field, without calling it a different direction", async () => {
    // `field` holds whatever the order depends on, not only a column name, so
    // a mismatch there means a different list rather than a different
    // direction. The message must not send the caller to check `--sort`.
    const cursor = encodeCursor(KEYS, "2026-09-04T09:21:33.084Z", ID);
    expect(await readDecodeFailure(cursor, { ...KEYS, field: "name" })).toMatch(
      /different listing/,
    );
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
      // A sort key has the type of its column, and this column holds text, so
      // a boolean can never be a valid key.
      "a sort key that is not what the column holds",
      Buffer.from(JSON.stringify(["apiKey.query", "createdAt", "desc", true, ID]), "utf8").toString(
        "base64url",
      ),
    ],
    [
      // SQLite sorts every number below every string, so a number compared
      // against a text column makes the boundary always true or always false:
      // the list restarts or ends instead of returning the next page.
      "a numeric sort key where the column holds text",
      Buffer.from(JSON.stringify(["apiKey.query", "createdAt", "desc", 1757, ID]), "utf8").toString(
        "base64url",
      ),
    ],
  ])("rejects a cursor: %s", async (_case, cursor) => {
    expect(await readDecodeFailure(cursor, KEYS)).toMatch(/not one this listing/);
  });
});

/** The event log is sorted by integer id; a relevance search over tasks counts rows. */
const EVENTS: CursorScope = { op: "event.query", field: "id", direction: "desc" };
const RELEVANCE: CursorScope = { op: "task.query", field: "relevance", direction: "asc" };

/** Returns the tag of the failure, or `null` when the decode succeeded. */
const readFailureTag = <A>(
  effect: Effect.Effect<A, { readonly _tag: string }>,
): Promise<string | null> =>
  Effect.runPromise(
    effect.pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => null })),
  );

const flipCursorDirection = (cursor: string): string =>
  Buffer.from(
    Buffer.from(cursor, "base64url").toString("utf8").replace("desc", "asc"),
    "utf8",
  ).toString("base64url");

describe("integer keyset cursors", () => {
  it("round-trips the key", async () => {
    const cursor = encodeIntegerKeyCursor(EVENTS, 4210);
    expect(await Effect.runPromise(decodeIntegerKeyCursor(cursor, EVENTS))).toBe(4210);
  });

  it("rejects another operation's cursor", async () => {
    const cursor = encodeIntegerKeyCursor({ ...EVENTS, op: "task.query" }, 7);
    expect(await readFailureTag(decodeIntegerKeyCursor(cursor, EVENTS))).toBe("CursorError");
  });

  it("rejects its own cursor used with another field or direction", async () => {
    const cursor = encodeIntegerKeyCursor(EVENTS, 7);
    expect(
      await readFailureTag(decodeIntegerKeyCursor(cursor, { ...EVENTS, field: "createdAt" })),
    ).toBe("CursorError");
    expect(
      await readFailureTag(decodeIntegerKeyCursor(cursor, { ...EVENTS, direction: "asc" })),
    ).toBe("CursorError");
  });

  it("rejects an edited cursor", async () => {
    expect(
      await readFailureTag(
        decodeIntegerKeyCursor(flipCursorDirection(encodeIntegerKeyCursor(EVENTS, 7)), EVENTS),
      ),
    ).toBe("CursorError");
    expect(await readFailureTag(decodeIntegerKeyCursor("not a cursor at all", EVENTS))).toBe(
      "CursorError",
    );
  });

  it("rejects a UUID keyset cursor, and the UUID keyset decoder rejects its cursor", async () => {
    const uuid = encodeCursor(EVENTS, "2026-09-04T09:21:33.084Z", ID);
    expect(await readFailureTag(decodeIntegerKeyCursor(uuid, EVENTS))).toBe("CursorError");
    expect(
      await readFailureTag(decodeCursor(encodeIntegerKeyCursor(EVENTS, 7), EVENTS, "string")),
    ).toBe("CursorError");
  });
});

/** A trigger is identified by its workflow's id plus the trigger id from the workflow's YAML. */
const TRIGGERS: CursorScope = { op: "trigger.query", field: "createdAt", direction: "desc" };
const CREATED_AT = "2026-09-22T10:00:00.000Z";

/** Builds an owned-row cursor with any payload, to test payloads the decoder must reject. */
const sealOwnedCursor = (...payload: ReadonlyArray<unknown>): string =>
  Buffer.from(JSON.stringify(["trigger.query", "createdAt", "desc", ...payload]), "utf8").toString(
    "base64url",
  );

describe("owned-row keyset cursors", () => {
  it("round-trips the sort key, the owner id and the name", async () => {
    const cursor = encodeOwnedCursor(TRIGGERS, CREATED_AT, ID, "nightly");
    expect(await Effect.runPromise(decodeOwnedCursor(cursor, TRIGGERS))).toEqual([
      CREATED_AT,
      ID,
      "nightly",
    ]);
  });

  it("rejects a cursor issued by another operation", async () => {
    const cursor = encodeOwnedCursor(
      { ...TRIGGERS, op: "workflow.query" },
      CREATED_AT,
      ID,
      "nightly",
    );
    expect(await readFailureTag(decodeOwnedCursor(cursor, TRIGGERS))).toBe("CursorError");
  });

  it("rejects its own cursor used with another sort field or direction", async () => {
    const cursor = encodeOwnedCursor(TRIGGERS, CREATED_AT, ID, "nightly");
    expect(
      await readFailureTag(decodeOwnedCursor(cursor, { ...TRIGGERS, field: "updatedAt" })),
    ).toBe("CursorError");
    expect(await readFailureTag(decodeOwnedCursor(cursor, { ...TRIGGERS, direction: "asc" }))).toBe(
      "CursorError",
    );
  });

  it("rejects an edited cursor and a cursor with the wrong payload", async () => {
    expect(
      await readFailureTag(
        decodeOwnedCursor(
          flipCursorDirection(encodeOwnedCursor(TRIGGERS, CREATED_AT, ID, "nightly")),
          TRIGGERS,
        ),
      ),
    ).toBe("CursorError");
    expect(await readFailureTag(decodeOwnedCursor("not a cursor at all", TRIGGERS))).toBe(
      "CursorError",
    );
    // A plain keyset cursor has no name, and a numeric sort key is not a timestamp.
    expect(
      await readFailureTag(decodeOwnedCursor(encodeCursor(TRIGGERS, CREATED_AT, ID), TRIGGERS)),
    ).toBe("CursorError");
    expect(
      await readFailureTag(decodeOwnedCursor(sealOwnedCursor(1757, ID, "nightly"), TRIGGERS)),
    ).toBe("CursorError");
    expect(
      await readFailureTag(
        decodeOwnedCursor(sealOwnedCursor(CREATED_AT, "not-an-id", "nightly"), TRIGGERS),
      ),
    ).toBe("CursorError");
    expect(
      await readFailureTag(decodeOwnedCursor(sealOwnedCursor(CREATED_AT, ID, 7), TRIGGERS)),
    ).toBe("CursorError");
  });

  it("is rejected by the plain keyset decoder", async () => {
    const cursor = encodeOwnedCursor(TRIGGERS, CREATED_AT, ID, "nightly");
    expect(await readFailureTag(decodeCursor(cursor, TRIGGERS, "string"))).toBe("CursorError");
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

  it("rejects another operation's cursor", async () => {
    const cursor = encodeOffsetCursor({ ...RELEVANCE, op: "event.query" }, 40);
    expect(await readFailureTag(decodeOffsetCursor(cursor, RELEVANCE))).toBe("CursorError");
  });

  it("rejects its own cursor used with another field or direction", async () => {
    const cursor = encodeOffsetCursor(RELEVANCE, 40);
    expect(
      await readFailureTag(decodeOffsetCursor(cursor, { ...RELEVANCE, field: "updatedAt" })),
    ).toBe("CursorError");
    expect(
      await readFailureTag(decodeOffsetCursor(cursor, { ...RELEVANCE, direction: "desc" })),
    ).toBe("CursorError");
  });

  it("rejects an edited cursor", async () => {
    const cursor = encodeOffsetCursor({ ...RELEVANCE, direction: "desc" }, 40);
    expect(
      await readFailureTag(
        decodeOffsetCursor(flipCursorDirection(cursor), { ...RELEVANCE, direction: "desc" }),
      ),
    ).toBe("CursorError");
    expect(await readFailureTag(decodeOffsetCursor("not a cursor at all", RELEVANCE))).toBe(
      "CursorError",
    );
  });

  it("rejects a UUID keyset cursor", async () => {
    const uuid = encodeCursor(RELEVANCE, "2026-09-04T09:21:33.084Z", ID);
    expect(await readFailureTag(decodeOffsetCursor(uuid, RELEVANCE))).toBe("CursorError");
  });
});

/**
 * Paging through a real table. Every list operation is built from these SQL
 * fragments and `buildPage`, so they are tested once here rather than through
 * each operation.
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

/** Returns every row that paging with this page size reads, plus how many pages it took. */
const walkAll = (direction: "asc" | "desc", limit: number) =>
  Effect.gen(function* () {
    const sql = yield* seed;
    const scope: CursorScope = { op: "secret.query", field: "name", direction };
    const names: Array<string> = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const after = cursor === undefined ? undefined : yield* decodeCursor(cursor, scope, "string");
      const { keyset, order } = buildKeyset(sql, ["name", "id"], after, direction);
      const rows = yield* sql<{ readonly id: string; readonly name: string }>`
        SELECT id, name FROM walked WHERE ${keyset} ${order} LIMIT ${limit + 1}
      `;
      const page = yield* buildPage(rows, limit, Effect.succeed, (last) =>
        encodeCursor(scope, last.name, last.id),
      );
      pages++;
      names.push(...page.items.map((row) => row.name));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    return { names, pages };
  }).pipe(Effect.provide(TestDatabase), Effect.runPromise);

describe("keyset paging", () => {
  it("reads every row exactly once, in the direction it was given", async () => {
    expect(await walkAll("asc", 2)).toEqual({ names: ["a", "b", "c", "d", "e"], pages: 3 });
    expect(await walkAll("desc", 2)).toEqual({ names: ["e", "d", "c", "b", "a"], pages: 3 });
  });

  it("issues no cursor when the last page is exactly full", async () => {
    // Five rows with a page size of five: the sixth row the query asked for is
    // not there, so there is no next page and no cursor.
    expect(await walkAll("asc", 5)).toEqual({ names: ["a", "b", "c", "d", "e"], pages: 1 });
  });
});

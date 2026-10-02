import { describe, expect, it } from "vitest";
import type * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { uuidFromString, uuidToString } from "./id";
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
  hasSortKeys,
  prepareKeysetListing,
  resolveSortDirection,
  resolveSortKeys,
  type CursorScope,
  type KeysetColumn,
  type ResolvedSortKey,
  type SortColumn,
  type SortValueType,
} from "./page";

const API_KEYS: CursorScope = {
  op: "apiKey.query",
  sort: [{ field: "createdAt", direction: "desc" }],
};
const NAMES: CursorScope = { op: "secret.query", sort: [{ field: "name", direction: "asc" }] };
const ID = "0192ce07-8c4f-7d66-afec-2482b5c9b03c";
const CREATED_AT = "2026-09-22T10:00:00.000Z";

/** Returns `scope` with its sort keys replaced by `sort`. */
const withSort = (
  scope: CursorScope,
  ...sort: Arr.NonEmptyReadonlyArray<ResolvedSortKey>
): CursorScope => ({
  ...scope,
  sort,
});

/** Builds a cursor from any JSON parts, to test cursors the decoders must reject. */
const sealRawCursor = (...parts: ReadonlyArray<unknown>): string =>
  Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");

/** Returns the decode's failure message, or `null` when the decode succeeded. */
const readDecodeFailure = (
  cursor: string,
  scope: CursorScope,
  valueTypes: ReadonlyArray<SortValueType> = ["string"],
): Promise<string | null> =>
  Effect.runPromise(
    decodeCursor(cursor, scope, valueTypes).pipe(
      Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }),
    ),
  );

describe("keyset cursors", () => {
  it("round-trips the sort value and the id", async () => {
    const cursor = encodeCursor(API_KEYS, [CREATED_AT], ID);
    expect(await Effect.runPromise(decodeCursor(cursor, API_KEYS, ["string"]))).toEqual({
      values: [CREATED_AT],
      id: ID,
    });
  });

  it("round-trips a sort value holding the separator characters", async () => {
    const value = 'a:name["with"] , punctuation';
    const cursor = encodeCursor(NAMES, [value], ID);
    expect(await Effect.runPromise(decodeCursor(cursor, NAMES, ["string"]))).toEqual({
      values: [value],
      id: ID,
    });
  });

  it("round-trips a numeric sort value as a number", async () => {
    const ranks: CursorScope = {
      op: "task.query",
      sort: [{ field: "priority", direction: "asc" }],
    };
    expect(
      await Effect.runPromise(decodeCursor(encodeCursor(ranks, [2], ID), ranks, ["number"])),
    ).toEqual({ values: [2], id: ID });
  });

  it.each(["2.5", "1e999", "-1e999", "9007199254740993"])(
    "rejects a numeric sort value that is not a safe integer: %s",
    async (value) => {
      // A rank is always a small integer, so only an edited cursor holds a
      // fraction or a number too large to parse exactly. The JSON is written
      // by hand because `JSON.stringify` turns an infinite number into `null`.
      const sort = [{ field: "priority", direction: "asc" }] as const;
      const cursor = Buffer.from(
        `["task.query",${JSON.stringify(sort)},${value},"${ID}"]`,
        "utf8",
      ).toString("base64url");
      expect(await readDecodeFailure(cursor, { op: "task.query", sort }, ["number"])).toMatch(
        /not one this listing/,
      );
    },
  );

  it("round-trips one value per sort key, in order", async () => {
    const tasks: CursorScope = {
      op: "task.query",
      sort: [
        { field: "priority", direction: "desc" },
        { field: "createdAt", direction: "asc" },
      ],
    };
    const cursor = encodeCursor(tasks, [3, CREATED_AT], ID);
    expect(await Effect.runPromise(decodeCursor(cursor, tasks, ["number", "string"]))).toEqual({
      values: [3, CREATED_AT],
      id: ID,
    });
  });

  it("rejects another operation's cursor", async () => {
    const cursor = encodeCursor(NAMES, ["controller.signing-key"], ID);
    expect(
      await readDecodeFailure(cursor, withSort(API_KEYS, { field: "name", direction: "asc" })),
    ).toMatch(/not one this listing/);
  });

  it("rejects its own cursor used with the other direction", async () => {
    const cursor = encodeCursor(API_KEYS, [CREATED_AT], ID);
    expect(
      await readDecodeFailure(cursor, withSort(API_KEYS, { field: "createdAt", direction: "asc" })),
    ).toMatch(/different sort order/);
  });

  it("rejects a cursor for another sort field, without calling it a different direction", async () => {
    // A key's `field` holds whatever the order depends on, not only a column
    // name, so a mismatch there means a different list rather than a
    // different direction. The message must not send the caller to check
    // `--sort`.
    const cursor = encodeCursor(API_KEYS, [CREATED_AT], ID);
    expect(
      await readDecodeFailure(cursor, withSort(API_KEYS, { field: "name", direction: "desc" })),
    ).toMatch(/different listing/);
  });

  describe("with several sort keys", () => {
    const PRIORITY_DESC = { field: "priority", direction: "desc" } as const;
    const CREATED_ASC = { field: "createdAt", direction: "asc" } as const;
    const TASKS: CursorScope = { op: "task.query", sort: [PRIORITY_DESC, CREATED_ASC] };
    const cursor = encodeCursor(TASKS, [3, CREATED_AT], ID);
    const readFailure = (scope: CursorScope) =>
      readDecodeFailure(cursor, scope, ["number", "string"]);

    it("rejects a cursor for other fields as another listing", async () => {
      expect(
        await readFailure(withSort(TASKS, PRIORITY_DESC, { field: "updatedAt", direction: "asc" })),
      ).toMatch(/different listing/);
      expect(await readFailure(withSort(TASKS, PRIORITY_DESC))).toMatch(/different listing/);
      expect(
        await readFailure(
          withSort(TASKS, PRIORITY_DESC, CREATED_ASC, { field: "status", direction: "asc" }),
        ),
      ).toMatch(/different listing/);
    });

    it("rejects a cursor for the same fields in another order as another listing", async () => {
      expect(await readFailure(withSort(TASKS, CREATED_ASC, PRIORITY_DESC))).toMatch(
        /different listing/,
      );
    });

    it("rejects a cursor for the same fields in other directions as another order", async () => {
      expect(
        await readFailure(
          withSort(TASKS, PRIORITY_DESC, { field: "createdAt", direction: "desc" }),
        ),
      ).toMatch(/different sort order/);
    });

    it("compares every field before any direction", async () => {
      // The first key differs in direction and the second in field. The field
      // is the larger change, so the cursor is for another listing.
      expect(
        await readFailure(
          withSort(
            TASKS,
            { field: "priority", direction: "asc" },
            { field: "updatedAt", direction: "asc" },
          ),
        ),
      ).toMatch(/different listing/);
    });

    it("rejects a cursor with a value missing or of the wrong type", async () => {
      expect(await readDecodeFailure(cursor, TASKS, ["number"])).toMatch(/not one this listing/);
      expect(await readDecodeFailure(cursor, TASKS, ["string", "string"])).toMatch(
        /not one this listing/,
      );
    });
  });

  it.each([
    ["not base64url", "not a cursor at all"],
    ["not JSON", Buffer.from("nonsense", "utf8").toString("base64url")],
    ["not an array", sealRawCursor({ id: ID })],
    ["the old two-element shape", sealRawCursor("x", ID)],
    [
      // Before the sort became a list, a cursor held the field and the
      // direction as two strings.
      "the shape from before the sort became a list",
      sealRawCursor("apiKey.query", "createdAt", "desc", CREATED_AT, ID),
    ],
    [
      "a sort key with no direction",
      sealRawCursor("apiKey.query", [{ field: "createdAt" }], CREATED_AT, ID),
    ],
    [
      "a sort key whose field is not a string",
      sealRawCursor("apiKey.query", [{ field: 1, direction: "desc" }], CREATED_AT, ID),
    ],
    ["an id that is not a UUID", sealRawCursor("apiKey.query", API_KEYS.sort, "x", "-".repeat(36))],
    [
      // A sort value has the type of its column, and this column holds text,
      // so a boolean can never be a valid value.
      "a sort value that is not what the column holds",
      sealRawCursor("apiKey.query", API_KEYS.sort, true, ID),
    ],
    [
      // SQLite sorts every number below every string, so a number compared
      // against a text column makes the boundary always true or always false:
      // the list restarts or ends instead of returning the next page.
      "a numeric sort value where the column holds text",
      sealRawCursor("apiKey.query", API_KEYS.sort, 1757, ID),
    ],
    [
      "a second sort value",
      sealRawCursor("apiKey.query", API_KEYS.sort, CREATED_AT, CREATED_AT, ID),
    ],
  ])("rejects a cursor: %s", async (_case, cursor) => {
    expect(await readDecodeFailure(cursor, API_KEYS)).toMatch(/not one this listing/);
  });
});

/** The event log is sorted by integer id; a relevance search over tasks counts rows. */
const EVENTS: CursorScope = { op: "event.query", sort: [{ field: "id", direction: "desc" }] };
const RELEVANCE: CursorScope = {
  op: "task.query",
  sort: [{ field: "relevance", direction: "asc" }],
};

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
      await readFailureTag(
        decodeIntegerKeyCursor(cursor, withSort(EVENTS, { field: "createdAt", direction: "desc" })),
      ),
    ).toBe("CursorError");
    expect(
      await readFailureTag(
        decodeIntegerKeyCursor(cursor, withSort(EVENTS, { field: "id", direction: "asc" })),
      ),
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
    const uuid = encodeCursor(EVENTS, [CREATED_AT], ID);
    expect(await readFailureTag(decodeIntegerKeyCursor(uuid, EVENTS))).toBe("CursorError");
    expect(
      await readFailureTag(decodeCursor(encodeIntegerKeyCursor(EVENTS, 7), EVENTS, ["string"])),
    ).toBe("CursorError");
  });
});

/** A trigger is identified by its workflow's id plus the trigger id from the workflow's YAML. */
const TRIGGERS: CursorScope = {
  op: "trigger.query",
  sort: [{ field: "createdAt", direction: "desc" }],
};

/** Builds an owned-row cursor with any payload, to test payloads the decoder must reject. */
const sealOwnedCursor = (...payload: ReadonlyArray<unknown>): string =>
  sealRawCursor("trigger.query", TRIGGERS.sort, ...payload);

describe("owned-row keyset cursors", () => {
  it("round-trips the sort value, the owner id and the name", async () => {
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
      await readFailureTag(
        decodeOwnedCursor(cursor, withSort(TRIGGERS, { field: "updatedAt", direction: "desc" })),
      ),
    ).toBe("CursorError");
    expect(
      await readFailureTag(
        decodeOwnedCursor(cursor, withSort(TRIGGERS, { field: "createdAt", direction: "asc" })),
      ),
    ).toBe("CursorError");
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
    // A plain keyset cursor has no name, and a numeric sort value is not a timestamp.
    expect(
      await readFailureTag(decodeOwnedCursor(encodeCursor(TRIGGERS, [CREATED_AT], ID), TRIGGERS)),
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
    expect(await readFailureTag(decodeCursor(cursor, TRIGGERS, ["string"]))).toBe("CursorError");
  });
});

describe("offset cursors", () => {
  const RELEVANCE_DESC = withSort(RELEVANCE, { field: "relevance", direction: "desc" });

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
      await readFailureTag(
        decodeOffsetCursor(cursor, withSort(RELEVANCE, { field: "updatedAt", direction: "asc" })),
      ),
    ).toBe("CursorError");
    expect(await readFailureTag(decodeOffsetCursor(cursor, RELEVANCE_DESC))).toBe("CursorError");
  });

  it("rejects an edited cursor", async () => {
    const cursor = encodeOffsetCursor(RELEVANCE_DESC, 40);
    expect(
      await readFailureTag(decodeOffsetCursor(flipCursorDirection(cursor), RELEVANCE_DESC)),
    ).toBe("CursorError");
    expect(await readFailureTag(decodeOffsetCursor("not a cursor at all", RELEVANCE))).toBe(
      "CursorError",
    );
  });

  it("rejects a UUID keyset cursor", async () => {
    const uuid = encodeCursor(RELEVANCE, [CREATED_AT], ID);
    expect(await readFailureTag(decodeOffsetCursor(uuid, RELEVANCE))).toBe("CursorError");
  });
});

describe("hasSortKeys", () => {
  it("counts an empty list as no sort at all", () => {
    expect(hasSortKeys(undefined)).toBe(false);
    expect(hasSortKeys([])).toBe(false);
    expect(hasSortKeys([{ field: "createdAt" }])).toBe(true);
  });
});

describe("resolveSortKeys", () => {
  const DEFAULT: Arr.NonEmptyReadonlyArray<ResolvedSortKey> = [
    { field: "updatedAt", direction: "desc" },
  ];

  it("returns the default keys when the caller sent no sort or an empty list", () => {
    expect(resolveSortKeys(undefined, DEFAULT)).toEqual(DEFAULT);
    expect(resolveSortKeys([], DEFAULT)).toEqual(DEFAULT);
  });

  it("returns the caller's keys in order, with a missing direction set to asc", () => {
    expect(
      resolveSortKeys([{ field: "priority", direction: "desc" }, { field: "createdAt" }], DEFAULT),
    ).toEqual([
      { field: "priority", direction: "desc" },
      { field: "createdAt", direction: "asc" },
    ]);
  });
});

describe("resolveSortDirection", () => {
  it("returns the default direction when the caller sent no key", () => {
    expect(resolveSortDirection(undefined, "desc")).toBe("desc");
    expect(resolveSortDirection([], "desc")).toBe("desc");
  });

  it("returns asc for a key with no direction, whatever the default", () => {
    expect(resolveSortDirection([{ field: "createdAt" }], "desc")).toBe("asc");
  });

  it("returns the direction of the caller's key", () => {
    expect(resolveSortDirection([{ field: "createdAt", direction: "desc" }], "asc")).toBe("desc");
  });
});

/**
 * Paging through a real table. Every list operation is built from these SQL
 * fragments and `buildPage`, so they are tested once here rather than through
 * each operation. The walk goes through `prepareKeysetListing`, which builds
 * the fragments the way a listing with several sort keys does.
 *
 * `label` names each row in the results. `rank` and `name` repeat, so a sort by
 * both has ties on `rank` alone (`a` and `c`) and ties on both (`b` and `e`).
 * The ids ascend in label order.
 */
const ROWS = [
  { label: "a", rank: 1, name: "m", team: "x" },
  { label: "b", rank: 2, name: "n", team: "y" },
  { label: "c", rank: 1, name: "o", team: "x" },
  { label: "d", rank: 2, name: "m", team: "x" },
  { label: "e", rank: 2, name: "n", team: "x" },
  { label: "f", rank: 0, name: "m", team: "y" },
] as const;

interface WalkedRow {
  readonly id: Uint8Array;
  readonly label: string;
  readonly rank: number;
  readonly name: string;
}

interface WalkedItem {
  readonly id: string;
  readonly label: string;
  readonly rank: number;
  readonly name: string;
}

type WalkedSortField = "label" | "rank" | "name";

const WALKED_SORT_COLUMNS: Record<WalkedSortField, SortColumn<WalkedItem>> = {
  label: { column: "label", valueType: "string", readValue: (item) => item.label },
  rank: { column: "rank", valueType: "number", readValue: (item) => item.rank },
  name: { column: "name", valueType: "string", readValue: (item) => item.name },
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE walked (
    id BLOB PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    rank INTEGER NOT NULL,
    name TEXT NOT NULL,
    team TEXT NOT NULL
  )`;
  for (const [index, row] of ROWS.entries()) {
    yield* sql`INSERT INTO walked (id, label, rank, name, team)
               VALUES (${uuidFromString(`0192ce07-8c4f-7d66-afec-2482b5c9b03${String(index)}`)},
                       ${row.label}, ${row.rank}, ${row.name}, ${row.team})`;
  }
  return sql;
});

/**
 * Returns the labels of every row that paging with these keys and this page
 * size reads, plus how many pages it took. With a `team`, only that team's rows
 * are listed, through a condition joined to the boundary with `AND`.
 */
const walkAll = (
  sort: Arr.NonEmptyReadonlyArray<ResolvedSortKey<WalkedSortField>>,
  limit: number,
  team?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* seed;
    const labels: Array<string> = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const { keyset, order, encodeNextCursor } = yield* prepareKeysetListing(
        sql,
        "task.query",
        sort,
        WALKED_SORT_COLUMNS,
        "id",
        cursor,
      );
      const byTeam = team === undefined ? sql`` : sql`AND team = ${team}`;
      const rows = yield* sql<WalkedRow>`
        SELECT id, label, rank, name FROM walked WHERE ${keyset} ${byTeam} ${order}
        LIMIT ${limit + 1}
      `;
      const page = yield* buildPage(
        rows,
        limit,
        (read) => Effect.succeed(read.map((row) => ({ ...row, id: uuidToString(row.id) }))),
        encodeNextCursor,
      );
      pages++;
      labels.push(...page.items.map((item) => item.label));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    return { labels, pages };
  }).pipe(Effect.provide(TestDatabase), Effect.runPromise);

describe("keyset paging", () => {
  it("reads every row exactly once, in the direction it was given", async () => {
    expect(await walkAll([{ field: "label", direction: "asc" }], 2)).toEqual({
      labels: ["a", "b", "c", "d", "e", "f"],
      pages: 3,
    });
    expect(await walkAll([{ field: "label", direction: "desc" }], 2)).toEqual({
      labels: ["f", "e", "d", "c", "b", "a"],
      pages: 3,
    });
  });

  it("issues no cursor when the last page is exactly full", async () => {
    // Six rows with a page size of six: the seventh row the query asked for is
    // not there, so there is no next page and no cursor.
    expect(await walkAll([{ field: "label", direction: "asc" }], 6)).toEqual({
      labels: ["a", "b", "c", "d", "e", "f"],
      pages: 1,
    });
  });

  it.each([1, 2, 6])("orders by each key in its own direction, page size %i", async (limit) => {
    // Rank descending, then name ascending, then the id in the last key's
    // direction: `b` comes before `e` because its id is smaller.
    expect(
      (
        await walkAll(
          [
            { field: "rank", direction: "desc" },
            { field: "name", direction: "asc" },
          ],
          limit,
        )
      ).labels,
    ).toEqual(["d", "b", "e", "a", "c", "f"]);
    // The other way round, the id descends with the name: `e` before `b`.
    expect(
      (
        await walkAll(
          [
            { field: "rank", direction: "asc" },
            { field: "name", direction: "desc" },
          ],
          limit,
        )
      ).labels,
    ).toEqual(["f", "c", "a", "e", "b", "d"]);
  });

  it("orders by several keys in one direction", async () => {
    expect(
      (
        await walkAll(
          [
            { field: "rank", direction: "desc" },
            { field: "name", direction: "desc" },
          ],
          1,
        )
      ).labels,
    ).toEqual(["e", "b", "d", "c", "a", "f"]);
  });

  it("keeps the caller's own conditions on every page when the directions are mixed", async () => {
    // Without parentheses around the boundary, its `OR` would bind looser than
    // the `AND team = ?` after it, and rows of the other team would come back.
    expect(
      (
        await walkAll(
          [
            { field: "rank", direction: "desc" },
            { field: "name", direction: "asc" },
          ],
          1,
          "x",
        )
      ).labels,
    ).toEqual(["d", "e", "a", "c"]);
  });
});

describe("buildKeyset", () => {
  /** Returns the SQL text and parameters of a query that uses the keyset's two fragments. */
  const compileKeyset = (
    keys: Arr.NonEmptyReadonlyArray<KeysetColumn>,
    tieBreak: ReadonlyArray<string>,
    after: ReadonlyArray<unknown> | undefined,
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { keyset, order } = buildKeyset(sql, keys, tieBreak, after);
      return sql`SELECT id FROM t WHERE ${keyset} ${order}`.compile();
    }).pipe(Effect.provide(TestDatabase), Effect.runPromise);

  it("has no boundary on the first page", async () => {
    expect(await compileKeyset([{ column: "name", direction: "asc" }], ["id"], undefined)).toEqual([
      "SELECT id FROM t WHERE 1 = 1 ORDER BY name ASC, id ASC",
      [],
    ]);
  });

  it("compares a row value after a range on the first key when every key has the same direction", async () => {
    // The range on the first key lets SQLite start an index seek there, even
    // when that key is an expression such as a rank.
    expect(
      await compileKeyset(
        [
          { column: "rank", direction: "desc" },
          { column: "name", direction: "desc" },
        ],
        ["id"],
        [2, "n", ID],
      ),
    ).toEqual([
      "SELECT id FROM t WHERE rank <= ? AND (rank, name, id) < (?,?,?) " +
        "ORDER BY rank DESC, name DESC, id DESC",
      [2, 2, "n", ID],
    ]);
  });

  it("writes the boundary out column by column when the directions are mixed", async () => {
    expect(
      await compileKeyset(
        [
          { column: "rank", direction: "desc" },
          { column: "name", direction: "asc" },
        ],
        ["id"],
        [2, "n", ID],
      ),
    ).toEqual([
      "SELECT id FROM t WHERE (rank < ? OR (rank = ? AND (name > ? OR (name = ? AND id > ?)))) " +
        "ORDER BY rank DESC, name ASC, id ASC",
      [2, 2, "n", "n", ID],
    ]);
  });

  it("takes no tie-break when the key is already unique", async () => {
    expect(await compileKeyset([{ column: "position", direction: "desc" }], [], [7])).toEqual([
      "SELECT id FROM t WHERE position <= ? AND (position) < (?) ORDER BY position DESC",
      [7, 7],
    ]);
  });

  it("gives every tie-break column the last key's direction", async () => {
    expect(
      await compileKeyset(
        [{ column: "created_at", direction: "desc" }],
        ["workflow_id", "trigger_id"],
        [CREATED_AT, ID, "nightly"],
      ),
    ).toEqual([
      "SELECT id FROM t WHERE created_at <= ? AND (created_at, workflow_id, trigger_id) < (?,?,?) " +
        "ORDER BY created_at DESC, workflow_id DESC, trigger_id DESC",
      [CREATED_AT, CREATED_AT, ID, "nightly"],
    ]);
  });
});

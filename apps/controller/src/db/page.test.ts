import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { decodeCursor, encodeCursor, type CursorScope } from "./page";

const KEYS: CursorScope = { op: "apiKey.query", field: "createdAt", direction: "desc" };
const NAMES: CursorScope = { op: "secret.query", field: "name", direction: "asc" };
const ID = "0192ce07-8c4f-7d66-afec-2482b5c9b03c";

/** The decode's failure message, or `null` when it succeeded. */
const refusal = (cursor: string, scope: CursorScope): Promise<string | null> =>
  Effect.runPromise(
    decodeCursor(cursor, scope).pipe(
      Effect.match({ onFailure: (error) => error.message, onSuccess: () => null }),
    ),
  );

describe("keyset cursors", () => {
  it("round-trips the sort key and the id", async () => {
    const cursor = encodeCursor(KEYS, "2026-09-04T09:21:33.084Z", ID);
    expect(await Effect.runPromise(decodeCursor(cursor, KEYS))).toEqual([
      "2026-09-04T09:21:33.084Z",
      ID,
    ]);
  });

  it("round-trips a sort key holding the separator characters", async () => {
    const key = 'a:name["with"] , punctuation';
    const cursor = encodeCursor(NAMES, key, ID);
    expect(await Effect.runPromise(decodeCursor(cursor, NAMES))).toEqual([key, ID]);
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
      "a non-string part",
      Buffer.from(JSON.stringify(["apiKey.query", "createdAt", "desc", 1, ID]), "utf8").toString(
        "base64url",
      ),
    ],
  ])("refuses %s", async (_case, cursor) => {
    expect(await refusal(cursor, KEYS)).toMatch(/not one this listing/);
  });
});

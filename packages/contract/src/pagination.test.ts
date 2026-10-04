import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { pageParams, readSortFields, sortParam, type SortKey } from "./pagination";

const decode =
  <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  (input: unknown) =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input));

const encode =
  <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  (input: unknown) =>
    Effect.runSyncExit(Schema.encodeUnknownEffect(schema)(input));

/** Returns the decode's failure message, or `null` when the decode succeeded. */
const readDecodeFailure = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  input: unknown,
): string | null => {
  const exit = Effect.runSyncExit(
    Effect.flip(Schema.decodeUnknownEffect(schema)(input)).pipe(
      Effect.map((error) => error.message),
    ),
  );
  return exit._tag === "Success" ? exit.value : null;
};

const Sort = sortParam(["createdAt", "name", "priority"]);

// A decoded key is a `SortKey`, so a client can build a list of `SortKey`s and
// the controller can resolve the decoded list. This line fails to compile if
// the two drift apart.
type DecodedSortKey = Schema.Schema.Type<typeof Sort>[number];
const decodedKeyIsSortKey = (key: DecodedSortKey): SortKey<DecodedSortKey["field"]> => key;
const sortKeyIsDecodedKey = (key: SortKey<DecodedSortKey["field"]>): DecodedSortKey => key;
void decodedKeyIsSortKey;
void sortKeyIsDecodedKey;

describe("the sort parameter", () => {
  it("decodes `<field>:<direction>` into a field and a direction", () => {
    expect(decode(Sort)(["createdAt:asc"])).toMatchObject({
      _tag: "Success",
      value: [{ field: "createdAt", direction: "asc" }],
    });
  });

  it("leaves the direction out when the string has none, which means asc", () => {
    expect(decode(Sort)(["name"])).toMatchObject({ _tag: "Success", value: [{ field: "name" }] });
  });

  it("keeps the keys in the order they were sent", () => {
    expect(decode(Sort)(["priority:desc", "createdAt"])).toMatchObject({
      _tag: "Success",
      value: [{ field: "priority", direction: "desc" }, { field: "createdAt" }],
    });
  });

  it("encodes a list back to one string per key, in order, for the URL query", () => {
    expect(
      encode(Sort)([{ field: "priority", direction: "desc" }, { field: "createdAt" }]),
    ).toMatchObject({ _tag: "Success", value: ["priority:desc", "createdAt"] });
  });

  it("refuses a field that appears twice, naming the field", () => {
    expect(readDecodeFailure(Sort, ["priority", "createdAt", "priority:desc"])).toMatch(
      /priority appears more than once/,
    );
    expect(
      encode(Sort)([{ field: "createdAt" }, { field: "createdAt", direction: "desc" }])._tag,
    ).toBe("Failure");
  });

  it("refuses a field that appears twice, rather than the list being too long", () => {
    // Four keys over three fields are both too many and a repeat. The repeat
    // is the mistake, so its message is the one the caller sees.
    const message = readDecodeFailure(Sort, ["name", "createdAt", "priority", "name"]);
    expect(message).toMatch(/name appears more than once/);
    expect(message).not.toMatch(/length/);
  });

  it("rejects a field the operation does not sort on", () => {
    expect(decode(Sort)(["bogus:asc"])._tag).toBe("Failure");
    expect(decode(Sort)(["name", "bogus"])._tag).toBe("Failure");
  });

  it("rejects a direction that is neither asc nor desc", () => {
    expect(decode(Sort)(["createdAt:sideways"])._tag).toBe("Failure");
  });

  it("rejects an empty field", () => {
    expect(decode(Sort)([":asc"])._tag).toBe("Failure");
    expect(decode(Sort)([""])._tag).toBe("Failure");
  });

  it("accepts an empty list, which gives the operation's default order", () => {
    expect(decode(Sort)([])).toMatchObject({ _tag: "Success", value: [] });
  });
});

describe("pageParams", () => {
  const Params = pageParams(["name", "createdAt"]);

  it("takes limit, cursor and sort, all of them optional", () => {
    expect(decode(Params)({ limit: 2, cursor: "abc", sort: ["name:desc"] })).toMatchObject({
      _tag: "Success",
      value: { limit: 2, cursor: "abc", sort: [{ field: "name", direction: "desc" }] },
    });
    expect(decode(Params)({})).toMatchObject({ _tag: "Success", value: {} });
  });

  describe("decoded from a URL query, the way the HTTP server reads it", () => {
    // The server decodes a query with `toCodecArrayFromSingle`, which reads a
    // parameter sent once as a list of one. So one `sort=` is a list of one
    // key, and a repeated `sort=` is a list in the order sent.
    const Query = Schema.toCodecArrayFromSingle(Params);

    it("reads one sort parameter as a list of one key", () => {
      expect(decode(Query)({ sort: "name:desc" })).toMatchObject({
        _tag: "Success",
        value: { sort: [{ field: "name", direction: "desc" }] },
      });
    });

    it("reads a repeated sort parameter as a list of keys, in order", () => {
      expect(decode(Query)({ sort: ["name", "createdAt:asc"] })).toMatchObject({
        _tag: "Success",
        value: { sort: [{ field: "name" }, { field: "createdAt", direction: "asc" }] },
      });
    });

    it("still refuses a repeated field", () => {
      const message = readDecodeFailure(Query, { sort: ["name", "createdAt", "name:desc"] });
      expect(message).toMatch(/name appears more than once/);
      expect(message).not.toMatch(/length/);
    });
  });

  it("exposes the sortable fields, so a client can show them", () => {
    expect(readSortFields(Params)).toEqual(["name", "createdAt"]);
    expect(readSortFields(pageParams(["createdAt"]))).toEqual(["createdAt"]);
    expect(
      readSortFields(Schema.Struct({ text: Schema.String, ...pageParams(["status"]).fields })),
    ).toEqual(["status"]);
    expect(readSortFields(Schema.Struct({}))).toEqual([]);
    expect(readSortFields(undefined)).toEqual([]);
  });
});

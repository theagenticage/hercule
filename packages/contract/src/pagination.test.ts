import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { pageParams, readSortFields, sortParam } from "./pagination";

const decode =
  <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  (input: unknown) =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input));

const Sort = sortParam(["createdAt", "name"]);

describe("the sort parameter", () => {
  it("reads `<field>:<direction>` off the wire as a pair", () => {
    expect(decode(Sort)("createdAt:asc")).toMatchObject({
      _tag: "Success",
      value: { field: "createdAt", direction: "asc" },
    });
  });

  it("leaves the direction absent when the wire omits it, so the service defaults", () => {
    expect(decode(Sort)("name")).toMatchObject({ _tag: "Success", value: { field: "name" } });
  });

  it("refuses a field the operation does not sort on", () => {
    expect(decode(Sort)("bogus:asc")._tag).toBe("Failure");
  });

  it("refuses a direction that is neither asc nor desc", () => {
    expect(decode(Sort)("createdAt:sideways")._tag).toBe("Failure");
  });

  it("refuses an empty field", () => {
    expect(decode(Sort)(":asc")._tag).toBe("Failure");
    expect(decode(Sort)("")._tag).toBe("Failure");
  });

  it("goes back out as the one string a URL query can carry", () => {
    expect(
      Effect.runSyncExit(Schema.encodeUnknownEffect(Sort)({ field: "name", direction: "desc" })),
    ).toMatchObject({ _tag: "Success", value: "name:desc" });
  });
});

describe("pageParams", () => {
  const Params = pageParams(["name"]);

  it("takes limit, cursor and sort, all of them optional", () => {
    expect(decode(Params)({ limit: 2, cursor: "abc", sort: "name:desc" })).toMatchObject({
      _tag: "Success",
      value: { limit: 2, cursor: "abc", sort: { field: "name", direction: "desc" } },
    });
    expect(decode(Params)({})).toMatchObject({ _tag: "Success", value: {} });
  });

  it("publishes the sortable fields, so a client can render them", () => {
    expect(readSortFields(Params)).toEqual(["name"]);
    expect(readSortFields(pageParams(["createdAt"]))).toEqual(["createdAt"]);
    expect(readSortFields(Schema.Struct({}))).toEqual([]);
    expect(readSortFields(undefined)).toEqual([]);
  });
});

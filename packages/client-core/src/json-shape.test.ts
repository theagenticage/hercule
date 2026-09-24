import { assert, describe, it } from "vitest";
import { readJsonObject, readStringList } from "./json-shape";

describe("readJsonObject", () => {
  it("returns an object and refuses null, arrays and scalars", () => {
    assert.deepStrictEqual(readJsonObject({ a: 1 }), { a: 1 });
    for (const other of [null, [1], "a", 1, undefined]) {
      assert.strictEqual(readJsonObject(other), undefined);
    }
  });
});

describe("readStringList", () => {
  it("returns an array of strings and refuses a mixed array or a non-array", () => {
    assert.deepStrictEqual(readStringList(["a", "b"]), ["a", "b"]);
    assert.strictEqual(readStringList(["a", 1]), undefined);
    assert.strictEqual(readStringList("a"), undefined);
  });
});

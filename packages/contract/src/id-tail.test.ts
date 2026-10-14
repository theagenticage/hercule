import { assert, describe, it } from "vitest";
import { ID_TAIL, toIdTail } from "./id-tail";

describe("toIdTail", () => {
  it("returns the last eight characters of an id", () => {
    assert.strictEqual(toIdTail("01a06d02-beff-7037-9f5b-042822015952"), "22015952");
    assert.strictEqual(toIdTail("01a06d02-beff-7037-9f5b-042822015952").length, ID_TAIL);
  });

  it("returns a short id whole rather than padding it", () => {
    assert.strictEqual(toIdTail("abc"), "abc");
    assert.strictEqual(toIdTail(""), "");
  });
});

import { assert, describe, it } from "vitest";
import { ID_TAIL, idTail } from "./id-tail";

describe("idTail", () => {
  it("names an id by its last eight characters", () => {
    assert.strictEqual(idTail("01a06d02-beff-7037-9f5b-042822015952"), "22015952");
    assert.strictEqual(idTail("01a06d02-beff-7037-9f5b-042822015952").length, ID_TAIL);
  });

  it("answers a short id whole rather than padding it", () => {
    assert.strictEqual(idTail("abc"), "abc");
    assert.strictEqual(idTail(""), "");
  });
});

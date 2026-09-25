import { assert, describe, it } from "vitest";
import { listJsonLines } from "./json-lines";

describe("listJsonLines", () => {
  it("splits indented JSON into lines, each with its depth and its text", () => {
    assert.deepStrictEqual(listJsonLines({ id: "t_1", labels: ["a b"], provenance: [{ at: 1 }] }), [
      { depth: 0, text: "{" },
      { depth: 1, text: '"id": "t_1",' },
      { depth: 1, text: '"labels": [' },
      { depth: 2, text: '"a b"' },
      { depth: 1, text: "]," },
      { depth: 1, text: '"provenance": [' },
      { depth: 2, text: "{" },
      { depth: 3, text: '"at": 1' },
      { depth: 2, text: "}" },
      { depth: 1, text: "]" },
      { depth: 0, text: "}" },
    ]);
  });

  it("keeps the spaces inside a string", () => {
    assert.deepStrictEqual(listJsonLines(["  two spaces"]), [
      { depth: 0, text: "[" },
      { depth: 1, text: '"  two spaces"' },
      { depth: 0, text: "]" },
    ]);
  });

  it("gives a scalar one line", () => {
    assert.deepStrictEqual(listJsonLines(42), [{ depth: 0, text: "42" }]);
  });
});

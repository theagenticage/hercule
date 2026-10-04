import { assert, describe, it } from "vitest";
import { formatRunnerLabel } from "./runner-label";

const RUNNERS = [
  { id: "01a06d02-beff-7037-9f5b-042822015952", name: "moss" },
  { id: "01a06d02-beff-7037-9f5b-0428220159aa", name: "fern" },
];

describe("formatRunnerLabel", () => {
  it("returns None when no runner is set", () => {
    assert.strictEqual(formatRunnerLabel(null, RUNNERS), "None");
  });

  it("returns the name of the runner with that id", () => {
    assert.strictEqual(formatRunnerLabel("01a06d02-beff-7037-9f5b-0428220159aa", RUNNERS), "fern");
  });

  it("returns the id tail when no runner in the list has that id", () => {
    assert.strictEqual(
      formatRunnerLabel("01a06d02-beff-7037-9f5b-0428220159ff", RUNNERS),
      "220159ff",
    );
  });
});

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildParityFixture,
  PARITY_FIXTURE_PATH,
  readParityCorpus,
} from "./gen-markdown-parity-fixtures";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("gen-markdown-parity-fixtures", () => {
  it("matches the checked-in fixture; run `pnpm gen:markdown-parity` when this fails", async () => {
    const corpus = await readParityCorpus(root);
    const checkedIn = await readFile(`${root}${PARITY_FIXTURE_PATH}`, "utf8");
    // Compared line by line, so that a failure names the cases that changed.
    expect(checkedIn.split("\n")).toEqual(buildParityFixture(corpus).split("\n"));
  });

  it("refuses a corpus that holds an id twice", () => {
    const input = { id: "probe:same", input: "a" };
    expect(() => buildParityFixture([input, input])).toThrow("probe:same");
  });
});

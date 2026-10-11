import { describe, expect, it } from "vitest";
import { HIT_END, HIT_START } from "./repository";
import { buildSnippets, MAX_SNIPPETS_PER_DOCUMENT } from "./snippets";

/** Marks a hit the way `memoryRepository.search` does. */
const mark = (word: string): string => `${HIT_START}${word}${HIT_END}`;

describe("buildSnippets", () => {
  it("returns a short body whole, with the markers removed", () => {
    expect(buildSnippets(`He lives in ${mark("Amsterdam")}.`)).toEqual(["He lives in Amsterdam."]);
  });

  it("cuts a long body to whole words around the hit, with an ellipsis where it goes on", () => {
    const before = "word ".repeat(30);
    const after = " more".repeat(30);
    const [snippet] = buildSnippets(`${before}${mark("needle")}${after}`);
    // Every word is whole: no cut "ord" at the start, no cut "mor" at the end.
    expect(snippet).toMatch(/^…word (word )*needle( more)+…$/);
  });

  it("adds no snippet for a hit inside the previous one", () => {
    expect(buildSnippets(`${mark("one")} and ${mark("two")}`)).toEqual(["one and two"]);
  });

  it("returns at most three snippets", () => {
    const far = " filler".repeat(40);
    const body = Array.from({ length: 5 }, () => mark("hit")).join(far);
    expect(buildSnippets(body)).toHaveLength(MAX_SNIPPETS_PER_DOCUMENT);
  });

  it("returns none for a document that matched only on its name", () => {
    expect(buildSnippets("nothing marked here")).toEqual([]);
  });
});

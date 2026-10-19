/**
 * Tests `splitSkillReferences`, which cuts a plain text into text and the
 * skills it references, for the queued inputs that are drawn as one line.
 */
import { describe, expect, it } from "vitest";
import { containsSkillReference, splitSkillReferences } from "./skill-text";

const NAMES: ReadonlySet<string> = new Set(["review", "webshop:release"]);

describe("splitSkillReferences", () => {
  it("returns no parts for an empty text", () => {
    expect(splitSkillReferences("", NAMES)).toEqual([]);
  });

  it("returns one text part when the text references nothing", () => {
    expect(splitSkillReferences("just a message", NAMES)).toEqual([
      { type: "text", text: "just a message" },
    ]);
  });

  it("splits out each listed reference, a library skill and a repository skill", () => {
    expect(splitSkillReferences("run $review then $webshop:release now", NAMES)).toEqual([
      { type: "text", text: "run " },
      { type: "skill", name: "review" },
      { type: "text", text: " then " },
      { type: "skill", name: "webshop:release" },
      { type: "text", text: " now" },
    ]);
  });

  it("returns only the skill part for a text that is one reference", () => {
    expect(splitSkillReferences("$review", NAMES)).toEqual([{ type: "skill", name: "review" }]);
  });

  it("leaves a name that is not listed as text, so a typo is drawn as written", () => {
    expect(splitSkillReferences("$reveiw and $review", NAMES)).toEqual([
      { type: "text", text: "$reveiw and " },
      { type: "skill", name: "review" },
    ]);
  });

  it("leaves every reference as text when no skill is listed", () => {
    expect(splitSkillReferences("$review", new Set())).toEqual([{ type: "text", text: "$review" }]);
  });

  it("keeps a trailing colon or dash as text after the skill", () => {
    expect(splitSkillReferences("$review: please", NAMES)).toEqual([
      { type: "skill", name: "review" },
      { type: "text", text: ": please" },
    ]);
  });

  it("finds no reference inside a word or inside inline code", () => {
    expect(splitSkillReferences("cost$review and `$review`", NAMES)).toEqual([
      { type: "text", text: "cost$review and `$review`" },
    ]);
  });
});

describe("containsSkillReference", () => {
  it("is true for a text with a reference, listed or not", () => {
    expect(containsSkillReference("run $review now")).toBe(true);
    expect(containsSkillReference("$unknown")).toBe(true);
  });

  it("is false for a text with none, so the text is one text part", () => {
    for (const text of ["", "just a message", "cost$review", "`$review`", "$5"]) {
      expect(containsSkillReference(text)).toBe(false);
      expect(splitSkillReferences(text, NAMES)).toEqual(
        text === "" ? [] : [{ type: "text", text }],
      );
    }
  });
});

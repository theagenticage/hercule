import { describe, expect, it } from "vitest";

import { findSkillReferences, isSkillReferencePrefix } from "./skill-reference";

const namesIn = (text: string) => findSkillReferences(text).map((reference) => reference.name);

describe("findSkillReferences", () => {
  describe("where a token may start", () => {
    it.each([
      ["$review", ["review"]],
      ["run $review", ["review"]],
      ["first\n$review", ["review"]],
      ["first\r\n$review", ["review"]],
      ["a\t$review", ["review"]],
      ["a $review", ["review"]],
      ["x$foo", []],
      ["a`$foo", []],
      ["($foo)", []],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("what a name is made of", () => {
    it.each([
      ["$", []],
      ["$ review", []],
      ["$20", []],
      ["$5k", []],
      ["$-a", []],
      ["$:a", []],
      ["$_a", []],
      ["$é", []],
      ["$Review", ["Review"]],
      ["$a", ["a"]],
      ["$code-review", ["code-review"]],
      ["$review2", ["review2"]],
      ["$webshop:release-checklist", ["webshop:release-checklist"]],
      ["$a-b:c-d", ["a-b:c-d"]],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("where a name ends", () => {
    it.each([
      ["run $review: now", ["review"]],
      ["$review:", ["review"]],
      ["$review-", ["review"]],
      ["$review:-:", ["review"]],
      ["$webshop:", ["webshop"]],
      ["$review.", ["review"]],
      ["$review,", ["review"]],
      ["($review) and $other!", ["other"]],
      ["$foo$bar", ["foo"]],
      ["$foo/bar", ["foo"]],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("offsets", () => {
    it("gives the index of the dollar sign and the index past the name", () => {
      expect(findSkillReferences("run $review: now")).toEqual([
        { name: "review", start: 4, end: 11 },
      ]);
    });

    it("finds several tokens in one text", () => {
      const text = "use $a then\n$webshop:release-checklist and $b-c.";
      expect(findSkillReferences(text)).toEqual([
        { name: "a", start: 4, end: 6 },
        { name: "webshop:release-checklist", start: 12, end: 38 },
        { name: "b-c", start: 43, end: 47 },
      ]);
      for (const { name, start, end } of findSkillReferences(text)) {
        expect(text.slice(start, end)).toBe(`$${name}`);
      }
    });

    it("gives no tokens for an empty text", () => {
      expect(findSkillReferences("")).toEqual([]);
    });
  });

  describe("inline code spans", () => {
    it.each([
      ["`$foo`", []],
      ["run `$foo` now", []],
      ["run ``$foo`` now", []],
      ["run ``a ` $foo`` now", []],
      ["`$a` $b `$c`", ["b"]],
      ["$a `$b` $c", ["a", "c"]],
      ["`a\n$foo`", []],
      // An unmatched backtick run is plain text.
      ["` $foo", ["foo"]],
      ["run ` $foo", ["foo"]],
      // Runs of different lengths do not close each other.
      ["`` $foo `", ["foo"]],
      ["`` $foo ```", ["foo"]],
      // The first run pairs with the next run of the same length.
      ["`a` $foo `b`", ["foo"]],
      ["`a $foo ``b`` $bar `", []],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("fenced code blocks", () => {
    it.each([
      ["```\n$foo\n```", []],
      ["~~~\n$foo\n~~~", []],
      ["```ts\n$foo\n```", []],
      ["   ```\n$foo\n   ```", []],
      ["````\n$foo\n```\n$bar\n`````", []],
      ["~~~~\n$foo\n~~~\n$bar\n~~~~~~", []],
      ["$a\n```\n$b\n```\n$c", ["a", "c"]],
      // The token on the line right after the closing fence is text again.
      ["```\n$foo\n```\n$bar", ["bar"]],
      ["```\n$foo\n```  \n$bar", ["bar"]],
      // An unclosed fence runs to the end of the text.
      ["$a\n```\n$b\n$c", ["a"]],
      ["$a\n~~~\n$b", ["a"]],
      // A fence of the other character, or a shorter one, does not close.
      ["```\n$foo\n~~~\n$bar", []],
      ["````\n$foo\n```\n$bar", []],
      // A closing fence has nothing after it.
      ["```\n$foo\n``` x\n$bar", []],
      // Four spaces of indent is not a fence.
      ["    ```\n$foo", ["foo"]],
      ["```\n$foo\n    ```\n$bar", []],
      // A fence needs three characters: two backticks are an unmatched run here.
      ["``\n$foo", ["foo"]],
      // A backtick fence has no backtick in its info string: this is an inline span.
      ["```x``` $foo", ["foo"]],
      ["```$foo``` $bar", ["bar"]],
      ["~~~ `x`\n$foo\n~~~", []],
      // A fence line inside text is not a fence.
      ["a ```\n$foo", ["foo"]],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });

    it("does not let an inline span reach across a fence", () => {
      expect(namesIn("a ` b\n```\nx\n```\n$foo ` c")).toEqual(["foo"]);
    });
  });
});

describe("isSkillReferencePrefix", () => {
  it.each([
    ["", true],
    ["r", true],
    ["re", true],
    ["Re", true],
    ["code-review", true],
    ["webshop:", true],
    ["webshop:release-", true],
    ["a1", true],
    ["2", false],
    ["-", false],
    [":", false],
    ["re view", false],
    ["re.", false],
    ["re\n", false],
    ["é", false],
    ["$", false],
  ])("%j gives %j", (typed, expected) => {
    expect(isSkillReferencePrefix(typed)).toBe(expected);
  });
});

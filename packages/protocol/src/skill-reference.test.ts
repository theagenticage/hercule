import { describe, expect, it } from "vitest";

import {
  escapeSkillReferences,
  findSkillReferences,
  isSkillReferencePrefix,
} from "./skill-reference";

/** Measures how long one scan of `text` takes, in milliseconds. */
const timeScan = (text: string): number => {
  const startedAt = performance.now();
  findSkillReferences(text);
  return performance.now() - startedAt;
};

/**
 * Measures how the scan time of a text grows when the text doubles. Each timing repeats the scan
 * until it has run for a few milliseconds and takes the best of a few such timings, so neither
 * the timer resolution nor a pause of the machine decides the result. A linear scan gives a
 * ratio near 2 and a quadratic one near 4.
 */
const measureGrowth = (build: (size: number) => string): number => {
  const size = 40_000;
  const bestTime = (text: string) => {
    const repeats = Math.min(200, Math.ceil(5 / Math.max(timeScan(text), 0.01)));
    const timings = Array.from({ length: 5 }, () => {
      const startedAt = performance.now();
      for (let repeat = 0; repeat < repeats; repeat += 1) findSkillReferences(text);
      return (performance.now() - startedAt) / repeats;
    });
    return Math.min(...timings);
  };
  return bestTime(build(size * 2)) / bestTime(build(size));
};

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
      // A name may start with a digit when each of its parts holds a letter.
      ["$20", []],
      ["$1.50", []],
      ["$2024", []],
      ["$20:foo", []],
      ["$foo:20", []],
      ["$foo::bar", []],
      ["$3d-modeling", ["3d-modeling"]],
      ["$3d:release", ["3d:release"]],
      ["$webshop:3d-modeling", ["webshop:3d-modeling"]],
      ["$5k", ["5k"]],
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

  describe("inline code spans and paragraphs", () => {
    it.each([
      // A span never reaches across a blank line.
      ["a ` b\n\n$foo ` c", ["foo"]],
      ["a ` b\n \t \n$foo ` c", ["foo"]],
      ["a ` b\r\n\r\n$foo ` c", ["foo"]],
      ["`a\n\n$foo\n\nb`", ["foo"]],
      ["`a\n$foo\nb`", []],
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

    it.each([
      ["```\r\n$foo\r\n```\r\n$bar", ["bar"]],
      ["```\r\n$foo\r\n```", []],
    ])("reads lines that end in CRLF: %j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("fenced code blocks inside containers", () => {
    it.each([
      // A fence in a block quote.
      ["> ```js\n> $review\n> ````", []],
      [">```\n>$review\n>```", []],
      ["> ```\n> $a\n> ```\n> $b", ["b"]],
      ["> ```\n> $a\n> ```\n$b", ["b"]],
      ["$a\n> ```\n> $b\n> ```\n$c", ["a", "c"]],
      // The quote ends at a line without `>`, and the fence with it.
      ["> ```\n> $a\n$b", ["b"]],
      ["> ```\n> $a\n\n$b", ["b"]],
      // A fence in a list item.
      ["- ```js\n  $review\n  ```", []],
      ["- ```\n  $a\n  ```\n  $b", ["b"]],
      ["- item\n  ```\n  $a\n  ```\n- $b", ["b"]],
      ["1. item\n   ```\n   $a\n\n   $b\n   ```\n$c", ["c"]],
      // The item ends at a line that is not indented, and the fence with it.
      ["- ```\n  $a\n$b", ["b"]],
      // The closing fence follows the opening one's rules inside a container too.
      ["- ```\n  $a\n  ``\n  $b\n  ```\n$c", ["c"]],
      ["> ```\n> $a\n> ~~~\n> $b", []],
      ["> ```\n> $a\n> ``` x\n> $b", []],
      // Containers nest.
      ["> - ```\n>   $a\n>   ```\n>   $b", ["b"]],
      ["- > ```\n  > $a\n  > ```\n  > $b", ["b"]],
      // A fence that starts a list item with no content line before it.
      ["-\n  ```\n  $a\n  ```", []],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("indented code blocks", () => {
    it.each([
      ["    $deploy", []],
      ["\t$deploy", []],
      ["text\n\n    $deploy", []],
      ["text\n\n    a\n\n    $deploy", []],
      ["    a\n    $deploy\nafter $b", ["b"]],
      ["    a\n$deploy", ["deploy"]],
      ["# Title\n    $deploy", []],
      // An indented line cannot interrupt a paragraph.
      ["text\n    $deploy", ["deploy"]],
      ["text $a\n    $deploy", ["a", "deploy"]],
      // Three spaces are not enough.
      ["   $deploy", ["deploy"]],
      // Inside a block quote and a list item the indent counts from the container.
      ["> text\n>\n>     $deploy", []],
      ["> $deploy", ["deploy"]],
      ["- item\n\n      $deploy", []],
      ["- item\n    $deploy", ["deploy"]],
      ["-     $deploy", []],
      // An indented fence marker is code, so what follows it is text again.
      ["    ```\n$foo", ["foo"]],
      // Code ends where a block that is not code starts.
      ["    a\n\n$foo\n\n    $bar", ["foo"]],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("inline code spans and block boundaries", () => {
    it.each([
      // A heading is a block of its own: the backticks around it do not pair.
      ["` $review\n# heading `", ["review"]],
      ["` a\n# heading `b` $review", ["review"]],
      // A heading can hold a span of its own.
      ["# `$review`", []],
      // Each list item and each block quote is a block of its own.
      ["- ` $review\n- end `", ["review"]],
      ["> ` $review\n\n> end `", ["review"]],
      ["` $review\n> end `", ["review"]],
      ["- ` $review\n  > end `", ["review"]],
      // A thematic break and a setext underline end the paragraph too.
      ["` $review\n***\nend `", ["review"]],
      ["` $review\n- - -\nend `", ["review"]],
      ["` $review\n===\nend `", ["review"]],
      // A line that continues the paragraph does not end it.
      ["`a\n$review\nb`", []],
      ["- `a\nb $review\n  c`", []],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("lazy continuation lines", () => {
    it.each([
      // The `a` line continues the paragraph, so the quote or list item stays open around it.
      ["> ` $review\na\n> `", []],
      ["- ` $review\na\n- `", ["review"]],
      ["- ` $review\na\n  `", []],
      ["1. ` $review\na\n   `", []],
      ["> - ` $review\n> a\n>   `", []],
      ["> - ` $review\n> a\n> `", []],
      ["> ` $review\na\nb\n> `", []],
      ["> a\n` $review\n> `", []],
      // The item stays open: after the blank line 4 spaces are 2 more than its content, not code.
      ["- a\nb\n\n    $review", ["review"]],
      ["- a\nb\n\n      $review", []],
      // A quote that stays open keeps its code too: the line after the paragraph needs `>` again.
      ["> ` $a\nb\n>\n> ` $review", ["a", "review"]],
      // A line that starts another block is not a continuation, so the quote or item ends.
      ["> ` $review\n- a\n> `", ["review"]],
      ["> ` $review\n# a\n> `", ["review"]],
      ["> ` $review\n***\n> `", ["review"]],
      ["> ` $review\n```\n> `", ["review"]],
      ["> ` $review\n> a\n\n> `", ["review"]],
      ["> ` $review\n\na\n> `", ["review"]],
      // After a fence or indented code there is no paragraph to continue.
      ["> ```\n> x\n> ```\n` $review\n> `", ["review"]],
      ["> ```\n> x\n` $review\n> `", ["review"]],
      [">     code\n` $review\n> `", ["review"]],
      ["- ```\n  x\n` $review\n- `", ["review"]],
      // An indented line cannot start a code block inside a paragraph, so it continues it lazily.
      ["> ` $review\n    a\n> `", []],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("headings, thematic breaks and setext underlines end a paragraph", () => {
    it.each([
      ["---\n    $review", []],
      ["***\n    $review", []],
      ["- - -\n    $review", []],
      ["text\n===\n    $review", []],
      ["text\n---\n    $review", []],
      ["text\n-\n    $review", []],
      ["text\n  ===  \n    $review", []],
      ["# heading\n    $review", []],
      ["###### heading\n    $review", []],
      ["> text\n> ===\n>     $review", []],
      // Without the end of a paragraph the indented line continues the text.
      ["text\n    $review", ["review"]],
      ["text\n====x\n    $review", ["review"]],
      ["text\n#hashtag\n    $review", ["review"]],
      // Four spaces make an underline into text.
      ["text\n    ===\n$review", ["review"]],
      // A lazy line is not an underline of the paragraph in the quote.
      ["> text\n===\n    $review", ["review"]],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("tabs", () => {
    it.each([
      // A tab after the `>` marker reaches column 4, and the marker takes one column of it.
      [">\t```\n> $review\n>\t```", []],
      [">\t```\n> $review\n>\t```\n> $after", ["after"]],
      // A tab after a list marker is the space that the marker needs.
      ["-\t```\n    $review\n    ```", []],
      ["- \t```\n    $review\n    ```", []],
      // Three columns of the tab are left after `>` and its one column, so this is code.
      [">\t\t$review", []],
      ["a\t\t$review", ["review"]],
      // A tab after text moves to the next multiple of 4 columns.
      ["ab\t    $review", ["review"]],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("escaped backticks", () => {
    it.each([
      // An escaped backtick is a literal backtick and opens no span.
      ["\\` $review \\`", ["review"]],
      ["\\\\\\` $review \\`", ["review"]],
      // An escaped backslash does not escape the backtick after it.
      ["\\\\` $review `", []],
      // An escaped run of two keeps its second backtick, which opens a span of one.
      ["\\`` $review `", []],
      ["\\`` $review ``", ["review"]],
      // Inside a span a backslash is literal, so it does not stop the closing run.
      ["`\\` $review", ["review"]],
      ["`$a \\` $review `", ["review"]],
      // A backslash before anything else changes nothing.
      ["\\$review `$b`", []],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("line endings", () => {
    it.each([
      ["```\r$review\r```\r$after", ["after"]],
      ["```\r\n$review\r\n```\r\n$after", ["after"]],
      ["```\r\n$review\n```\r$after", ["after"]],
      ["a ` b\r\r$review ` c", ["review"]],
      ["text\r\r    $review", []],
      ["---\r    $review", []],
      ["`a\r$review\rb`", []],
      // A CR before the LF is part of the line ending and not of the line.
      ["```\r\n$review\r\n```\r\n    $after", []],
    ])("%j gives %j", (text, names) => {
      expect(namesIn(text)).toEqual(names);
    });
  });

  describe("speed", () => {
    // A linear scan takes a few milliseconds here. The bound is generous, so it catches a
    // scan that grows with the square of the text and not a slow machine.
    const kilobytes64 = 64 * 1024;
    it.each([
      ["backtick pairs", "`a`".repeat(kilobytes64 / 3)],
      [
        "unmatched backtick runs of rising length",
        Array.from({ length: 360 }, (_, i) => "`".repeat(i + 1) + "a ")
          .join("")
          .slice(0, kilobytes64),
      ],
      ["tokens in code spans", "`$a` ".repeat(kilobytes64 / 5)],
      ["tokens", "$a ".repeat(kilobytes64 / 3)],
      [
        "nested containers and blank lines",
        `${"- ".repeat(8000)}\n${"\n".repeat(kilobytes64 / 2)}`,
      ],
      ["block quote markers", `${"> ".repeat(kilobytes64 / 4)}\n${"> ".repeat(kilobytes64 / 4)}`],
      ["fence lines", "```\n$a\n".repeat(kilobytes64 / 8)],
      ["lines", "x\n".repeat(kilobytes64 / 2)],
    ])("scans 64 KB of %s in under 50 ms", (_name, text) => {
      expect(timeScan(text)).toBeLessThan(50);
    });

    // Doubling the text must not much more than double the time. These shapes once made a regular
    // expression backtrack, so the time grew with the square of the text.
    it.each([
      ["a name with a dash inside", (size: number) => `$a${"-".repeat(size)}b`],
      ["a name with a colon inside", (size: number) => `$a${":".repeat(size)}b`],
      ["a fence line of backticks and a CR", (size: number) => `${"`".repeat(size)}\r $review`],
      ["a fence line of tildes and a CR", (size: number) => `${"~".repeat(size)}\r $review`],
      ["a closing fence line of backticks", (size: number) => `\`\`\`\n${"`".repeat(size)} x`],
      ["lines that end in a lone CR", (size: number) => "$a\r".repeat(size / 3)],
      ["a line of tabs", (size: number) => `${"\t".repeat(size)}$review`],
      ["a line of spaces and a letter", (size: number) => `${" ".repeat(size)}x`],
      ["a line of dashes and spaces", (size: number) => `${"- ".repeat(size / 2)}x`],
      ["escaped backticks", (size: number) => "\\` ".repeat(size / 3)],
      ["backslashes before a backtick", (size: number) => `${"\\".repeat(size)}\``],
      ["many headings", (size: number) => `${"#\n".repeat(size / 2)} $review`],
      [
        "many paragraphs split by blank lines",
        (size: number) => `${"a\n\n".repeat(size / 3)} $review`,
      ],
      ["many list items", (size: number) => `${"- a\n".repeat(size / 4)} $review`],
      ["many lazy continuation lines", (size: number) => `> a\n${"b\n".repeat(size / 2)}> $review`],
      ["runs of rising length", (size: number) => "`a ".repeat(size / 3) + "``".repeat(size / 4)],
    ])("scans %s in time that grows less than quadratically", (_name, build) => {
      expect(measureGrowth(build)).toBeLessThan(3);
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
    ["2", true],
    ["3d-modeling", true],
    ["20", true],
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

describe("escapeSkillReferences", () => {
  it.each([
    ["$review", "\\$review"],
    ["run $review now", "run \\$review now"],
    ["$webshop:release-checklist", "\\$webshop:release-checklist"],
    ["first\n$review\r\n$other", "first\n\\$review\r\n\\$other"],
    ["$review $review", "\\$review \\$review"],
    ["$review: now", "\\$review: now"],
    ["- $review\n> $other", "- \\$review\n> \\$other"],
    ["$foo$bar", "\\$foo$bar"],
  ])("escapes the dollar sign of each reference in %j", (text, escaped) => {
    expect(escapeSkillReferences(text)).toBe(escaped);
  });

  it.each([
    "",
    "plain text",
    "costs $20 or $1.50",
    "x$review",
    "($review)",
    "a `$review` b",
    "```\n$review\n```",
    "    $review",
    "already \\$review",
    "$ review",
    "$-a",
  ])("returns %j as it is, because it holds no reference", (text) => {
    expect(escapeSkillReferences(text)).toBe(text);
  });

  it("keeps the code and escapes the reference beside it", () => {
    expect(escapeSkillReferences("`$a` $b\n\n```\n$c\n```\n$d")).toBe(
      "`$a` \\$b\n\n```\n$c\n```\n\\$d",
    );
  });

  it("escapes only the references the filter accepts", () => {
    expect(escapeSkillReferences("$a $b $c", ({ name }) => name !== "b")).toBe("\\$a $b \\$c");
    expect(escapeSkillReferences("$a $b", () => false)).toBe("$a $b");
  });

  // Whatever the text, the escaped text holds no reference and nothing else has changed.
  it.each([
    "$a $b $c",
    "$a\n$b",
    "> $a\n> $b\n>\n>     $c",
    "- $a\n  - $b\n\n      $c",
    "1. $a\n   ```\n   $b\n   ```\n   $c",
    "`` $a ` $b `` $c",
    "```\n$a\n``` $b\n$c\n```\n$d",
    "~~~\n$a\n```\n$b\n~~~\n$c",
    "para\n    $a\n\n    $b\n\n$c",
    "\t$a\n\n\t$b",
    "$a:$b $c-$d $e::f $3d:release $20 $x",
    "\\$a \\\\$b $c\\ $d",
    "$ $a $\n$b",
    "`$a\n\n$b`\n$c",
  ])("leaves no reference in the escaped %j", (text) => {
    const escaped = escapeSkillReferences(text);
    expect(findSkillReferences(escaped)).toEqual([]);
    // The only change is one backslash before each reference.
    const backslashes = findSkillReferences(text).map(({ start }, index) => start + index);
    expect([...escaped].filter((_, index) => !backslashes.includes(index)).join("")).toBe(text);
  });
});

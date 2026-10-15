/**
 * Checks the Discussions screen's words:
 *
 * - `splitInlineCode` splits at code spans, drops the backticks, keeps an
 *   unpaired backtick as text, and returns no empty run.
 * - `stripCodeMarks` returns the words without the backticks.
 * - The two count lines are singular for one and plural otherwise, in the
 *   order the open Discussion and the narrow list each draw them.
 */
import { describe, expect, it } from "vitest";
import {
  describePostsAndSessions,
  describeSessionsAndPosts,
  splitInlineCode,
  stripCodeMarks,
} from "./discussion-text";

describe("splitInlineCode", () => {
  it("returns one plain run for text without code", () => {
    expect(splitInlineCode("Who owns the helpers?")).toEqual([
      { text: "Who owns the helpers?", isCode: false },
    ]);
  });

  it("splits an overlap subject into its words and its path", () => {
    expect(splitInlineCode("Edits overlap in `src/cart/totals.ts`")).toEqual([
      { text: "Edits overlap in ", isCode: false },
      { text: "src/cart/totals.ts", isCode: true },
    ]);
  });

  it("keeps text before, between and after several spans", () => {
    expect(splitInlineCode("Shared files: `a.ts` (session 3f9a2c1d). Then `b.ts`.")).toEqual([
      { text: "Shared files: ", isCode: false },
      { text: "a.ts", isCode: true },
      { text: " (session 3f9a2c1d). Then ", isCode: false },
      { text: "b.ts", isCode: true },
      { text: ".", isCode: false },
    ]);
  });

  it("keeps a path that starts with dots whole", () => {
    expect(splitInlineCode("Edits overlap in `...stripe/webhooks/refund.ts`")).toEqual([
      { text: "Edits overlap in ", isCode: false },
      { text: "...stripe/webhooks/refund.ts", isCode: true },
    ]);
  });

  it("leaves an unpaired backtick in the text", () => {
    expect(splitInlineCode("it`s `a.ts`")).toEqual([
      { text: "it", isCode: false },
      { text: "s ", isCode: true },
      { text: "a.ts`", isCode: false },
    ]);
    expect(splitInlineCode("one ` only")).toEqual([{ text: "one ` only", isCode: false }]);
  });

  it("drops an empty span and returns nothing for empty text", () => {
    expect(splitInlineCode("a `` b")).toEqual([
      { text: "a ", isCode: false },
      { text: " b", isCode: false },
    ]);
    expect(splitInlineCode("")).toEqual([]);
  });
});

describe("stripCodeMarks", () => {
  it("drops the backticks of a subject and keeps its words", () => {
    expect(stripCodeMarks("Edits overlap in `src/cart/totals.ts`")).toBe(
      "Edits overlap in src/cart/totals.ts",
    );
    expect(stripCodeMarks("No code here")).toBe("No code here");
  });
});

describe("the Discussion count lines", () => {
  it("writes the chip as sessions then posts, plural", () => {
    expect(describeSessionsAndPosts({ participantCount: 3, postCount: 6 })).toBe(
      "3 sessions · 6 posts",
    );
  });

  it("writes the narrow list's line as posts then sessions, singular for one", () => {
    expect(describePostsAndSessions({ participantCount: 1, postCount: 1 })).toBe(
      "1 post · 1 session",
    );
    expect(describePostsAndSessions({ participantCount: 2, postCount: 0 })).toBe(
      "0 posts · 2 sessions",
    );
  });
});

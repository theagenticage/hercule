/**
 * Tests `readCompactionDetail`, `describeCompactionTarget`,
 * `readUnknownLabel`, `readTodoListDetail`, `summarizeTodoList`,
 * `readToolCallName` and `readFetchedUrl`, which read the details every
 * adapter shares.
 */
import { describe, expect, it } from "vitest";
import {
  describeCompactionTarget,
  readCompactionDetail,
  readFetchedUrl,
  readTodoListDetail,
  readToolCallName,
  readUnknownLabel,
  summarizeTodoList,
} from "./item-detail";

describe("describeCompactionTarget", () => {
  it.each([
    [{ trigger: "auto", tokensBefore: 182_000, tokensAfter: 31_000 }, "182k → 31k tokens (auto)"],
    [
      { trigger: "manual", tokensBefore: 21_326, tokensAfter: 6086 },
      "21.3k → 6.1k tokens (manual)",
    ],
    [{ tokensBefore: 1_200_000, tokensAfter: 950 }, "1.2M → 950 tokens"],
    [{ trigger: "auto", tokensBefore: 182_000 }, "from 182k tokens (auto)"],
    [{ tokensBefore: 182_000 }, "from 182k tokens"],
    [{ trigger: "manual", tokensAfter: 31_000 }, "to 31k tokens (manual)"],
  ] as const)("reads %j as %s", (detail, target) => {
    expect(describeCompactionTarget(detail)).toBe(target);
  });

  it.each([
    ["an empty detail", {}],
    ["a trigger alone", { trigger: "auto" }],
    ["a summary alone", { summary: "The user asked for a login fix." }],
  ] as const)("reads %s as no words", (_name, detail) => {
    expect(describeCompactionTarget(detail)).toBe("");
  });
});

describe("readCompactionDetail", () => {
  it("returns the detail it decodes", () => {
    expect(readCompactionDetail({ trigger: "auto", tokensBefore: 182_000 })).toEqual({
      trigger: "auto",
      tokensBefore: 182_000,
    });
  });

  it("keeps only the fields it knows, so the old field names read as no counts", () => {
    // The shape the runner wrote before the shared detail existed.
    expect(
      readCompactionDetail({ trigger: "auto", preTokens: 182_000, postTokens: 31_000 }),
    ).toEqual({ trigger: "auto" });
  });

  it.each([
    ["no detail", undefined],
    ["a detail that is not an object", "compacted"],
    ["a count that is not a number", { tokensBefore: "182k" }],
    ["an unknown trigger", { trigger: "sometimes", tokensBefore: 182_000 }],
    ["a summary that is not text", { summary: 7 }],
  ])("returns nothing for %s", (_name, detail) => {
    expect(readCompactionDetail(detail)).toBeUndefined();
  });
});

describe("readUnknownLabel", () => {
  it("returns the label the detail holds", () => {
    expect(readUnknownLabel({ label: "claude: system/foo_bar" })).toBe("claude: system/foo_bar");
  });

  it.each([undefined, {}, { label: 7 }, { note: "review mode" }])("returns '' for %j", (detail) => {
    expect(readUnknownLabel(detail)).toBe("");
  });
});

describe("readTodoListDetail", () => {
  it("returns the list it decodes", () => {
    const detail = { steps: [{ text: "Run the tests", status: "in_progress" }] };

    expect(readTodoListDetail(detail)).toEqual(detail);
  });

  it.each([
    ["no detail", undefined],
    ["a detail with no steps", {}],
    ["a step with no text", { steps: [{ text: "", status: "pending" }] }],
    ["an unknown status", { steps: [{ text: "Run", status: "blocked" }] }],
  ])("returns nothing for %s", (_name, detail) => {
    expect(readTodoListDetail(detail)).toBeUndefined();
  });
});

describe("summarizeTodoList", () => {
  it("counts the completed steps and names the first step in progress", () => {
    expect(
      summarizeTodoList([
        { text: "Read", status: "completed" },
        { text: "Edit", status: "in_progress" },
        { text: "Test", status: "in_progress" },
        { text: "Ship", status: "pending" },
      ]),
    ).toEqual({ completed: 1, total: 4, progress: "1/4", current: "Edit" });
  });

  it("names no step when none is in progress, and handles an empty list", () => {
    expect(summarizeTodoList([{ text: "Read", status: "pending" }]).current).toBe("");
    expect(summarizeTodoList([])).toEqual({ completed: 0, total: 0, progress: "0/0", current: "" });
  });
});

describe("readToolCallName", () => {
  it.each([
    ["a local tool", { name: "Bash" }, "Bash"],
    [
      "a local MCP tool",
      { name: "mcp__github__create_issue", kind: "mcp" },
      "mcp__github__create_issue",
    ],
    [
      "an API connector tool",
      { name: "create_issue", kind: "mcp", server: "github" },
      "github/create_issue",
    ],
    ["an empty server", { name: "create_issue", server: "" }, "create_issue"],
    ["no name", { server: "github" }, ""],
    ["no detail", undefined, ""],
  ])("reads %s", (_name, detail, expected) => {
    expect(readToolCallName(detail)).toBe(expected);
  });
});

describe("readFetchedUrl", () => {
  it("returns the URL of a fetch, and nothing for a search or no detail", () => {
    expect(readFetchedUrl({ name: "WebFetch", url: "https://example.com" })).toBe(
      "https://example.com",
    );
    expect(readFetchedUrl({ name: "WebSearch", query: "effect" })).toBe("");
    expect(readFetchedUrl(undefined)).toBe("");
  });
});

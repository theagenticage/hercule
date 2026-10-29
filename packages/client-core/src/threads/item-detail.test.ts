/**
 * Tests `readCompactionDetail`, `describeCompactionTarget` and
 * `readUnknownLabel`, which read the details every adapter shares for a
 * compaction and an unknown item.
 */
import { describe, expect, it } from "vitest";
import { describeCompactionTarget, readCompactionDetail, readUnknownLabel } from "./item-detail";

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

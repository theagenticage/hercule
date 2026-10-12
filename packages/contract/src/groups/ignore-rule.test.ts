/**
 * Tests how an Ignore Rule's values are compared with a signal's, and how a
 * rule is put into words.
 */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  buildIgnoreRuleText,
  hasSameValues,
  IgnoreRuleCreateInput,
  isMatchedByRule,
  listLabeledValues,
  type SignalKindLabels,
} from "./ignore-rule";
import { MAX_SIGNAL_MATCH_FIELDS, MAX_SIGNAL_MATCH_VALUE_LENGTH } from "./signal";

const LABELS: SignalKindLabels = {
  label: "Review requested",
  matchFields: [
    { name: "repo", label: "Repository" },
    { name: "author", label: "Author" },
  ],
};

const SIGNAL_MATCH = { repo: "acme/webshop", author: "dependabot[bot]" };

/** Labels whose fields are named like properties every object inherits. */
const PROTOTYPE_LABELS: SignalKindLabels = {
  label: "Review requested",
  matchFields: [
    { name: "__proto__", label: "Proto" },
    { name: "constructor", label: "Constructor" },
    { name: "repo", label: "Repository" },
  ],
};

describe("IgnoreRuleCreateInput", () => {
  const decode = Schema.decodeUnknownExit(IgnoreRuleCreateInput);

  it("refuses a field name that is empty or too long, rather than dropping it", () => {
    for (const name of ["", "n".repeat(65)]) {
      const exit = decode({ kind: "acme/asked", match: { repo: "acme/webshop", [name]: "x" } });
      expect(exit._tag).toBe("Failure");
    }
    expect(decode({ kind: "acme/asked", match: { ["n".repeat(64)]: "x" } })._tag).toBe("Success");
  });

  it("refuses a rule larger than an answer may bind, though each value is within its limit", () => {
    const match = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `f${String(index)}`,
          "x".repeat(MAX_SIGNAL_MATCH_VALUE_LENGTH),
        ]),
      );
    expect(decode({ kind: "acme/asked", match: match(MAX_SIGNAL_MATCH_FIELDS) })._tag).toBe(
      "Failure",
    );
    expect(decode({ kind: "acme/asked", match: match(8) })._tag).toBe("Success");
  });
});

describe("isMatchedByRule", () => {
  it("matches when each of the rule's values equals the signal's", () => {
    expect(isMatchedByRule(SIGNAL_MATCH, { repo: "acme/webshop" })).toBe(true);
    expect(isMatchedByRule(SIGNAL_MATCH, SIGNAL_MATCH)).toBe(true);
  });

  it("does not match when one value differs, or names a field the signal lacks", () => {
    expect(isMatchedByRule(SIGNAL_MATCH, { repo: "acme/webshop", author: "octocat" })).toBe(false);
    expect(isMatchedByRule({ repo: "acme/webshop" }, SIGNAL_MATCH)).toBe(false);
    // Values are compared whole and by case.
    expect(isMatchedByRule(SIGNAL_MATCH, { repo: "Acme/webshop" })).toBe(false);
  });

  it("does not read a value the signal lacks from the properties every object inherits", () => {
    const ruleMatch = JSON.parse('{"__proto__":"[object Object]"}') as Record<string, string>;
    expect(isMatchedByRule({ repo: "acme/webshop" }, ruleMatch)).toBe(false);
    expect(isMatchedByRule(ruleMatch, ruleMatch)).toBe(true);
  });
});

describe("hasSameValues", () => {
  it("is true for the same fields and values in any order", () => {
    expect(hasSameValues(SIGNAL_MATCH, { author: "dependabot[bot]", repo: "acme/webshop" })).toBe(
      true,
    );
  });

  it("is false when one side has a field more, or a value differs", () => {
    expect(hasSameValues(SIGNAL_MATCH, { repo: "acme/webshop" })).toBe(false);
    expect(hasSameValues({ repo: "acme/webshop" }, SIGNAL_MATCH)).toBe(false);
    expect(hasSameValues(SIGNAL_MATCH, { ...SIGNAL_MATCH, author: "octocat" })).toBe(false);
  });
});

describe("listLabeledValues", () => {
  it("pairs each value with its field's label, in the order the kind declares the fields", () => {
    expect(listLabeledValues(LABELS, { author: "octocat", repo: "acme/webshop" })).toEqual([
      { field: "repo", label: "Repository", value: "acme/webshop" },
      { field: "author", label: "Author", value: "octocat" },
    ]);
  });

  it("shows a field the kind no longer declares by its name, after the declared ones", () => {
    expect(listLabeledValues(LABELS, { team: "core", author: "octocat" })).toEqual([
      { field: "author", label: "Author", value: "octocat" },
      { field: "team", label: "team", value: "core" },
    ]);
  });

  it("leaves out a declared field the match lacks, even one named like an inherited property", () => {
    expect(listLabeledValues(PROTOTYPE_LABELS, { repo: "acme/webshop" })).toEqual([
      { field: "repo", label: "Repository", value: "acme/webshop" },
    ]);
    const match = JSON.parse('{"__proto__":"a","constructor":"b"}') as Record<string, string>;
    expect(listLabeledValues(PROTOTYPE_LABELS, match)).toEqual([
      { field: "__proto__", label: "Proto", value: "a" },
      { field: "constructor", label: "Constructor", value: "b" },
    ]);
  });
});

describe("buildIgnoreRuleText", () => {
  it("joins the kind's label and each field's label and value", () => {
    expect(buildIgnoreRuleText(LABELS, SIGNAL_MATCH)).toBe(
      "Review requested · Repository acme/webshop · Author dependabot[bot]",
    );
    // Stored values are sorted by name; the text keeps the declared order.
    expect(buildIgnoreRuleText(LABELS, { author: "dependabot[bot]", repo: "acme/webshop" })).toBe(
      "Review requested · Repository acme/webshop · Author dependabot[bot]",
    );
    expect(buildIgnoreRuleText(LABELS, { author: "octocat" })).toBe(
      "Review requested · Author octocat",
    );
  });

  it("writes an empty value as (empty)", () => {
    expect(buildIgnoreRuleText(LABELS, { author: "" })).toBe("Review requested · Author (empty)");
  });
});

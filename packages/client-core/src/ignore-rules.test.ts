/**
 * Tests what an Ignore Rule's row in Settings > Signals shows: what the rule
 * caught, and which rules a plugin's section lists.
 */
import { describe, expect, it } from "vitest";
import { describeIgnoreRuleCatches, listPluginIgnoreRules } from "./ignore-rules";

const REVIEW = "github/review-requested";

describe("describeIgnoreRuleCatches", () => {
  it("counts the catches over the span events are kept", () => {
    expect(describeIgnoreRuleCatches(142, undefined)).toBe("Caught 142 in the last 90 days");
    expect(describeIgnoreRuleCatches(1, 1)).toBe("Caught 1 in the last day");
  });
});

describe("listPluginIgnoreRules", () => {
  it("keeps the rules of the plugin's kinds, in their order", () => {
    const buildRule = (id: string, kind: string) => ({
      id,
      kind,
      match: {},
      text: id,
      createdAt: "2026-10-10T09:00:00.000Z",
      actor: "user" as const,
      caughtCount: 0,
    });
    const rules = [
      buildRule("a", REVIEW),
      buildRule("b", "sentry/new-issue"),
      buildRule("c", "github/mentioned"),
    ];
    expect(listPluginIgnoreRules(rules, "github").map((rule) => rule.id)).toEqual(["a", "c"]);
    expect(listPluginIgnoreRules(rules, "linear")).toEqual([]);
  });
});

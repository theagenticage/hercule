import {
  MAX_SIGNAL_MATCH_VALUE_LENGTH,
  type IgnoreRuleCreateInput,
  type Signal,
} from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  canIgnoreSignal,
  describeIgnoreRuleCatches,
  describeOfferedRuleMatchCount,
  describeRuleMatchesTakenOff,
  isIgnoreRuleOffer,
  listDeclaredMatchValues,
  listPluginIgnoreRules,
  listSignalsMatchedByRule,
  readSignalKindLabels,
} from "./ignore-rules";

const REVIEW = "github/review-requested";

/** Builds an open review request on acme/webshop by dependabot, with the given fields changed. */
const buildSignal = (id: string, overrides: Partial<Signal> = {}): Signal => ({
  id,
  kind: REVIEW,
  origin: { type: "api", actor: "user", eventIds: [], reason: "test" },
  title: `Review ${id}`,
  priority: "normal",
  blocks: [],
  actions: [],
  match: { repo: "acme/webshop", author: "dependabot[bot]" },
  status: "open",
  createdAt: "2026-10-10T09:00:00.000Z",
  ...overrides,
});

describe("isIgnoreRuleOffer", () => {
  it("is true only for an offer that carries the rule its Ignore creates", () => {
    const rule = { kind: REVIEW, match: { repo: "acme/webshop" } };
    expect(isIgnoreRuleOffer(buildSignal("o", { kind: "offer", ignoreRule: rule }))).toBe(true);
    expect(isIgnoreRuleOffer(buildSignal("t", { kind: "offer" }))).toBe(false);
    expect(isIgnoreRuleOffer(buildSignal("s"))).toBe(false);
  });
});

describe("listSignalsMatchedByRule", () => {
  const rule: IgnoreRuleCreateInput = { kind: REVIEW, match: { repo: "acme/webshop" } };

  const listIds = (signals: ReadonlyArray<Signal>, sketch = rule): ReadonlyArray<string> =>
    listSignalsMatchedByRule(signals, sketch).map((signal) => signal.id);

  it("returns the open signals of the kind that hold every value of the rule", () => {
    const signals = [
      buildSignal("a"),
      buildSignal("b", { match: { repo: "acme/webshop", author: "marta" } }),
      buildSignal("c", { match: { repo: "acme/api", author: "dependabot[bot]" } }),
      buildSignal("d", { kind: "github/mentioned" }),
    ];
    expect(listIds(signals)).toEqual(["a", "b"]);
    expect(
      listIds(signals, { kind: REVIEW, match: { repo: "acme/webshop", author: "marta" } }),
    ).toEqual(["b"]);
  });

  it("returns snoozed signals, and leaves resolved ones out", () => {
    const signals = [
      buildSignal("a", {
        snooze: { until: "2026-10-13T07:00:00.000Z", snoozedAt: "2026-10-12T07:00:00.000Z" },
      }),
      buildSignal("b", { status: "resolved" }),
    ];
    expect(listIds(signals)).toEqual(["a"]);
  });

  it("returns a signal once when two lists hold it", () => {
    expect(listIds([buildSignal("a"), buildSignal("a")])).toEqual(["a"]);
  });

  it("leaves out a signal with no value for a field of the rule", () => {
    expect(listIds([buildSignal("a", { match: {} })])).toEqual([]);
  });
});

const REVIEW_LABELS = {
  label: "Review requested",
  matchFields: [
    { name: "repo", label: "Repository" },
    { name: "author", label: "Author" },
  ],
};

/** Builds a plugin as `plugin.query` lists it, reduced to the signal kinds it declares. */
const buildPlugin = (...kinds: ReadonlyArray<string>) => ({
  intake: {
    eventKinds: [],
    signalKinds: kinds.map((kind) => ({
      kind,
      ...REVIEW_LABELS,
      description: "",
      on: true,
      level: "default" as const,
    })),
  },
});

describe("readSignalKindLabels", () => {
  it("returns the labels the kind's plugin declares", () => {
    const plugins = [buildPlugin("sentry/issue"), buildPlugin("github/mentioned", REVIEW)];
    expect(readSignalKindLabels(plugins, REVIEW)).toMatchObject(REVIEW_LABELS);
  });

  it("labels the kind with its id when no plugin declares it", () => {
    expect(readSignalKindLabels([buildPlugin("github/mentioned")], REVIEW)).toEqual({
      label: REVIEW,
      matchFields: [],
    });
  });
});

describe("listDeclaredMatchValues", () => {
  it("returns the declared fields the match holds, in the declared order", () => {
    expect(
      listDeclaredMatchValues(REVIEW_LABELS, { author: "dependabot[bot]", repo: "acme/webshop" }),
    ).toEqual([
      { field: "repo", label: "Repository", value: "acme/webshop" },
      { field: "author", label: "Author", value: "dependabot[bot]" },
    ]);
  });

  it("leaves out a declared field the match has no value for, and a field the kind does not declare", () => {
    expect(listDeclaredMatchValues(REVIEW_LABELS, { author: "", branch: "main" })).toEqual([
      { field: "author", label: "Author", value: "" },
    ]);
  });

  it("leaves out a declared field named like an inherited property when the match lacks it", () => {
    const labels = {
      label: "Review requested",
      matchFields: [
        { name: "__proto__", label: "Proto" },
        { name: "constructor", label: "Constructor" },
      ],
    };
    expect(listDeclaredMatchValues(labels, { repo: "acme/webshop" })).toEqual([]);
    const match = JSON.parse('{"constructor":"b"}') as Record<string, string>;
    expect(listDeclaredMatchValues(labels, match)).toEqual([
      { field: "constructor", label: "Constructor", value: "b" },
    ]);
  });
});

describe("canIgnoreSignal", () => {
  it("is false when the signal's only declared value is longer than a rule can hold", () => {
    const long = "x".repeat(MAX_SIGNAL_MATCH_VALUE_LENGTH + 1);
    expect(canIgnoreSignal(buildSignal("a", { match: { repo: long } }), REVIEW_LABELS)).toBe(false);
    expect(
      listDeclaredMatchValues(REVIEW_LABELS, { repo: long, author: "dependabot[bot]" }),
    ).toEqual([{ field: "author", label: "Author", value: "dependabot[bot]" }]);
  });

  it("is true when the signal holds a value for a field its kind declares", () => {
    expect(canIgnoreSignal(buildSignal("a"), REVIEW_LABELS)).toBe(true);
  });

  it("is false when the kind declares no field the signal holds", () => {
    expect(canIgnoreSignal(buildSignal("a", { match: {} }), REVIEW_LABELS)).toBe(false);
    expect(canIgnoreSignal(buildSignal("a"), { label: REVIEW, matchFields: [] })).toBe(false);
  });
});

describe("describeOfferedRuleMatchCount", () => {
  it("counts the open signals the offer's rule matches", () => {
    expect(describeOfferedRuleMatchCount(3)).toBe("3 open now");
    expect(describeOfferedRuleMatchCount(0)).toBe("None open now");
  });
});

describe("describeRuleMatchesTakenOff", () => {
  it("says how many open signals the rule also takes off the list", () => {
    expect(describeRuleMatchesTakenOff(3)).toBe("This also takes 3 open signals off your list.");
    expect(describeRuleMatchesTakenOff(1)).toBe("This also takes 1 open signal off your list.");
    expect(describeRuleMatchesTakenOff(0)).toBe("No open signal matches it now.");
  });

  it("gives no number while the open signals are read, or when they cannot be", () => {
    expect(describeRuleMatchesTakenOff("reading")).toBe("Counting the open signals it matches…");
    expect(describeRuleMatchesTakenOff("failed")).toBe(
      "Could not count the open signals it matches.",
    );
  });
});

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

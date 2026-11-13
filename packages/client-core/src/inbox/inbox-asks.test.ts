import type { BoundAction } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildSignalLine } from "./cards.testing";
import { chooseCurrentAsk, isAnswerHeld, listPaneAsks, stepAsk } from "./inbox-asks";

const line = (id: string, createdAt: string, overrides = {}) =>
  buildSignalLine(id, id, { createdAt, ...overrides });

describe("listPaneAsks", () => {
  it("lists open, asking, unsnoozed lines newest first, ties by larger id first", () => {
    const { sections } = listPaneAsks({
      openCount: 5,
      signals: [
        line("a1", "2026-11-07T09:00:00.000Z"),
        line("b2", "2026-11-07T10:00:00.000Z"),
        line("a9", "2026-11-07T10:00:00.000Z"),
        line("c1", "2026-11-07T11:00:00.000Z", { snoozed: true }),
        line("d1", "2026-11-07T12:00:00.000Z", { asks: false }),
        line("e1", "2026-11-07T13:00:00.000Z", { status: "resolved" }),
      ],
    });
    expect(sections.map((s) => s.id)).toEqual(["b2", "a9", "a1"]);
  });

  it("counts the open signals the read left out", () => {
    const signals = [
      line("a1", "2026-11-07T09:00:00.000Z"),
      line("e1", "2026-11-07T08:00:00.000Z", { status: "resolved" }),
    ];
    expect(listPaneAsks({ signals, openCount: 4 }).hiddenOpenCount).toBe(3);
    expect(listPaneAsks({ signals, openCount: 1 }).hiddenOpenCount).toBe(0);
  });
});

describe("chooseCurrentAsk", () => {
  const sections = [
    line("new", "2026-11-07T12:00:00.000Z", { kind: "acme/mention" }),
    line("mid", "2026-11-07T11:00:00.000Z", { kind: "acme/review-requested" }),
    line("old", "2026-11-07T10:00:00.000Z", { kind: "acme/review-requested" }),
  ];

  it.each([
    ["the chosen ask while it is a section", ["acme/review-requested"], "old", "old"],
    [
      "the newest of the saved query's kinds with no choice",
      ["acme/review-requested"],
      undefined,
      "mid",
    ],
    ["the saved query's kind over a stale choice", ["acme/review-requested"], "gone", "mid"],
    ["the newest when the saved query names no kind here", ["acme/other"], undefined, "new"],
    ["the newest when the saved query names none", [], "gone", "new"],
  ])("picks %s", (_name, kinds, chosen, expected) => {
    expect(chooseCurrentAsk(sections, kinds, chosen)).toBe(expected);
  });

  it("returns nothing with no sections", () => {
    expect(chooseCurrentAsk([], ["acme/review-requested"], "x")).toBeUndefined();
  });
});

describe("stepAsk", () => {
  const sections = ["a", "b", "c"].map((id) => line(id, "2026-11-07T09:00:00.000Z"));

  it.each([
    ["b", 1, "c"],
    ["b", -1, "a"],
    ["c", 1, "c"],
    ["a", -1, "a"],
    ["gone", 1, "b"],
    [undefined, -1, "a"],
  ] as const)("from %s by %i goes to %s, without wrapping", (from, direction, expected) => {
    expect(stepAsk(sections, from, direction)).toBe(expected);
  });

  it("returns nothing with no sections", () => {
    expect(stepAsk([], undefined, 1)).toBeUndefined();
  });
});

describe("isAnswerHeld", () => {
  const answer = (operation: BoundAction["operation"]) => ({ operation });

  it.each([
    ["a plugin action", { op: "github/pr.approve", input: {} }, true],
    ["a core operation", { op: "run.start", input: {} }, false],
    ["an answer that runs nothing", null, false],
  ] as const)("is %s held: %s", (_name, operation, held) => {
    expect(isAnswerHeld(answer(operation as BoundAction["operation"]))).toBe(held);
  });
});

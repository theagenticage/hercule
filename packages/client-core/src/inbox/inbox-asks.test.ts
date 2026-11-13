import type { BoundAction } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildSignalLine } from "./cards.testing";
import { isAnswerHeld, listPaneAsks } from "./inbox-asks";

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

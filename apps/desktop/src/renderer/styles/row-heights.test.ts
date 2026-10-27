/**
 * Tests styles/row-heights.css, the heights of the rows that follow the Text
 * size: each registered property has its formula, the formula gives the
 * registered `initial-value` at the default step (which the tests of the
 * rows' lists read, because jsdom computes no `calc()`), and every height the
 * code reads is registered.
 */
import { describe, expect, it } from "vitest";
import rowHeights from "./row-heights.css?raw";
import { readLengths } from "../app/text-size";
import { LIST_HEIGHT_PROPERTIES } from "../screens/list-pane/list-row-sizes";
import { readIntakeListHeights } from "../screens/intake/list-heights";
import { ITEM_HEIGHT_PROPERTIES } from "../shell/sidebar-items";

/** The registered properties and their `initial-value`s, by name. */
const initialValues = new Map(
  [...rowHeights.matchAll(/@property\s+(--[\w-]+)\s*\{[^}]*?initial-value:\s*(\d+)px;/g)].map(
    ([, name, value]) => [name!, Number(value)] as const,
  ),
);

/** The formula each property is given on `:root`, by name. */
const formulas = new Map(
  [...rowHeights.matchAll(/^ {2}(--[\w-]+):\s*([^;]+);/gm)].map(
    ([, name, formula]) => [name!, formula!] as const,
  ),
);

/**
 * Returns what a formula of this file comes to at the default step: a sum of
 * products of pixels, numbers, `var(--line-16)`, `var(--line-18)` and
 * `var(--text-size-step)`, which is 0 at the default step.
 */
const computeAtDefaultStep = (formula: string): number =>
  formula
    .replace(/var\(--line-(\d+)\)/g, "$1")
    .replace(/var\(--text-size-step\)/g, "0")
    .replace(/calc\(|\)|px/g, "")
    .split("+")
    .reduce(
      (sum, term) =>
        sum + term.split("*").reduce((product, factor) => product * Number.parseFloat(factor), 1),
      0,
    );

describe("row-heights.css", () => {
  it("gives every registered property a formula on :root, and every formula a registered property", () => {
    expect(initialValues.size).toBeGreaterThan(0);
    expect([...formulas.keys()].sort()).toEqual([...initialValues.keys()].sort());
  });

  it("registers as each property's initial value what its formula comes to at the default step", () => {
    for (const [name, formula] of formulas) {
      expect(computeAtDefaultStep(formula), name).toBe(initialValues.get(name));
    }
  });

  it("grows a row by the step for each line of text it holds", () => {
    // A thread's row: a line of 18px and a line of 16px between 6px of padding.
    expect(formulas.get("--side-height-thread-row")).toBe(
      "calc(var(--line-18) + var(--line-16) + 18px)",
    );
    expect(formulas.get("--side-height-waiting-row")).toBe(
      "calc(38px + 2 * var(--text-size-step))",
    );
    expect(formulas.get("--list-height-one-line-row")).toBe("calc(40px + var(--text-size-step))");
  });
});

describe("the heights of the default Text size", () => {
  it("are the sidebar's, as the Bureau book measures them", () => {
    expect(readLengths(ITEM_HEIGHT_PROPERTIES)).toEqual({
      "waiting-header": 24,
      "waiting-thread-row": 38,
      "waiting-assistant-row": 38,
      "waiting-runs-label": 16,
      "waiting-run-row": 38,
      "project-header": 24,
      "group-row": 52,
      "group-line": 32,
      "quiet-line": 32,
      "draft-row": 52,
      "done-header": 24,
      "done-group-row": 52,
      more: 28,
      fewer: 28,
    });
  });

  it("are those of the lists beside an open item", () => {
    expect(readLengths(LIST_HEIGHT_PROPERTIES)).toEqual({
      groupHeading: 24,
      repositoryHeading: 22,
      oneLineRow: 40,
      twoLineRow: 52,
      columnRow: 46,
    });
  });

  it("are those of Intake's list and opened Tracking", () => {
    expect(readIntakeListHeights()).toEqual({ section: 40, signalRow: 52, trackingRow: 46 });
  });
});

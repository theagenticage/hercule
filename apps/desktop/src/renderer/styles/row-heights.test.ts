/**
 * Tests styles/row-heights.css, the heights of the rows that follow the Text
 * size: each registered property has a formula that gives its `initial-value`
 * at the default step (which the tests of the rows' lists read, because jsdom
 * computes no `calc()`), and a height that grows by the step for each line of
 * text the row holds. The formulas are evaluated (`evaluate-text-size-css.ts`),
 * so the tests do not depend on how they are written.
 */
import { describe, expect, it } from "vitest";
import { TEXT_SIZE_STEPS } from "../../ipc/appearance";
import { computeLengthAtStep, computeTextSizeStepPx } from "./evaluate-text-size-css";
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

describe("row-heights.css", () => {
  it("registers as each property's initial value its height at the default step, which a formula on :root gives it", () => {
    expect(initialValues.size).toBeGreaterThan(0);
    for (const [name, initial] of initialValues) {
      expect(computeLengthAtStep(name, 2), name).toBe(initial);
    }
  });

  it("makes each row the height it has at the default step, plus the step for each line of text it holds", () => {
    // The height at the default step, and how many lines of text the row holds.
    const rows: Record<string, readonly [height: number, lines: number]> = {
      "--side-height-header": [24, 1],
      "--side-height-waiting-row": [38, 2],
      "--side-height-runs-label": [16, 1],
      "--side-height-thread-row": [52, 2],
      "--side-height-group-line": [32, 1],
      "--side-height-more-row": [28, 1],
      "--list-height-group-heading": [24, 1],
      "--list-height-repository-heading": [22, 1],
      "--list-height-one-line-row": [40, 1],
      "--list-height-two-line-row": [52, 2],
      "--list-height-column-row": [46, 2],
      "--intake-height-section": [40, 1],
      "--intake-height-row": [52, 2],
      "--tracking-height-row": [46, 2],
      "--model-browser-height-row": [46, 2],
    };
    expect([...initialValues.keys()].sort()).toEqual(Object.keys(rows).sort());
    for (const [name, [height, lines]] of Object.entries(rows)) {
      for (const step of TEXT_SIZE_STEPS) {
        expect(computeLengthAtStep(name, step), `${name} at step ${String(step)}`).toBe(
          height + lines * computeTextSizeStepPx(step),
        );
      }
    }
  });

  it("moves the text tokens and the step by one pixel a step, from the second step", () => {
    expect(TEXT_SIZE_STEPS.map((step) => computeTextSizeStepPx(step))).toEqual([-1, 0, 1, 2]);
    expect(TEXT_SIZE_STEPS.map((step) => computeLengthAtStep("--t-13", step))).toEqual([
      12, 13, 14, 15,
    ]);
    // The titles do not follow the setting.
    expect(TEXT_SIZE_STEPS.map((step) => computeLengthAtStep("--t-18", step))).toEqual([
      18, 18, 18, 18,
    ]);
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

/**
 * Tests how the sessions drawing is laid out from a `SessionsDrawing`. How wide
 * a cell is, how many waiting sessions the bar draws, and what an away machine
 * counts as running, is decided by `describeFleetPage` in
 * `@hercule/client-core/fleet`, which has its own tests.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { describeFleetPage } from "@hercule/client-core/fleet";
import { EMPTY_RUNNER_METRICS_HISTORY } from "@hercule/client-core/metrics-history";
import { buildRunner, NOW, TIMEZONE } from "./fleet.testing";
import { SessionsFigure } from "./sessions-drawing";

/** Draws a machine with a cap of `cap`, `running` sessions and `waiting` more, as the page draws it. */
const draw = (cap: number, running: number, waiting: number, isAway = false): HTMLElement => {
  const runner = buildRunner({
    maxConcurrentSessions: cap,
    connectivity: isAway ? "offline" : "online",
  });
  const counts = {
    [runner.id]: { running, waiting, waitingThreads: waiting, openThreads: waiting },
  };
  const [machine] = describeFleetPage(
    [runner],
    counts,
    EMPTY_RUNNER_METRICS_HISTORY,
    null,
    TIMEZONE,
    NOW,
  ).machines;
  return render(<SessionsFigure drawing={machine!.drawing} size="card" />).container
    .firstElementChild as HTMLElement;
};

/**
 * Returns the segments of a drawn bar, each as the sessions it grows by and its kind. A cell does
 * not grow, because its width is the bar's `--fleet-cell`, so it reads as "cell".
 */
const readSegments = (figure: HTMLElement): string[] =>
  [...figure.querySelectorAll<HTMLElement>(":scope > i")].map((segment) => {
    const kind = segment.classList.contains("is-wait")
      ? "wait"
      : `run ${segment.style.getPropertyValue("--fleet-running")}`;
    return `${segment.style.flexGrow || "cell"} ${kind}`;
  });

/** Returns the width of every cell of a drawn bar, as the bar gives it to its cells. */
const readCellWidth = (figure: HTMLElement): string =>
  figure.style.getPropertyValue("--fleet-cell");

describe("SessionsFigure", () => {
  it.each([
    [4, "28px"],
    [8, "13px"],
    [16, "5px"],
    [24, "3px"],
    [30, "2px"],
  ])("draws a cap of %i as one cell per slot, each %s wide", (cap, width) => {
    const figure = draw(cap, 3, 0);

    expect(figure.classList.contains("is-cells")).toBe(true);
    expect(readCellWidth(figure)).toBe(width);
    expect(Number.isInteger(Number.parseFloat(width))).toBe(true);
    expect(readSegments(figure)).toEqual([
      ...Array<string>(3).fill("cell run 100%"),
      ...Array<string>(cap - 3).fill("cell run 0%"),
    ]);
  });

  it("draws no cell partly filled, so 9 of 24 is 9 filled cells", () => {
    const figure = draw(24, 9, 0);

    expect(figure.className).toBe("fleet-sessions fleet-sessions--card is-cells");
    expect(readSegments(figure)).toEqual([
      ...Array<string>(9).fill("cell run 100%"),
      ...Array<string>(15).fill("cell run 0%"),
    ]);
  });

  it("draws the waiting sessions as cells of the same width after the cap's rule", () => {
    const figure = draw(16, 12, 5);

    expect(readCellWidth(figure)).toBe("5px");
    expect(readSegments(figure)).toEqual([
      ...Array<string>(12).fill("cell run 100%"),
      ...Array<string>(4).fill("cell run 0%"),
      ...Array<string>(5).fill("cell wait"),
    ]);
    // The rule stands between the cap's last cell and the first waiting one.
    expect(figure.children[16]?.className).toBe("fleet-sessions-rule");
  });

  it("draws a cap of 31 as one continuous fill cut every 10 sessions, with no cells", () => {
    const figure = draw(31, 15, 0);

    expect(figure.className).toBe("fleet-sessions fleet-sessions--card");
    expect(readCellWidth(figure)).toBe("");
    expect(readSegments(figure)).toEqual(["10 run 100%", "10 run 50%", "10 run 0%", "1 run 0%"]);
  });

  it("draws the waiting part of a continuous fill after the cap's rule, cut every 10 sessions", () => {
    const figure = draw(100, 100, 12);

    expect(readSegments(figure)).toEqual([
      ...Array<string>(10).fill("10 run 100%"),
      "10 wait",
      "2 wait",
    ]);
    expect(figure.children[10]?.className).toBe("fleet-sessions-rule");
  });

  it("marks the cap with a rule and draws the sessions past it as filled cells", () => {
    const figure = draw(4, 6, 0);

    expect(readCellWidth(figure)).toBe("18px");
    // The machine page sizes the cells by the slots drawn, which include the sessions past the cap.
    expect(figure.style.getPropertyValue("--fleet-slots")).toBe("6");
    expect(readSegments(figure)).toEqual(Array<string>(6).fill("cell run 100%"));
    expect(figure.children[4]?.className).toBe("fleet-sessions-rule");
  });

  it("marks no cap while the sessions fit under it and nothing waits", () => {
    expect(draw(4, 4, 0).querySelector(".fleet-sessions-rule")).toBeNull();
  });

  it("draws the same cells with nothing running, and keeps the waiting ones, when the machine is away", () => {
    const figure = draw(16, 3, 2, true);

    expect(figure.classList.contains("is-away")).toBe(true);
    expect(readSegments(figure)).toEqual([
      ...Array<string>(16).fill("cell run 0%"),
      ...Array<string>(2).fill("cell wait"),
    ]);
  });
});

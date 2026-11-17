/**
 * Tests how the sessions drawing is laid out from a `SessionsDrawing`. How many
 * slots a segment holds, how many waiting sessions the bar draws, and what an
 * away machine counts as running, is decided by `describeFleetPage` in
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

/** Returns the segments of a drawn bar, as the slots each holds and its kind. */
const readSegments = (figure: HTMLElement): string[] =>
  [...figure.querySelectorAll<HTMLElement>(":scope > i")].map((segment) => {
    const kind = segment.classList.contains("is-wait")
      ? "wait"
      : `run ${segment.style.getPropertyValue("--fleet-running")}`;
    return `${segment.style.flexGrow} ${kind}`;
  });

describe("SessionsFigure", () => {
  it("draws one segment per slot at a cap of 16, with the waiting segments after the cap's rule", () => {
    const figure = draw(16, 12, 5);

    expect(readSegments(figure)).toEqual([
      ...Array<string>(12).fill("1 run 100%"),
      ...Array<string>(4).fill("1 run 0%"),
      ...Array<string>(5).fill("1 wait"),
    ]);
    // The rule stands between the cap's last segment and the first waiting one.
    expect(figure.children[16]?.className).toBe("fleet-sessions-rule");
  });

  it("draws a cap of 24 as 12 segments of 2 slots, with a half-filled segment for an odd count", () => {
    const figure = draw(24, 9, 0);

    expect(figure.className).toBe("fleet-sessions fleet-sessions--card");
    expect(readSegments(figure)).toEqual([
      ...Array<string>(4).fill("2 run 100%"),
      "2 run 50%",
      ...Array<string>(7).fill("2 run 0%"),
    ]);
  });

  it("draws a cap of 100 as 15 segments of 7 slots, the last one shorter, and waiting in the same size", () => {
    const segments = readSegments(draw(100, 100, 10));

    expect(segments.slice(0, 15)).toEqual([...Array<string>(14).fill("7 run 100%"), "2 run 100%"]);
    expect(segments.slice(15)).toEqual(["7 wait", "3 wait"]);
  });

  it("marks the cap with a rule and draws the sessions past it as filled segments", () => {
    const figure = draw(4, 6, 0);

    expect(readSegments(figure)).toEqual(Array<string>(6).fill("1 run 100%"));
    expect(figure.children[4]?.className).toBe("fleet-sessions-rule");
  });

  it("marks no cap while the sessions fit under it and nothing waits", () => {
    expect(draw(4, 4, 0).querySelector(".fleet-sessions-rule")).toBeNull();
  });

  it("draws the same segments with nothing running, and keeps the waiting ones, when the machine is away", () => {
    const figure = draw(16, 3, 2, true);

    expect(figure.classList.contains("is-away")).toBe(true);
    expect(readSegments(figure)).toEqual([
      ...Array<string>(16).fill("1 run 0%"),
      ...Array<string>(2).fill("1 wait"),
    ]);
  });
});

/**
 * Tests how the sessions drawing is laid out from a `SessionsDrawing`. Where a
 * machine's bar is cut, how many waiting sessions it draws, and what an away
 * machine counts as running, is decided by `describeFleetPage` in
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

describe("SessionsFigure", () => {
  it("draws one bar at a cap of 16, cut per slot, with the waiting part after the cap", () => {
    const figure = draw(16, 12, 5);
    const cap = figure.querySelector<HTMLElement>(".fleet-sessions-cap")!;
    const waiting = figure.querySelector<HTMLElement>("i.is-wait")!;

    expect(figure.querySelectorAll("i.is-run")).toHaveLength(1);
    expect(figure.querySelectorAll("i.is-wait")).toHaveLength(1);
    expect(cap.style.width).toBe(`${(16 / 21) * 100}%`);
    expect(cap.style.getPropertyValue("--fleet-cut")).toBe(`${(1 / 16) * 100}%`);
    expect(waiting.style.getPropertyValue("--fleet-cut")).toBe(`${(1 / 5) * 100}%`);
    expect(figure.querySelector<HTMLElement>("i.is-run")?.style.width).toBe("75%");
  });

  it("draws the same bar above a cap of 16, cut every 10 sessions in both parts", () => {
    const figure = draw(100, 100, 30);
    const cap = figure.querySelector<HTMLElement>(".fleet-sessions-cap")!;
    const waiting = figure.querySelector<HTMLElement>("i.is-wait")!;

    expect(figure.className).toBe("fleet-sessions fleet-sessions--card");
    expect(cap.style.getPropertyValue("--fleet-cut")).toBe("10%");
    expect(waiting.style.getPropertyValue("--fleet-cut")).toBe(`${(10 / 30) * 100}%`);
  });

  it("marks the cap with a rule when more sessions run than it allows", () => {
    const figure = draw(4, 6, 0);
    const rule = figure.querySelector<HTMLElement>(".fleet-sessions-rule");

    expect(figure.querySelector<HTMLElement>("i.is-run")?.style.width).toBe("100%");
    expect(rule?.style.left).toBe(`${(4 / 6) * 100}%`);
  });

  it("marks no cap while the sessions fit under it and nothing waits", () => {
    expect(draw(4, 4, 0).querySelector(".fleet-sessions-rule")).toBeNull();
  });

  it("draws the cap's rule in a bar that runs past a lowered cap", () => {
    const figure = draw(4, 100, 0);

    expect(figure.querySelector(".fleet-sessions-rule")).not.toBeNull();
  });

  it("draws nothing running and keeps the waiting part when the machine is away", () => {
    const figure = draw(16, 3, 2, true);

    expect(figure.classList.contains("is-away")).toBe(true);
    expect(figure.querySelector<HTMLElement>("i.is-run")?.style.width).toBe("0%");
    expect(figure.querySelectorAll("i.is-wait")).toHaveLength(1);
  });
});

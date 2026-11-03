/**
 * Tests how the sessions drawing is laid out from a `SessionsDrawing`. Which
 * shape a machine gets, how many waiting blocks, and what an away machine
 * counts as running, is decided by `describeFleetPage` in
 * `@hercule/client-core/fleet`, which has its own tests.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { describeFleetPage } from "@hercule/client-core/fleet";
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
  const [machine] = describeFleetPage([runner], counts, null, TIMEZONE, NOW).machines;
  return render(<SessionsFigure drawing={machine!.drawing} size="card" />).container
    .firstElementChild as HTMLElement;
};

describe("SessionsFigure", () => {
  it("draws one block per slot, then one per waiting session", () => {
    const figure = draw(16, 12, 5);

    expect(figure.querySelectorAll("i")).toHaveLength(21);
    expect(figure.querySelectorAll("i.is-run")).toHaveLength(12);
    expect(figure.querySelectorAll("i.is-wait")).toHaveLength(5);
  });

  it("draws a bar above a cap of 16, as one running stretch and one waiting stretch", () => {
    const figure = draw(17, 12, 5);

    expect(figure.classList.contains("fleet-sessions--bar")).toBe(true);
    expect(figure.querySelectorAll("i.is-run")).toHaveLength(1);
    expect(figure.querySelectorAll("i.is-wait")).toHaveLength(1);
  });

  it("marks the cap after its last block when more sessions run than it allows", () => {
    const figure = draw(4, 6, 2);
    const children = [...figure.children];

    expect(figure.querySelectorAll("i.is-run")).toHaveLength(6);
    expect(figure.querySelectorAll(".fleet-sessions-mark")).toHaveLength(1);
    // Four blocks, the mark, then the other two running ones.
    expect(children.slice(0, 4).every((child) => child.tagName === "I")).toBe(true);
    expect(children[4]?.className).toBe("fleet-sessions-mark");
    expect(children[5]?.tagName).toBe("I");
  });

  it("marks no cap while the sessions fit under it", () => {
    expect(draw(4, 4, 2).querySelectorAll(".fleet-sessions-mark")).toHaveLength(0);
  });

  it("cuts a bar every 10 sessions in the cap part and in the waiting part", () => {
    const figure = draw(100, 100, 30);
    const cap = figure.querySelector<HTMLElement>(".fleet-sessions-cap")!;
    const waiting = figure.querySelector<HTMLElement>("i.is-wait")!;

    expect(cap.style.getPropertyValue("--fleet-cut")).toBe("10%");
    expect(waiting.style.getPropertyValue("--fleet-cut")).toBe(`${(10 / 30) * 100}%`);
  });

  it("draws the cap's rule in a bar that runs past a lowered cap", () => {
    const figure = draw(4, 100, 0);

    expect(figure.classList.contains("fleet-sessions--bar")).toBe(true);
    expect(figure.querySelector(".fleet-sessions-rule")).not.toBeNull();
  });

  it("draws the cap's slots empty and keeps the waiting blocks when the machine is away", () => {
    const figure = draw(16, 3, 2, true);

    expect(figure.querySelectorAll("i.is-run")).toHaveLength(0);
    expect(figure.querySelectorAll("i:not(.is-wait)")).toHaveLength(16);
    expect(figure.querySelectorAll("i.is-wait")).toHaveLength(2);
  });
});

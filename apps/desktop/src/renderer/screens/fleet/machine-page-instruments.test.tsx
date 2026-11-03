/**
 * Tests the three instruments of a machine's page: what each tile shows of the
 * `MachineInstruments` it is given. What the values and notes say is decided by
 * `describeMachinePage` in `@hercule/client-core/machine-page`.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { MachineGraphs } from "@hercule/client-core/machine-graphs";
import type { MachineInstruments } from "@hercule/client-core/machine-page";
import { MachinePageInstruments } from "./machine-page-instruments";

const INSTRUMENTS: MachineInstruments = {
  sessions: {
    value: "12",
    unit: " of 16",
    level: "you",
    note: "5 waiting",
    drawing: {
      shape: "blocks",
      cap: 16,
      running: 12,
      free: 4,
      waiting: 5,
      waitingBlocks: 5,
      isAway: false,
      runningText: "12",
      capText: " of 16",
      waitingText: "5 waiting",
    },
  },
  cpu: {
    value: "34",
    unit: "%",
    level: "normal",
    share: 0.34,
    note: "Peak 71% in the last minute",
  },
  memory: {
    value: "55",
    unit: "%",
    level: "normal",
    share: 0.55,
    note: "29.0 GB free of 64 GB",
  },
};

const GRAPHS: MachineGraphs = {
  sessions: {
    running: [
      [
        { x: 0.1, y: 0.5 },
        { x: 0.2, y: 0.5 },
      ],
      [
        { x: 0.6, y: 0.75 },
        { x: 0.7, y: 0.75 },
      ],
    ],
    waiting: [
      [
        { x: 0.6, low: 0.75, high: 1 },
        { x: 0.7, low: 0.75, high: 1 },
      ],
    ],
    capY: 0.8,
  },
  cpu: {
    average: [
      [
        { x: 0, y: 0.2 },
        { x: 1, y: 0.4 },
      ],
    ],
    peak: [
      [
        { x: 0, low: 0.2, high: 0.5 },
        { x: 1, low: 0.4, high: 0.7 },
      ],
    ],
  },
  memory: {
    inUse: [
      [
        { x: 0, y: 0.5 },
        { x: 1, y: 0.55 },
      ],
    ],
    highest: [
      [
        { x: 0, low: 0.5, high: 0.6 },
        { x: 1, low: 0.55, high: 0.65 },
      ],
    ],
    youY: 0.8,
    failY: 0.92,
  },
};

/** Renders the instruments and returns each tile as its text, in the order drawn. */
const readTiles = (container: HTMLElement): readonly string[] =>
  Array.from(container.querySelectorAll(".machine-page-instrument"), (tile) => tile.textContent);

describe("MachinePageInstruments", () => {
  it("draws Sessions, CPU and Memory, in that order, each with its label, value, unit and note", () => {
    const { container } = render(
      <MachinePageInstruments instruments={INSTRUMENTS} graphs={GRAPHS} />,
    );

    expect(readTiles(container)).toEqual([
      "Sessions12 of 165 waiting",
      "CPU34%Peak 71% in the last minute",
      "Memory55%29.0 GB free of 64 GB",
    ]);
  });

  it("gives each meter its instrument's share and level, and the sessions a drawing instead of a meter", () => {
    const { container } = render(
      <MachinePageInstruments
        graphs={GRAPHS}
        instruments={{ ...INSTRUMENTS, memory: { ...INSTRUMENTS.memory, level: "you" } }}
      />,
    );

    const [sessions, cpu, memory] = Array.from(
      container.querySelectorAll<HTMLElement>(".machine-page-instrument"),
    );
    expect(sessions!.querySelector(".fleet-meter")).toBeNull();
    expect(sessions!.querySelector(".fleet-sessions")).not.toBeNull();
    expect(sessions!.classList.contains("machine-page-instrument--you")).toBe(true);
    expect(cpu!.querySelector<HTMLElement>(".fleet-meter i")!.style.width).toBe("34%");
    expect(memory!.querySelector(".fleet-meter--you")).not.toBeNull();
  });

  it("draws a dash and no unit for an instrument the machine has not reported", () => {
    const { container } = render(
      <MachinePageInstruments
        graphs={GRAPHS}
        instruments={{
          ...INSTRUMENTS,
          cpu: {
            value: "–",
            unit: "",
            level: "normal",
            share: null,
            note: "First reading within a minute",
          },
        }}
      />,
    );

    expect(readTiles(container)[1]).toBe("CPU–First reading within a minute");
    expect(container.querySelector<HTMLElement>(".fleet-meter i")!.style.width).toBe("0%");
  });

  it("draws a machine that is away in quieter inks, with its instruments as given", () => {
    const { container } = render(
      <MachinePageInstruments
        graphs={GRAPHS}
        instruments={{
          ...INSTRUMENTS,
          sessions: {
            ...INSTRUMENTS.sessions,
            value: "–",
            drawing: { ...INSTRUMENTS.sessions.drawing, isAway: true },
          },
        }}
      />,
    );

    expect(readTiles(container)).toEqual([
      "Sessions– of 165 waiting",
      "CPU34%Peak 71% in the last minute",
      "Memory55%29.0 GB free of 64 GB",
    ]);
    expect(container.querySelector(".machine-page-instruments-box.is-away")).not.toBeNull();
    expect(container.querySelector(".fleet-sessions.is-away")).not.toBeNull();
  });

  it("draws a gap in the history as two strokes of one path, and a band as a closed shape", () => {
    const { container } = render(
      <MachinePageInstruments instruments={INSTRUMENTS} graphs={GRAPHS} />,
    );

    const [sessions] = Array.from(container.querySelectorAll(".machine-page-instrument"));
    const line = sessions!.querySelector(".machine-graph-line")!.getAttribute("d")!;
    expect(line.match(/M/g)).toHaveLength(2);
    expect(line).toBe("M10,20 L20,20 M60,10.5 L70,10.5");
    const waiting = sessions!.querySelector(".machine-graph-waiting")!.getAttribute("d")!;
    expect(waiting).toBe("M60,1 L70,1 L70,10.5 L60,10.5 Z");
  });

  it("draws a run of one point as a dot, and a band of one point as a vertical stroke", () => {
    const { container } = render(
      <MachinePageInstruments
        instruments={INSTRUMENTS}
        graphs={{
          ...GRAPHS,
          cpu: {
            average: [[{ x: 0.5, y: 0 }]],
            peak: [
              [{ x: 0.5, low: 0, high: 0.5 }],
              [
                { x: 0.7, low: 0.1, high: 0.2 },
                { x: 0.8, low: 0.1, high: 0.3 },
              ],
            ],
          },
        }}
      />,
    );

    const cpu = container.querySelectorAll(".machine-page-instrument")[1]!;
    expect(cpu.querySelector(".machine-graph-line")!.getAttribute("d")).toBe("M50,39 L50,39");
    expect(cpu.querySelector(".machine-graph-band")!.getAttribute("d")).toBe(
      "M50,20 L50,39 Z M70,31.4 L80,27.6 L80,35.2 L70,35.2 Z",
    );
    expect(cpu.querySelector(".machine-graph-band-single")!.getAttribute("d")).toBe(
      "M50,20 L50,39",
    );
  });

  it("draws no single-point stroke for a band whose runs are all longer", () => {
    const { container } = render(
      <MachinePageInstruments instruments={INSTRUMENTS} graphs={GRAPHS} />,
    );

    expect(container.querySelector(".machine-graph-band-single")).toBeNull();
    expect(container.querySelector(".machine-graph-waiting-single")).toBeNull();
  });

  it("shows the instrument's note once, in the frame of a graph with nothing to draw", () => {
    const sentence = "This machine's runner is too old to report CPU. Update it.";
    const { container } = render(
      <MachinePageInstruments
        graphs={{ ...GRAPHS, cpu: null }}
        instruments={{
          ...INSTRUMENTS,
          cpu: { value: "–", unit: "", level: "normal", share: null, note: sentence },
        }}
      />,
    );

    const cpu = container.querySelectorAll(".machine-page-instrument")[1]!;
    expect(cpu.querySelector("svg")).toBeNull();
    expect(cpu.querySelector(".machine-graph-frame")!.textContent).toBe(sentence);
    expect(cpu.textContent).toBe(`CPU–${sentence}`);
    expect(cpu.querySelector(".machine-page-instrument-note")).toBeNull();
  });
});

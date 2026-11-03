/**
 * Tests the four instruments of a machine's page: what each tile shows of the
 * `MachineInstruments` it is given. What the values and notes say is decided by
 * `describeMachinePage` in `@hercule/client-core/machine-page`.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { MachineInstruments } from "@hercule/client-core/machine-page";
import { MachinePageInstruments } from "./machine-page-instruments";

const INSTRUMENTS: MachineInstruments = {
  sessions: {
    value: "12",
    unit: " of 16",
    level: "you",
    share: null,
    note: "5 waiting",
    drawing: { shape: "blocks", cap: 16, running: 12, free: 4, waiting: 5, waitingBlocks: 5 },
  },
  cpu: {
    value: "34",
    unit: "%",
    level: "normal",
    share: 0.34,
    note: "Peak 71% in the last minute",
  },
  memory: { value: "55", unit: "%", level: "normal", share: 0.55, note: "29.0 GB free of 64 GB" },
  disk: { value: "87", unit: "%", level: "you", share: 0.87, note: "500 GB free of 4,000 GB" },
};

/** Renders the instruments and returns each tile as its text, in the order drawn. */
const readTiles = (container: HTMLElement): readonly string[] =>
  Array.from(container.querySelectorAll(".machine-page-instrument"), (tile) => tile.textContent);

describe("MachinePageInstruments", () => {
  it("draws Sessions, CPU, Memory and Disk, each with its label, value, unit and note", () => {
    const { container } = render(
      <MachinePageInstruments instruments={INSTRUMENTS} isAway={false} />,
    );

    expect(readTiles(container)).toEqual([
      "Sessions12 of 165 waiting",
      "CPU34%Peak 71% in the last minute",
      "Memory55%29.0 GB free of 64 GB",
      "Disk87%500 GB free of 4,000 GB",
    ]);
  });

  it("fills a meter to its share, in the colour of its level, and the sessions have the drawing instead of a meter", () => {
    const { container } = render(
      <MachinePageInstruments instruments={INSTRUMENTS} isAway={false} />,
    );

    const [sessions, cpu, , disk] = Array.from(
      container.querySelectorAll<HTMLElement>(".machine-page-instrument"),
    );
    expect(sessions!.querySelector(".fleet-meter")).toBeNull();
    expect(sessions!.querySelectorAll(".fleet-sessions i")).toHaveLength(21);
    expect(sessions!.classList.contains("machine-page-instrument--you")).toBe(true);
    expect(cpu!.querySelector<HTMLElement>(".fleet-meter i")!.style.width).toBe("34%");
    expect(disk!.querySelector(".fleet-meter--you")).not.toBeNull();
  });

  it("draws an empty meter and a free-space value for a disk whose size is not known", () => {
    const { container } = render(
      <MachinePageInstruments
        instruments={{
          ...INSTRUMENTS,
          disk: {
            value: "412",
            unit: " GB free",
            level: "normal",
            share: null,
            note: "This machine's runner does not report its disk size. Update it to see how full the disk is.",
          },
        }}
        isAway={false}
      />,
    );

    const disk = readTiles(container)[3];
    expect(disk).toBe(
      "Disk412 GB freeThis machine's runner does not report its disk size. Update it to see how full the disk is.",
    );
    const meters = container.querySelectorAll<HTMLElement>(".fleet-meter i");
    expect(meters[2]!.style.width).toBe("0%");
  });

  it("draws a dash and no unit for an instrument the machine has not reported", () => {
    const { container } = render(
      <MachinePageInstruments
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
        isAway={false}
      />,
    );

    expect(readTiles(container)[1]).toBe("CPU–First reading within a minute");
  });

  it("draws a machine that is away in quieter inks, with its instruments as given", () => {
    const { container } = render(
      <MachinePageInstruments
        instruments={{ ...INSTRUMENTS, sessions: { ...INSTRUMENTS.sessions, value: "–" } }}
        isAway
      />,
    );

    expect(readTiles(container)).toEqual([
      "Sessions– of 165 waiting",
      "CPU34%Peak 71% in the last minute",
      "Memory55%29.0 GB free of 64 GB",
      "Disk87%500 GB free of 4,000 GB",
    ]);
    expect(container.querySelector(".machine-page-instruments-box.is-away")).not.toBeNull();
    expect(container.querySelector(".fleet-sessions.is-away")).not.toBeNull();
  });
});

/**
 * Tests the parts a machine's card and list row both draw: the status dot, the
 * gauge's number, the meter and the need line. What a need says is decided by `describeFleetPage`
 * in `@hercule/client-core/fleet`.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  BUSY_MACHINE,
  FULL_DISK_MACHINE,
  NEARLY_FULL_DISK_MACHINE,
  OFFLINE_MACHINE,
} from "./fleet.testing";
import { GaugeValue, Meter, NeedLine, StatusDot } from "./machine-parts";

describe("StatusDot", () => {
  it("hides itself from assistive technology, because a label is drawn beside it", () => {
    render(<StatusDot status={{ tone: "offline", label: "Offline" }} />);

    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names the state itself where no label is drawn", () => {
    render(<StatusDot status={{ tone: "online", label: "Online" }} namesState />);

    expect(screen.getByRole("img", { name: "Online" })).toBeTruthy();
  });
});

describe("GaugeValue", () => {
  it("draws the value with its unit in small after it", () => {
    const { container } = render(<GaugeValue gauge={{ value: "87", unit: "%" }} />);

    expect(container.querySelector("b")?.textContent).toBe("87%");
    expect(container.querySelector("b > small")?.textContent).toBe("%");
  });

  it("draws no small for an empty unit", () => {
    const { container } = render(<GaugeValue gauge={{ value: "–", unit: "" }} />);

    expect(container.querySelector("b")?.textContent).toBe("–");
    expect(container.querySelector("small")).toBeNull();
  });
});

describe("Meter", () => {
  const readWidth = (container: HTMLElement): string | undefined =>
    container.querySelector<HTMLElement>("i")?.style.width;

  it("fills to its share", () => {
    expect(readWidth(render(<Meter share={0.25} level="normal" />).container)).toBe("25%");
  });

  it("draws empty for a share that is not known", () => {
    expect(readWidth(render(<Meter share={null} level="normal" />).container)).toBe("0%");
  });
});

describe("NeedLine", () => {
  it("draws the Allow button it is given beside a need of waiting sessions", () => {
    render(
      <NeedLine
        need={BUSY_MACHINE.need}
        allow={<button type="button">Allow 17</button>}
        cleanUp={null}
      />,
    );

    expect(screen.getByText("5 threads wait for a slot")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow 17" })).toBeTruthy();
  });

  it("draws the Clean up button it is given beside a disk need", () => {
    for (const machine of [FULL_DISK_MACHINE, NEARLY_FULL_DISK_MACHINE]) {
      const { unmount } = render(
        <NeedLine
          need={machine.need}
          allow={null}
          cleanUp={<button type="button">Clean up…</button>}
        />,
      );
      expect(screen.getByRole("button", { name: "Clean up…" })).toBeTruthy();
      unmount();
    }
  });

  it("draws no Clean up button beside a need that is not about the disk", () => {
    render(
      <NeedLine
        need={BUSY_MACHINE.need}
        allow={null}
        cleanUp={<button type="button">Clean up…</button>}
      />,
    );

    expect(screen.queryByRole("button", { name: "Clean up…" })).toBeNull();
  });

  it("draws no button for an offline machine", () => {
    render(
      <NeedLine
        need={OFFLINE_MACHINE.need}
        allow={null}
        cleanUp={<button type="button">Clean up…</button>}
      />,
    );

    expect(screen.getByText("Offline since 09:12")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { MachineKind } from "@hercule/client-core/fleet";
import { MachineIcon } from "./machine-icon";

describe("MachineIcon", () => {
  it("draws a different icon for each kind of machine", () => {
    const kinds: ReadonlyArray<MachineKind> = ["laptop", "desktop", "server"];
    const drawings = kinds.map((kind) => render(<MachineIcon kind={kind} />).container.innerHTML);
    expect(new Set(drawings).size).toBe(kinds.length);
  });

  it("draws at the size it is given", () => {
    const { container } = render(<MachineIcon kind="server" size={14} />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("14");
  });
});

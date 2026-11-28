/**
 * Tests how a status icon from a plugin is coloured: in the plugin's colour
 * when it declares one, otherwise in the status's tone.
 */
import type { EntityStatus } from "@hercule/contract";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EntityStatusIcon } from "./status-shape";

const status = (overrides: Partial<EntityStatus>): EntityStatus => ({
  shape: "alert",
  tone: "bad",
  label: "Regressed",
  icon: { paths: ["M2 2h12v12H2Z"] },
  ...overrides,
});

describe("a status icon", () => {
  it("is drawn in its status's tone when the plugin declares no colour", () => {
    const { container } = render(<EntityStatusIcon status={status({})} size={14} />);
    const icon = container.querySelector("svg");
    expect(icon?.classList.contains("tone-bad")).toBe(true);
    expect(icon?.getAttribute("style")).toBeNull();
  });

  it("keeps the plugin's colour when it declares one", () => {
    const { container } = render(<EntityStatusIcon status={status({ hue: 150 })} size={14} />);
    const icon = container.querySelector("svg");
    expect(icon?.classList.contains("tone-bad")).toBe(false);
    expect(icon?.getAttribute("style")).toContain("oklch(");
  });
});

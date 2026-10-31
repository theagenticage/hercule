import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { HarnessLogo } from "../index";

describe("HarnessLogo", () => {
  it.each(["claude-code", "codex"])("draws %s as an SVG in the current colour", (harnessId) => {
    const { container } = render(<HarnessLogo harnessId={harnessId} />);

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("fill")).toBe("currentColor");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws pi as the character π, not as an SVG", () => {
    const { container } = render(<HarnessLogo harnessId="pi" />);

    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("π");
  });

  it("draws nothing for a provider it has no mark for", () => {
    const { container } = render(<HarnessLogo harnessId="something-else" />);

    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("");
  });
});

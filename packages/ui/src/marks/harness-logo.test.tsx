import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { HarnessLogo } from "../index";

describe("HarnessLogo", () => {
  it.each(["claude-code/claude-code", "codex/codex"])(
    "draws %s as an SVG in the current colour",
    (harnessId) => {
      const { container } = render(<HarnessLogo harnessId={harnessId} />);

      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute("fill")).toBe("currentColor");
      expect(svg!.getAttribute("aria-hidden")).toBe("true");
    },
  );

  it("draws pi as the character π, not as an SVG", () => {
    const { container } = render(<HarnessLogo harnessId="pi/pi" />);

    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("π");
  });

  it.each(["something-else/something-else", "claude-code", "codex", "pi"])(
    "draws nothing for %s, which is not a qualified harness id it has a mark for",
    (harnessId) => {
      const { container } = render(<HarnessLogo harnessId={harnessId} />);

      expect(container.querySelector("svg")).toBeNull();
      expect(container.textContent).toBe("");
    },
  );
});

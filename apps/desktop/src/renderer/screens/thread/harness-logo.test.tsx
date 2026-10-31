/**
 * Tests that `HarnessLogo` draws a mark for each shipped harness, by its
 * qualified id, and nothing for an id it does not know. A mark keyed by a
 * stale id would silently draw nothing, so each id is checked here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { HarnessLogo } from "./harness-logo";

afterEach(cleanup);

describe("HarnessLogo", () => {
  it.each(["claude-code/claude-code", "codex/codex"])("draws %s as an SVG mark", (harnessId) => {
    const { container } = render(<HarnessLogo harnessId={harnessId} size={13} />);

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("fill")).toBe("currentColor");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws pi as the character π, not as an SVG", () => {
    const { container } = render(<HarnessLogo harnessId="pi/pi" size={13} />);

    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("π");
  });

  it.each(["something-else/something-else", "claude-code", "codex", "pi"])(
    "draws nothing for %s, which is not a qualified harness id it has a mark for",
    (harnessId) => {
      const { container } = render(<HarnessLogo harnessId={harnessId} size={13} />);

      expect(container.innerHTML).toBe("");
    },
  );
});

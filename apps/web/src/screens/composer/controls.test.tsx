/**
 * Tests `PillLabel`, the content of the model pill: the account and "in pi"
 * show only when the pill has them, and only the model name may shrink.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ModelPill } from "@hercule/client-core";
import { PillLabel } from "./controls";

const PILL: ModelPill = {
  harnessId: "claude-code/claude-code",
  account: null,
  name: "Claude Sonnet 5",
  inHarness: null,
};

describe("PillLabel", () => {
  it("draws only the model name when the pill has no account and runs in the default harness", () => {
    const { container } = render(<PillLabel pill={PILL} />);

    expect(container.textContent?.trim()).toBe("Claude Sonnet 5");
    expect(screen.queryByText(/^in /)).toBeNull();
  });

  it("draws the harness after the model name when it is not the account's default", () => {
    const { container } = render(<PillLabel pill={{ ...PILL, inHarness: "pi" }} />);

    expect(container.textContent?.trim()).toBe("Claude Sonnet 5 in pi");
    // The name is the only part that truncates, so "in pi" never wraps or clips.
    expect(screen.getByText("Claude Sonnet 5").className).toContain("truncate");
    expect(screen.getByText("in pi").className).toContain("shrink-0");
    expect(screen.getByText("in pi").className).toContain("text-faint");
  });
});

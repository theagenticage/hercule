/**
 * Tests how a sentence of the Fleet screen is drawn from its parts. The words
 * themselves are decided by `@hercule/client-core/fleet`.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FleetText } from "./fleet-text";

describe("FleetText", () => {
  it("draws a count in the you ink, a number in bold, code as code and plain text as it is", () => {
    const { container } = render(
      <FleetText
        parts={[
          { text: "Three", kind: "count" },
          { text: " machines, ", kind: "plain" },
          { text: "14", kind: "number" },
          { text: " sessions, run ", kind: "plain" },
          { text: "hercule runner join", kind: "code" },
        ]}
      />,
    );

    expect(screen.getByText("Three").classList.contains("is-you")).toBe(true);
    expect(screen.getByText("14", { selector: "b" })).toBeTruthy();
    expect(screen.getByText("hercule runner join", { selector: "code" })).toBeTruthy();
    expect(container.textContent).toBe("Three machines, 14 sessions, run hercule runner join");
  });
});

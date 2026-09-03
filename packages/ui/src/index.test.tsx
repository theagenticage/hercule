import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Logo } from "./index";

describe("Logo", () => {
  it("renders the wordmark", () => {
    render(<Logo />);
    expect(screen.getByTestId("logo").textContent).toBe("Hydra");
  });
});

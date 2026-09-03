import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("renders the wordmark", () => {
    render(<App />);
    expect(screen.getByTestId("logo").textContent).toBe("Hydra");
  });
});

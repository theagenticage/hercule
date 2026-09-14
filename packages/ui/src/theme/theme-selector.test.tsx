import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memoryStorage } from "../testing";
import { ThemeSelector } from "./theme-selector";

/** What the pre-paint script leaves behind is this test's starting state. */
const painted = (theme: string | null): void => {
  if (theme === null) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
};

/** The document attribute is the one thing one render may leave on the next. */
afterEach(() => {
  painted(null);
});

describe("ThemeSelector", () => {
  it("says the system choice at rest, and opens nothing", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    render(<ThemeSelector />);
    expect(screen.getByRole("button", { name: "Theme System" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("takes its starting choice from what the document was painted with", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    painted("dark");
    render(<ThemeSelector />);
    expect(screen.getByRole("button", { name: "Theme Dark" })).toBeTruthy();
  });

  it("paints the document and remembers a picked theme", async () => {
    const held = memoryStorage({ "hydra:theme": "light" });
    vi.stubGlobal("localStorage", held);
    painted("light");
    render(<ThemeSelector />);

    await userEvent.click(screen.getByRole("button", { name: "Theme Light" }));
    await userEvent.click(row("Dark"));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(held.getItem("hydra:theme")).toBe("dark");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Theme Dark" })).toBeTruthy();
  });

  it("returns to the machine's own appearance, remembered as no choice at all", async () => {
    const held = memoryStorage({ "hydra:theme": "dark" });
    vi.stubGlobal("localStorage", held);
    painted("dark");
    render(<ThemeSelector />);

    await userEvent.click(screen.getByRole("button", { name: "Theme Dark" }));
    await userEvent.click(row("System"));

    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(held.getItem("hydra:theme")).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Theme System" })).toBeTruthy();
  });
});

/** The one option row the open popover shows under this name. */
const row = (name: string): HTMLElement =>
  within(screen.getByRole("dialog", { name: "Theme" })).getByRole("button", { name });

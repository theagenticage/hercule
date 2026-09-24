import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryStorage } from "../testing";
import { ThemeSelector } from "./theme-selector";

/**
 * Sets the document's `data-theme` attribute the way the pre-paint script does,
 * or removes it for `null`, to give a test its starting state.
 */
const setDocumentTheme = (theme: string | null): void => {
  if (theme === null) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
};

/** The theme attribute on the document outlives a render, so remove it after each test. */
afterEach(() => {
  setDocumentTheme(null);
});

describe("ThemeSelector", () => {
  it("shows the system choice while closed, and opens no popover", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    render(<ThemeSelector />);
    expect(screen.getByRole("button", { name: "Theme System" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("takes its starting choice from the document's theme attribute", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    setDocumentTheme("dark");
    render(<ThemeSelector />);
    expect(screen.getByRole("button", { name: "Theme Dark" })).toBeTruthy();
  });

  it("applies a picked theme to the document and saves it", async () => {
    const held = createMemoryStorage({ "hercule:theme": "light" });
    vi.stubGlobal("localStorage", held);
    setDocumentTheme("light");
    render(<ThemeSelector />);

    await userEvent.click(screen.getByRole("button", { name: "Theme Light" }));
    await userEvent.click(getThemeOption("Dark"));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(held.getItem("hercule:theme")).toBe("dark");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Theme Dark" })).toBeTruthy();
  });

  it("goes back to the system appearance, and saves that as no stored choice", async () => {
    const held = createMemoryStorage({ "hercule:theme": "dark" });
    vi.stubGlobal("localStorage", held);
    setDocumentTheme("dark");
    render(<ThemeSelector />);

    await userEvent.click(screen.getByRole("button", { name: "Theme Dark" }));
    await userEvent.click(getThemeOption("System"));

    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(held.getItem("hercule:theme")).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Theme System" })).toBeTruthy();
  });

  it("is a radio group with one option checked, and only that option in the tab order", async () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    render(<ThemeSelector />);

    await userEvent.click(screen.getByRole("button", { name: "Theme System" }));

    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(group).toBeTruthy();
    for (const name of ["Light", "Dark", "System"]) {
      const radio = within(group).getByRole("radio", { name });
      expect(radio.getAttribute("aria-checked"), name).toBe(String(name === "System"));
      expect(radio.tabIndex, name).toBe(name === "System" ? 0 : -1);
    }
    // Focus arrives on the checked option, so the arrow keys work at once.
    expect(within(group).getByRole("radio", { name: "System" })).toBe(document.activeElement);
  });

  it("moves the check with the arrow keys, applying each theme and staying open", async () => {
    const held = createMemoryStorage();
    vi.stubGlobal("localStorage", held);
    render(<ThemeSelector />);

    await userEvent.click(screen.getByRole("button", { name: "Theme System" }));
    // Down from System wraps to Light; one more lands on Dark.
    await userEvent.keyboard("{ArrowDown}");
    expect(document.documentElement.dataset.theme).toBe("light");
    await userEvent.keyboard("{ArrowDown}");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(held.getItem("hercule:theme")).toBe("dark");
    const dark = screen.getByRole("radio", { name: "Dark" });
    expect(dark.getAttribute("aria-checked")).toBe("true");
    // Focus follows the check, and the popover is still open to keep browsing.
    expect(dark).toBe(document.activeElement);
    expect(screen.getByRole("dialog", { name: "Theme" })).toBeTruthy();
  });
});

/** Returns the option with this name in the open popover. */
const getThemeOption = (name: string): HTMLElement =>
  within(screen.getByRole("dialog", { name: "Theme" })).getByRole("radio", { name });

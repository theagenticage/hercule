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
    const held = memoryStorage({ "hercule:theme": "light" });
    vi.stubGlobal("localStorage", held);
    painted("light");
    render(<ThemeSelector />);

    await userEvent.click(screen.getByRole("button", { name: "Theme Light" }));
    await userEvent.click(option("Dark"));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(held.getItem("hercule:theme")).toBe("dark");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Theme Dark" })).toBeTruthy();
  });

  it("returns to the machine's own appearance, remembered as no choice at all", async () => {
    const held = memoryStorage({ "hercule:theme": "dark" });
    vi.stubGlobal("localStorage", held);
    painted("dark");
    render(<ThemeSelector />);

    await userEvent.click(screen.getByRole("button", { name: "Theme Dark" }));
    await userEvent.click(option("System"));

    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(held.getItem("hercule:theme")).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Theme System" })).toBeTruthy();
  });

  it("is a radio group: one option checked, and it alone in the tab order", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
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

  it("moves the check with the arrow keys, painting as it goes and staying open", async () => {
    const held = memoryStorage();
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

/** The one option row the open popover shows under this name. */
const option = (name: string): HTMLElement =>
  within(screen.getByRole("dialog", { name: "Theme" })).getByRole("radio", { name });

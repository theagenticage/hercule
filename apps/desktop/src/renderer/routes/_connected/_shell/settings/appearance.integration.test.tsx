/**
 * Tests Settings > Appearance: the theme cards, Follow the system with its
 * day and night themes, the Glass slider, and Reduce transparency, alone
 * and under macOS's own setting. Each change must be saved through the
 * bridge, except the steps of a Glass drag, which are only shown.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_APPEARANCE } from "../../../../../ipc/appearance";
import type { Appearance } from "../../../../../ipc/contract";
import { forgetLastSettingsSection } from "../../../../app/last-settings-section";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
} from "../../../../app/testing";

afterEach(() => {
  forgetLastSettingsSection();
  vi.restoreAllMocks();
});

/**
 * Makes `window.matchMedia` match the media queries in `matching`, as macOS
 * does while it is dark or reduces transparency, and no other.
 */
const matchMediaQueries = (matching: readonly string[]): void => {
  const original = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...original(query),
    matches: matching.includes(query),
  }));
};

/**
 * Opens Settings > Appearance signed in, with `appearance` as the Appearance
 * main keeps.
 */
const openAppearance = async (appearance: Appearance = DEFAULT_APPEARANCE) => {
  stubApi(buildSidebarHandlers(SIDEBAR_FIXTURE));
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer", appearance });
  const app = await renderApp(fake, { path: "/settings/appearance" });
  await screen.findByRole("heading", { level: 1, name: "Appearance" });
  return { fake, ...app };
};

/** Returns the theme cards, in the page's order. */
const listCards = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>(".tp"),
];

/** Returns the text of the pressed theme cards. */
const listPressedCards = (): string[] =>
  listCards()
    .filter((card) => card.getAttribute("aria-pressed") === "true")
    .map((card) => card.textContent ?? "");

describe("Settings > Appearance", () => {
  it("says it saves on this Mac, and draws a card for each of the five themes", async () => {
    await openAppearance();

    expect(document.querySelector(".bar .time")?.textContent).toBe("Saved on this Mac");
    expect(listCards().map((card) => card.textContent)).toEqual([
      "Whitehaven light",
      "Styles light",
      "Orient Express dark",
      "Nile dark",
      "End House dark",
    ]);
  });

  it("presses the day theme's card while macOS is light", async () => {
    await openAppearance();
    expect(listPressedCards()).toEqual(["Whitehaven light"]);
  });

  it("presses the night theme's card while macOS is dark", async () => {
    matchMediaQueries(["(prefers-color-scheme: dark)"]);
    await openAppearance({ ...DEFAULT_APPEARANCE, nightTheme: "nile" });
    expect(listPressedCards()).toEqual(["Nile dark"]);
  });

  it("saves a picked card as the theme, with Follow the system off", async () => {
    const { fake } = await openAppearance();

    await userEvent.click(screen.getByRole("button", { name: "End House dark" }));

    expect(fake.appearanceWrites).toEqual([
      { ...DEFAULT_APPEARANCE, followSystem: false, theme: "end-house" },
    ]);
    expect(listPressedCards()).toEqual(["End House dark"]);
    expect(
      screen.getByRole("switch", { name: "Follow the system" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("turns Follow the system off keeping the theme in use, and on again", async () => {
    matchMediaQueries(["(prefers-color-scheme: dark)"]);
    const { fake } = await openAppearance();
    const follow = screen.getByRole("switch", { name: "Follow the system" });
    expect(follow.getAttribute("aria-checked")).toBe("true");

    await userEvent.click(follow);
    await userEvent.click(follow);

    expect(fake.appearanceWrites).toEqual([
      { ...DEFAULT_APPEARANCE, followSystem: false, theme: "orient-express" },
      { ...DEFAULT_APPEARANCE, followSystem: true, theme: "orient-express" },
    ]);
    expect(follow.getAttribute("aria-checked")).toBe("true");
  });

  it("saves the day and the night theme, offering only light themes by day and dark ones by night", async () => {
    const { fake } = await openAppearance();
    const day = screen.getByRole<HTMLSelectElement>("combobox", { name: "Day theme" });
    const night = screen.getByRole<HTMLSelectElement>("combobox", { name: "Night theme" });
    expect([...day.options].map((option) => option.text)).toEqual(["Whitehaven", "Styles"]);
    expect([...night.options].map((option) => option.text)).toEqual([
      "Orient Express",
      "Nile",
      "End House",
    ]);

    await userEvent.selectOptions(day, "Styles");
    await userEvent.selectOptions(night, "End House");

    expect(fake.appearanceWrites).toEqual([
      { ...DEFAULT_APPEARANCE, dayTheme: "styles" },
      { ...DEFAULT_APPEARANCE, dayTheme: "styles", nightTheme: "end-house" },
    ]);
    expect(listPressedCards()).toEqual(["Styles light"]);
    expect(
      screen.getByText("Switches with macOS: Styles by day, End House by night."),
    ).toBeTruthy();
  });

  it("shows each step of a Glass drag without saving it, and saves where the drag ends", async () => {
    const { fake } = await openAppearance();
    const shown: Appearance[] = [];
    const record = (event: Event): void => {
      shown.push((event as CustomEvent<Appearance>).detail);
    };
    document.addEventListener("appearancechange", record);
    onTestFinished(() => {
      document.removeEventListener("appearancechange", record);
    });
    const slider = screen.getByRole<HTMLInputElement>("slider", { name: "Glass" });
    expect(slider.value).toBe("40");
    expect(slider.getAttribute("aria-valuetext")).toBe("40%");

    fireEvent.input(slider, { target: { value: "55" } });
    fireEvent.input(slider, { target: { value: "70" } });

    expect(shown.map((appearance) => appearance.glassPercent)).toEqual([55, 70]);
    expect(slider.getAttribute("aria-valuetext")).toBe("70%");
    expect(document.querySelector(".range-out")?.textContent).toBe("70%");
    expect(fake.appearanceWrites).toEqual([]);

    fireEvent.change(slider);

    expect(fake.appearanceWrites).toEqual([{ ...DEFAULT_APPEARANCE, glassPercent: 70 }]);
  });

  it("saves each key step of the Glass slider once its key is released, or when focus leaves", async () => {
    const { fake } = await openAppearance();
    const slider = screen.getByRole<HTMLInputElement>("slider", { name: "Glass" });

    // Chromium fires `input` and `change` on every key press of a range.
    const pressKey = (value: string): void => {
      fireEvent.keyDown(slider, { key: "ArrowRight" });
      fireEvent.input(slider, { target: { value } });
      fireEvent.change(slider);
    };
    pressKey("41");
    pressKey("42");

    expect(fake.appearanceWrites).toEqual([]);
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(fake.appearanceWrites).toEqual([{ ...DEFAULT_APPEARANCE, glassPercent: 42 }]);

    // Tab's keyup lands on the next element, so only the blur saves.
    pressKey("43");
    fireEvent.blur(slider);
    expect(fake.appearanceWrites).toEqual([
      { ...DEFAULT_APPEARANCE, glassPercent: 42 },
      { ...DEFAULT_APPEARANCE, glassPercent: 43 },
    ]);
  });

  it("keeps the Glass level a drag shows when a theme is picked before the drag ends", async () => {
    const { fake } = await openAppearance();
    const slider = screen.getByRole<HTMLInputElement>("slider", { name: "Glass" });

    fireEvent.input(slider, { target: { value: "70" } });
    await userEvent.click(screen.getByRole("button", { name: "Nile dark" }));

    expect(fake.appearanceWrites).toEqual([
      { ...DEFAULT_APPEARANCE, followSystem: false, theme: "nile", glassPercent: 70 },
    ]);
  });

  it("saves Reduce transparency", async () => {
    const { fake } = await openAppearance();
    const reduce = screen.getByRole("switch", { name: "Reduce transparency" });
    expect(reduce.getAttribute("aria-checked")).toBe("false");

    await userEvent.click(reduce);

    expect(fake.appearanceWrites).toEqual([{ ...DEFAULT_APPEARANCE, reduceTransparency: true }]);
    expect(reduce.getAttribute("aria-checked")).toBe("true");
  });

  it("shows Reduce transparency as on, and disables it, while macOS's own is on", async () => {
    matchMediaQueries(["(prefers-reduced-transparency: reduce)"]);
    await openAppearance();
    const reduce = screen.getByRole<HTMLButtonElement>("switch", { name: "Reduce transparency" });

    expect(reduce.getAttribute("aria-checked")).toBe("true");
    expect(reduce.disabled).toBe(true);
    expect(reduce.getAttribute("aria-describedby")).not.toBeNull();
    expect(document.getElementById(reduce.getAttribute("aria-describedby")!)?.textContent).toMatch(
      /^macOS has Reduce transparency on/,
    );
  });
});

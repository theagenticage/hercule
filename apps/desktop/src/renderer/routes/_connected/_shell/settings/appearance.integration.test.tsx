/**
 * Tests Settings > Appearance: the theme cards, Follow the system with its
 * day and night themes, the Glass slider, and Reduce transparency, alone
 * and under macOS's own setting. Each change must be saved through the
 * bridge, except the steps of a Glass drag, which are only shown. A save
 * that fails shows its error under its own row.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_APPEARANCE } from "../../../../../ipc/appearance";
import type { Appearance, AppearanceSaveOutcome } from "../../../../../ipc/contract";
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
 * main keeps, and `saveAppearance` answering each save.
 */
const openAppearance = async (
  appearance: Appearance = DEFAULT_APPEARANCE,
  saveAppearance: (next: Appearance) => Promise<AppearanceSaveOutcome> = () =>
    Promise.resolve({ _tag: "Saved" }),
) => {
  stubApi(buildSidebarHandlers(SIDEBAR_FIXTURE));
  const fake = createFakeBridge({
    controllerUrl: CONTROLLER_URL,
    token: "bearer",
    appearance,
    saveAppearance,
  });
  const app = await renderApp(fake, { path: "/settings/appearance" });
  await screen.findByRole("heading", { level: 1, name: "Appearance" });
  return { fake, ...app };
};

/** Answers the next save as main does when the settings file could not be written. */
const failNextSave = (): ((next: Appearance) => Promise<AppearanceSaveOutcome>) => {
  let failed = false;
  return () => {
    const outcome: AppearanceSaveOutcome = failed
      ? { _tag: "Saved" }
      : { _tag: "NotSaved", reason: "the settings file could not be written" };
    failed = true;
    return Promise.resolve(outcome);
  };
};

/** The error a row shows when its save fails. */
const SAVE_ERROR = "Could not save: the settings file could not be written";

/**
 * Checks that `error` is shown right under the row or cards that hold
 * `control`, and that no other row shows an error.
 */
const expectErrorUnder = (error: HTMLElement, control: HTMLElement): void => {
  expect(error.previousElementSibling?.contains(control)).toBe(true);
  expect(screen.getAllByRole("alert")).toEqual([error]);
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

    await waitFor(() => {
      expect(fake.appearanceWrites).toEqual([{ ...DEFAULT_APPEARANCE, glassPercent: 70 }]);
    });
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

    await Promise.resolve();
    expect(fake.appearanceWrites).toEqual([]);
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    await waitFor(() => {
      expect(fake.appearanceWrites).toEqual([{ ...DEFAULT_APPEARANCE, glassPercent: 42 }]);
    });

    // Tab's keyup lands on the next element, so only the blur saves.
    pressKey("43");
    fireEvent.blur(slider);
    await waitFor(() => {
      expect(fake.appearanceWrites).toEqual([
        { ...DEFAULT_APPEARANCE, glassPercent: 42 },
        { ...DEFAULT_APPEARANCE, glassPercent: 43 },
      ]);
    });
  });

  it("saves a theme picked during a Glass drag without the Glass level, and keeps showing it", async () => {
    const { fake } = await openAppearance();
    const slider = screen.getByRole<HTMLInputElement>("slider", { name: "Glass" });

    fireEvent.input(slider, { target: { value: "70" } });
    await userEvent.click(screen.getByRole("button", { name: "Nile dark" }));

    await waitFor(() => {
      expect(fake.appearanceWrites).toEqual([
        { ...DEFAULT_APPEARANCE, followSystem: false, theme: "nile" },
      ]);
    });
    expect(slider.value).toBe("70");
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

  it("shows a failed theme save under the theme cards, puts the card back, and clears it on the next save", async () => {
    await openAppearance(DEFAULT_APPEARANCE, failNextSave());

    await userEvent.click(screen.getByRole("button", { name: "End House dark" }));

    expectErrorUnder(
      await screen.findByText(SAVE_ERROR),
      screen.getByRole("button", { name: "End House dark" }),
    );
    expect(listPressedCards()).toEqual(["Whitehaven light"]);

    await userEvent.click(screen.getByRole("button", { name: "Nile dark" }));

    await waitFor(() => {
      expect(screen.queryByText(SAVE_ERROR)).toBeNull();
    });
    expect(listPressedCards()).toEqual(["Nile dark"]);
  });

  it("shows a failed Follow the system save under its row, and turns the switch back", async () => {
    await openAppearance(DEFAULT_APPEARANCE, failNextSave());
    const follow = screen.getByRole("switch", { name: "Follow the system" });

    await userEvent.click(follow);

    expectErrorUnder(await screen.findByText(SAVE_ERROR), follow);
    expect(follow.getAttribute("aria-checked")).toBe("true");
  });

  it("shows a failed Glass save under the slider, and puts the slider back where it was saved", async () => {
    await openAppearance(DEFAULT_APPEARANCE, failNextSave());
    const slider = screen.getByRole<HTMLInputElement>("slider", { name: "Glass" });

    fireEvent.input(slider, { target: { value: "70" } });
    fireEvent.change(slider);

    expectErrorUnder(await screen.findByText(SAVE_ERROR), slider);
    expect(slider.value).toBe("40");
  });

  it("shows a failed Reduce transparency save under its row, and turns the switch back", async () => {
    await openAppearance(DEFAULT_APPEARANCE, failNextSave());
    const reduce = screen.getByRole("switch", { name: "Reduce transparency" });

    await userEvent.click(reduce);

    expectErrorUnder(await screen.findByText(SAVE_ERROR), reduce);
    expect(reduce.getAttribute("aria-checked")).toBe("false");
  });
});

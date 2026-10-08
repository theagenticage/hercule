/**
 * Tests the store of the Appearance the page shows: the one read from main,
 * a change that is only shown, a change that is saved, a save that fails,
 * and the event that tells `theme-init.js` to apply each change.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../../ipc/appearance";
import type { Appearance, AppearanceSaveOutcome } from "../../ipc/contract";
import { createAppearanceStore } from "./appearance";

/** The Appearance main keeps in these tests: Nile, not following the system. */
const SAVED: Appearance = { ...DEFAULT_APPEARANCE, followSystem: false, theme: "nile" };

/** The answer main gives when the settings file could not be written. */
const NOT_SAVED: AppearanceSaveOutcome = {
  _tag: "NotSaved",
  reason: "the settings file could not be written",
};

/** Returns a bridge whose `appearance` channels answer with `SAVED` and record each save. */
const createAppearanceBridge = () => ({
  appearance: {
    read: vi.fn(() => SAVED),
    save: vi.fn<(next: Appearance) => Promise<AppearanceSaveOutcome>>(() =>
      Promise.resolve({ _tag: "Saved" }),
    ),
  },
});

/** Removes the listeners `recordAppearanceChanges` added. */
const stopRecording: Array<() => void> = [];

/** Records the `detail` of every `appearancechange` event the document receives, until `afterEach`. */
const recordAppearanceChanges = (): Appearance[] => {
  const details: Appearance[] = [];
  const record = (event: Event): void => {
    details.push((event as CustomEvent<Appearance>).detail);
  };
  document.addEventListener("appearancechange", record);
  stopRecording.push(() => {
    document.removeEventListener("appearancechange", record);
  });
  return details;
};

afterEach(() => {
  for (const stop of stopRecording.splice(0)) stop();
});

describe("the Appearance store", () => {
  it("reads the saved Appearance from main once, the first time it is read", () => {
    const bridge = createAppearanceBridge();
    const store = createAppearanceStore(bridge);
    expect(bridge.appearance.read).not.toHaveBeenCalled();

    expect(store.read()).toBe(SAVED);
    expect(store.read()).toBe(SAVED);
    expect(bridge.appearance.read).toHaveBeenCalledTimes(1);
  });

  it("shows a change without saving it, and tells theme-init.js and the subscribers", () => {
    const bridge = createAppearanceBridge();
    const store = createAppearanceStore(bridge);
    const changes = recordAppearanceChanges();
    const listener = vi.fn();
    store.subscribe(listener);

    store.show({ glassPercent: 70 });

    const next = { ...SAVED, glassPercent: 70 };
    expect(store.read()).toEqual(next);
    expect(changes).toEqual([next]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge.appearance.save).not.toHaveBeenCalled();
  });

  it("shows a saved change, then saves it on this Mac", async () => {
    const bridge = createAppearanceBridge();
    const store = createAppearanceStore(bridge);
    const changes = recordAppearanceChanges();

    const saving = store.save({ theme: "styles" });

    const next = { ...SAVED, theme: "styles" };
    expect(store.read()).toEqual(next);
    expect(changes).toEqual([next]);
    await saving;
    expect(bridge.appearance.save).toHaveBeenCalledWith(next);
    expect(store.read()).toEqual(next);
  });

  it("saves a change over the saved Appearance, not over a change only shown", async () => {
    const bridge = createAppearanceBridge();
    const store = createAppearanceStore(bridge);

    store.show({ glassPercent: 70 });
    await store.save({ theme: "styles" });

    expect(bridge.appearance.save).toHaveBeenCalledWith({ ...SAVED, theme: "styles" });
    expect(store.read()).toEqual({ ...SAVED, glassPercent: 70, theme: "styles" });
  });

  it("saves changes one after another, each over the one saved before it", async () => {
    const bridge = createAppearanceBridge();
    let finishFirst = (): void => {};
    bridge.appearance.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({ _tag: "Saved" });
        }),
    );
    const store = createAppearanceStore(bridge);

    const first = store.save({ theme: "styles" });
    const second = store.save({ glassPercent: 10 });
    await vi.waitFor(() => {
      expect(bridge.appearance.save).toHaveBeenCalledTimes(1);
    });
    finishFirst();
    await Promise.all([first, second]);

    expect(bridge.appearance.save).toHaveBeenLastCalledWith({
      ...SAVED,
      theme: "styles",
      glassPercent: 10,
    });
  });

  it("stops telling a subscriber once it unsubscribes", () => {
    const store = createAppearanceStore(createAppearanceBridge());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.show({ glassPercent: 10 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("fails with main's reason when a change is not saved, and shows the saved value again", async () => {
    const bridge = createAppearanceBridge();
    bridge.appearance.save.mockResolvedValueOnce(NOT_SAVED);
    const store = createAppearanceStore(bridge);
    const changes = recordAppearanceChanges();

    store.show({ glassPercent: 70 });
    await expect(store.save({ glassPercent: 70 })).rejects.toThrow(
      "the settings file could not be written",
    );

    expect(store.read()).toEqual(SAVED);
    expect(changes.at(-1)).toEqual(SAVED);
  });

  it("shows the saved theme after two failed saves, not the theme picked before the last", async () => {
    const bridge = createAppearanceBridge();
    bridge.appearance.save.mockResolvedValue(NOT_SAVED);
    const store = createAppearanceStore(bridge);

    const first = store.save({ theme: "styles" });
    const second = store.save({ theme: "end-house" });

    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(store.read()).toEqual(SAVED);
  });

  it("keeps a later change to the same field on screen while it is saved", async () => {
    const bridge = createAppearanceBridge();
    bridge.appearance.save.mockResolvedValueOnce(NOT_SAVED);
    let finishSecond = (): void => {};
    bridge.appearance.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = () => resolve({ _tag: "Saved" });
        }),
    );
    const store = createAppearanceStore(bridge);

    const first = store.save({ theme: "styles" });
    const second = store.save({ theme: "end-house" });
    await expect(first).rejects.toThrow();

    expect(store.read()).toEqual({ ...SAVED, theme: "end-house" });
    finishSecond();
    await second;
    expect(store.read()).toEqual({ ...SAVED, theme: "end-house" });
  });

  it("logs a save main refuses, and fails with a reason for the user", async () => {
    const bridge = createAppearanceBridge();
    bridge.appearance.save.mockRejectedValueOnce(new Error("refused"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createAppearanceStore(bridge);

    await expect(store.save({ glassPercent: 0 })).rejects.toThrow("the app failed to save it");

    expect(logged).toHaveBeenCalledWith("Could not save the Appearance:", new Error("refused"));
    expect(store.read()).toEqual(SAVED);
    logged.mockRestore();
  });
});

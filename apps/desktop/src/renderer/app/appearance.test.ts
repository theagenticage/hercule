/**
 * Tests the store of the Appearance the page shows: the one read from main,
 * a change that is only shown, a change that is saved, a save that fails,
 * and the event that tells `theme-init.js` to apply each change.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../../ipc/appearance";
import type { Appearance } from "../../ipc/contract";
import { createAppearanceStore } from "./appearance";

/** The Appearance main keeps in these tests: Nile, not following the system. */
const SAVED: Appearance = { ...DEFAULT_APPEARANCE, followSystem: false, theme: "nile" };

/** Returns a bridge whose `appearance` channels answer with `SAVED` and record each save. */
const createAppearanceBridge = () => ({
  appearance: {
    read: vi.fn(() => SAVED),
    save: vi.fn<(next: Appearance) => Promise<undefined>>(() => Promise.resolve(undefined)),
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

  it("shows a saved change, then saves it on this Mac", () => {
    const bridge = createAppearanceBridge();
    const store = createAppearanceStore(bridge);
    const changes = recordAppearanceChanges();

    store.save({ theme: "styles" });

    const next = { ...SAVED, theme: "styles" };
    expect(store.read()).toEqual(next);
    expect(changes).toEqual([next]);
    expect(bridge.appearance.save).toHaveBeenCalledWith(next);
  });

  it("merges a change into the Appearance it shows, not the one last saved", () => {
    const bridge = createAppearanceBridge();
    const store = createAppearanceStore(bridge);

    store.show({ glassPercent: 70 });
    store.save({ theme: "styles" });

    expect(bridge.appearance.save).toHaveBeenCalledWith({
      ...SAVED,
      glassPercent: 70,
      theme: "styles",
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

  it("logs a save main refuses, and shows the Appearance it showed before", async () => {
    const bridge = createAppearanceBridge();
    bridge.appearance.save.mockRejectedValueOnce(new Error("refused"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createAppearanceStore(bridge);
    const changes = recordAppearanceChanges();

    store.save({ glassPercent: 0 });

    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith("Could not save the Appearance:", new Error("refused"));
    });
    expect(store.read()).toEqual(SAVED);
    expect(changes).toEqual([{ ...SAVED, glassPercent: 0 }, SAVED]);
    logged.mockRestore();
  });

  it("keeps a later change on screen when an earlier save fails", async () => {
    const bridge = createAppearanceBridge();
    bridge.appearance.save.mockRejectedValueOnce(new Error("refused"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createAppearanceStore(bridge);

    store.save({ glassPercent: 0 });
    store.save({ theme: "styles" });

    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledTimes(1);
    });
    expect(store.read()).toEqual({ ...SAVED, glassPercent: 0, theme: "styles" });
    logged.mockRestore();
  });
});

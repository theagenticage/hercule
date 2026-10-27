import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAY_THEMES,
  DEFAULT_APPEARANCE,
  decideThemeInUse,
  NIGHT_THEMES,
  TEXT_SIZE_STEPS,
  THEMES,
} from "../ipc/appearance";
import type { Appearance } from "../ipc/contract";
import script from "./public/theme-init.js?raw";
import { computeLengthAtStep } from "./styles/evaluate-text-size-css";
import tokens from "./styles/tokens.css?raw";

/**
 * Tests the theme script (`public/theme-init.js`): before the first paint it
 * applies the Appearance main keeps, picking the theme from the macOS
 * appearance when Follow the system is on, and afterwards it applies each
 * change of either.
 *
 * The CSP allows no inline script, which is why the script is a separate file.
 * The test reads it as raw text and runs it the way a browser does: as plain
 * source against the globals it finds.
 */

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * A stand-in for the browser's answer to the dark-appearance media query. A
 * test changes the appearance with `change`, which fires the same event the
 * browser fires when the user switches macOS between light and dark.
 */
class FakeAppearance extends EventTarget {
  matches: boolean;

  constructor(dark: boolean) {
    super();
    this.matches = dark;
  }

  change(dark: boolean): void {
    this.matches = dark;
    this.dispatchEvent(new Event("change"));
  }
}

/** The listeners the script added to `document`, removed after each test. */
const documentListeners: Array<[string, EventListenerOrEventListenerObject]> = [];

/**
 * The document's own `addEventListener`, taken before any test replaces it,
 * so that a test that runs the script twice records each listener once.
 */
const addDocumentListener = document.addEventListener.bind(document);

/**
 * Runs the theme script the way the page does, against the given macOS
 * appearance and the Appearance `saved` that main keeps.
 *
 * The stubbed `matchMedia` fails on any other query, so a typo in the query
 * fails the test instead of silently reading light. The listeners the script
 * adds to `document` are recorded, so that the next test starts with none.
 */
const runThemeScript = (system: FakeAppearance, saved: Appearance = DEFAULT_APPEARANCE): void => {
  vi.stubGlobal("matchMedia", (query: string) => {
    if (query !== DARK_QUERY) {
      throw new Error(`Unexpected media query: ${query}`);
    }
    return system;
  });
  vi.stubGlobal("bridge", { appearance: { read: () => saved } });
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    if (listener !== null) documentListeners.push([type, listener]);
    addDocumentListener(type, listener, options);
  });
  // The script is plain source with no imports. Direct eval compiles and runs
  // it in this scope with the globals it needs, as the page's parser does.
  eval(script);
};

/** Dispatches an `appearancechange` event, as the page does when the user changes the Appearance. */
const changeAppearance = (next: Appearance): void => {
  document.dispatchEvent(new CustomEvent("appearancechange", { detail: next }));
};

/** The theme attributes of <html> at one moment. */
interface ThemeAttributes {
  readonly theme: string | undefined;
  readonly changing: string | undefined;
}

/**
 * Wraps the page's `getComputedStyle` so that each call records the theme
 * attributes of <html> at that moment, then reads the style as before.
 * Returns the list the calls are recorded in, oldest first.
 */
const recordStyleReads = (): ThemeAttributes[] => {
  const reads: ThemeAttributes[] = [];
  const readStyle = window.getComputedStyle.bind(window);
  vi.stubGlobal("getComputedStyle", (element: Element) => {
    const { theme, themeChanging } = document.documentElement.dataset;
    reads.push({ theme, changing: themeChanging });
    return readStyle(element);
  });
  return reads;
};

/**
 * Starts recording every change to the attributes of <html> that the script
 * sets. Returns a function that stops the recording and returns each change as
 * the attribute's name and its value before the change, oldest first; a value
 * of `null` means the attribute was added.
 */
const recordAttributeChanges = (): (() => Array<[string | null, string | null]>) => {
  const observer = new MutationObserver(() => {});
  observer.observe(document.documentElement, {
    attributeFilter: [
      "data-theme",
      "data-theme-changing",
      "data-solid-glass",
      "data-text-size",
      "style",
    ],
    attributeOldValue: true,
  });
  return () => {
    const records = observer.takeRecords();
    observer.disconnect();
    return records.map((record) => [record.attributeName, record.oldValue]);
  };
};

afterEach(() => {
  // Each test starts on a document element with no theme or glass, as the
  // page does.
  const root = document.documentElement;
  delete root.dataset.theme;
  delete root.dataset.themeChanging;
  delete root.dataset.textSize;
  root.removeAttribute("data-solid-glass");
  root.removeAttribute("style");
  for (const [type, listener] of documentListeners.splice(0)) {
    document.removeEventListener(type, listener);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Returns the theme <html> is drawn in. */
const readTheme = (): string | undefined => document.documentElement.dataset.theme;

/** Returns the step of the Text size <html> is drawn at. */
const readTextSize = (): string | undefined => document.documentElement.dataset.textSize;

/** Returns whether every glass surface on the page is solid. */
const isGlassSolid = (): boolean => document.documentElement.hasAttribute("data-solid-glass");

describe("the theme script", () => {
  it("starts on the day theme when macOS is light and Follow the system is on", () => {
    runThemeScript(new FakeAppearance(false), { ...DEFAULT_APPEARANCE, dayTheme: "styles" });
    expect(readTheme()).toBe("styles");
  });

  it("starts on the night theme when macOS is dark and Follow the system is on", () => {
    runThemeScript(new FakeAppearance(true), { ...DEFAULT_APPEARANCE, nightTheme: "nile" });
    expect(readTheme()).toBe("nile");
  });

  it("starts on the chosen theme, whatever macOS shows, when Follow the system is off", () => {
    const system = new FakeAppearance(true);
    runThemeScript(system, { ...DEFAULT_APPEARANCE, followSystem: false, theme: "styles" });
    expect(readTheme()).toBe("styles");

    system.change(false);
    expect(readTheme()).toBe("styles");
  });

  it("switches between the day and night themes as macOS changes", () => {
    const system = new FakeAppearance(false);
    runThemeScript(system, { ...DEFAULT_APPEARANCE, dayTheme: "styles", nightTheme: "end-house" });

    system.change(true);
    expect(readTheme()).toBe("end-house");

    system.change(false);
    expect(readTheme()).toBe("styles");
  });

  it("picks the same theme as decideThemeInUse for every Appearance and macOS appearance", () => {
    for (const theme of THEMES) {
      for (const followSystem of [false, true]) {
        for (const dayTheme of DAY_THEMES) {
          for (const nightTheme of NIGHT_THEMES) {
            for (const dark of [false, true]) {
              const choice = { theme, followSystem, dayTheme, nightTheme };
              delete document.documentElement.dataset.theme;
              runThemeScript(new FakeAppearance(dark), { ...DEFAULT_APPEARANCE, ...choice });
              expect(readTheme(), JSON.stringify({ ...choice, dark })).toBe(
                decideThemeInUse(choice, dark),
              );
            }
          }
        }
      }
    }
  });

  it("sets the Glass level as --glass-percent", () => {
    runThemeScript(new FakeAppearance(false), { ...DEFAULT_APPEARANCE, glassPercent: 65 });
    expect(document.documentElement.style.getPropertyValue("--glass-percent")).toBe("65");
  });

  it("makes the glass solid when Reduce transparency is on, whatever the Glass level", () => {
    runThemeScript(new FakeAppearance(false), {
      ...DEFAULT_APPEARANCE,
      glassPercent: 80,
      reduceTransparency: true,
    });
    expect(isGlassSolid()).toBe(true);
  });

  it("makes the glass solid when the Glass level is 0", () => {
    runThemeScript(new FakeAppearance(false), { ...DEFAULT_APPEARANCE, glassPercent: 0 });
    expect(isGlassSolid()).toBe(true);
  });

  it("leaves the glass see-through when the Glass level is above 0 and Reduce transparency is off", () => {
    runThemeScript(new FakeAppearance(false), { ...DEFAULT_APPEARANCE, glassPercent: 1 });
    expect(isGlassSolid()).toBe(false);
  });

  it("sets the step of the Text size before the first paint, for every step", () => {
    for (const textSize of TEXT_SIZE_STEPS) {
      delete document.documentElement.dataset.textSize;
      runThemeScript(new FakeAppearance(false), { ...DEFAULT_APPEARANCE, textSize });
      expect(readTextSize()).toBe(String(textSize));
    }
  });

  it("sets the step of the Text size again on every appearancechange event", () => {
    runThemeScript(new FakeAppearance(false));
    expect(readTextSize()).toBe("2");

    for (const textSize of [4, 1, 3, 2] as const) {
      changeAppearance({ ...DEFAULT_APPEARANCE, textSize });
      expect(readTextSize()).toBe(String(textSize));
    }
  });

  it("changes only the Text size, with no snap and no style read, when only the step changes", () => {
    runThemeScript(new FakeAppearance(false));
    const styleReads = recordStyleReads();
    const stopRecording = recordAttributeChanges();

    changeAppearance({ ...DEFAULT_APPEARANCE, textSize: 4 });

    expect(stopRecording()).toEqual([["data-text-size", "2"]]);
    expect(styleReads).toEqual([]);
  });

  it("leaves the Text size alone when only the glass changes", () => {
    runThemeScript(new FakeAppearance(false), { ...DEFAULT_APPEARANCE, textSize: 3 });
    const stopRecording = recordAttributeChanges();

    changeAppearance({ ...DEFAULT_APPEARANCE, textSize: 3, glassPercent: 55 });

    expect(stopRecording()).toEqual([["style", "--glass-percent: 40;"]]);
    expect(readTextSize()).toBe("3");
  });

  it("applies the Appearance of an appearancechange event", () => {
    const system = new FakeAppearance(true);
    runThemeScript(system);

    changeAppearance({
      ...DEFAULT_APPEARANCE,
      followSystem: false,
      theme: "styles",
      glassPercent: 0,
    });
    expect(readTheme()).toBe("styles");
    expect(document.documentElement.style.getPropertyValue("--glass-percent")).toBe("0");
    expect(isGlassSolid()).toBe(true);

    // A later change of macOS's appearance uses the new Appearance.
    changeAppearance({ ...DEFAULT_APPEARANCE, nightTheme: "nile" });
    system.change(false);
    system.change(true);
    expect(readTheme()).toBe("nile");
    expect(isGlassSolid()).toBe(false);
  });

  it("switches transitions off while macOS's appearance changes the theme, so the change snaps", () => {
    const system = new FakeAppearance(false);
    runThemeScript(system);
    const styleReads = recordStyleReads();
    const stopRecording = recordAttributeChanges();

    system.change(true);

    // base.css switches every transition off while `data-theme-changing` is
    // set, so it is added before the theme changes and removed after.
    expect(stopRecording()).toEqual([
      ["data-theme-changing", null],
      ["data-theme", "whitehaven"],
      ["data-theme-changing", ""],
    ]);
    // The page's style is recalculated once, with the new theme already in
    // place and transitions still off. Without that read, Chromium would
    // recalculate style only after the attribute is gone, and every control
    // would fade to its new colours.
    expect(styleReads).toEqual([{ theme: "orient-express", changing: "" }]);
  });

  it("snaps when an appearancechange event changes the theme", () => {
    runThemeScript(new FakeAppearance(false));
    const styleReads = recordStyleReads();
    const stopRecording = recordAttributeChanges();

    changeAppearance({ ...DEFAULT_APPEARANCE, followSystem: false, theme: "nile" });

    expect(stopRecording()).toEqual([
      ["data-theme-changing", null],
      ["data-theme", "whitehaven"],
      ["data-theme-changing", ""],
    ]);
    expect(styleReads).toEqual([{ theme: "nile", changing: "" }]);
  });

  it("changes only the glass, with no snap and no style read, when the theme stays", () => {
    // A drag of the Glass slider dispatches an event per step, so each one
    // costs a single style change and nothing more.
    runThemeScript(new FakeAppearance(false));
    const styleReads = recordStyleReads();
    const stopRecording = recordAttributeChanges();

    changeAppearance({ ...DEFAULT_APPEARANCE, glassPercent: 55 });

    expect(stopRecording()).toEqual([["style", "--glass-percent: 40;"]]);
    expect(styleReads).toEqual([]);
  });

  it("sets the first theme without switching transitions off", () => {
    // Nothing has painted before the script runs, so nothing can fade, and a
    // style read then would cost a style pass for nothing.
    const styleReads = recordStyleReads();
    const stopRecording = recordAttributeChanges();

    runThemeScript(new FakeAppearance(true));

    expect(stopRecording()).toEqual([
      ["data-theme", null],
      ["style", null],
      ["data-text-size", null],
    ]);
    expect(styleReads).toEqual([]);
  });

  it("sets steps that the stylesheets turn into text tokens one pixel apart, with the default step unchanged", () => {
    expect(TEXT_SIZE_STEPS.map((step) => computeLengthAtStep("--t-13", step))).toEqual([
      12, 13, 14, 15,
    ]);
  });

  it("uses theme names the design tokens define", () => {
    // Without a matching selector the page silently falls back to the light
    // tokens on `:root`, and the window would show the wrong theme.
    for (const theme of THEMES) {
      expect(tokens).toContain(`[data-theme="${theme}"]`);
    }
  });
});

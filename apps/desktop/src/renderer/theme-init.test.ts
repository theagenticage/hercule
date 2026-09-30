import { afterEach, describe, expect, it, vi } from "vitest";
import script from "./public/theme-init.js?raw";
import tokens from "./styles/tokens.css?raw";

/**
 * Tests the theme script (`public/theme-init.js`): it picks the theme from the
 * macOS appearance before the first paint, and keeps it in step afterwards.
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

/**
 * Runs the theme script the way the page does, against the given appearance
 * and a document element with no theme yet. The stubbed `matchMedia` fails on
 * any other query, so a typo in the query fails the test instead of silently
 * reading light.
 */
const runThemeScript = (appearance: FakeAppearance): void => {
  vi.stubGlobal("matchMedia", (query: string) => {
    if (query !== DARK_QUERY) {
      throw new Error(`Unexpected media query: ${query}`);
    }
    return appearance;
  });
  delete document.documentElement.dataset.theme;
  // The script is plain source with no imports. Direct eval compiles and runs
  // it in this scope with the globals it needs, as the page's parser does.
  eval(script);
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
 * Starts recording every change to the theme attributes of <html>. Returns a
 * function that stops the recording and returns each change as the attribute's
 * name and its value before the change, oldest first; a value of `null` means
 * the attribute was added.
 */
const recordThemeAttributeChanges = (): (() => Array<[string | null, string | null]>) => {
  const observer = new MutationObserver(() => {});
  observer.observe(document.documentElement, {
    attributeFilter: ["data-theme", "data-theme-changing"],
    attributeOldValue: true,
  });
  return () => {
    const records = observer.takeRecords();
    observer.disconnect();
    return records.map((record) => [record.attributeName, record.oldValue]);
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the theme script", () => {
  it("starts on Whitehaven when macOS is light", () => {
    runThemeScript(new FakeAppearance(false));
    expect(document.documentElement.dataset.theme).toBe("whitehaven");
  });

  it("starts on Orient Express when macOS is dark", () => {
    runThemeScript(new FakeAppearance(true));
    expect(document.documentElement.dataset.theme).toBe("orient-express");
  });

  it("follows macOS when the appearance changes later", () => {
    const appearance = new FakeAppearance(false);
    runThemeScript(appearance);

    appearance.change(true);
    expect(document.documentElement.dataset.theme).toBe("orient-express");

    appearance.change(false);
    expect(document.documentElement.dataset.theme).toBe("whitehaven");
  });

  it("switches transitions off while it changes the theme later, so the change snaps", () => {
    const appearance = new FakeAppearance(false);
    runThemeScript(appearance);
    const styleReads = recordStyleReads();
    const stopRecording = recordThemeAttributeChanges();

    appearance.change(true);

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

  it("sets the first theme without switching transitions off", () => {
    // Nothing has painted before the script runs, so nothing can fade, and a
    // style read then would cost a style pass for nothing.
    delete document.documentElement.dataset.theme;
    const styleReads = recordStyleReads();
    const stopRecording = recordThemeAttributeChanges();

    runThemeScript(new FakeAppearance(true));

    expect(stopRecording()).toEqual([["data-theme", null]]);
    expect(styleReads).toEqual([]);
  });

  it("uses theme names the design tokens define", () => {
    // Without a matching selector the page silently falls back to the light
    // tokens on `:root`, and a dark Mac would get a light window.
    expect(tokens).toContain('[data-theme="whitehaven"]');
    expect(tokens).toContain('[data-theme="orient-express"]');
  });
});

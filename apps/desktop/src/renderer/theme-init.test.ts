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

  it("uses theme names the design tokens define", () => {
    // Without a matching selector the page silently falls back to the light
    // tokens on `:root`, and a dark Mac would get a light window.
    expect(tokens).toContain('[data-theme="whitehaven"]');
    expect(tokens).toContain('[data-theme="orient-express"]');
  });
});

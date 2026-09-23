import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "@hercule/ui/testing";
import script from "../public/theme-init.js?raw";

/**
 * Tests the pre-paint script (`apps/web/public/theme-init.js`), the part of the
 * theme choice that runs before the app does. Nothing else covers it: the
 * ThemeSelector tests check what is written under `hercule:theme`, and these
 * tests check that the script reads the same key and applies it to the
 * document. Both sets of tests use the same key literal, which keeps the two
 * sides in step.
 *
 * The CSP allows no inline script, which is why the script is a separate file.
 * The test reads it as raw text and runs it the way a browser does: as plain
 * source against the globals it finds.
 */

/** Runs the script the way the page does, against the given storage and this document. */
const runThemeScript = (storage: Storage): void => {
  vi.stubGlobal("localStorage", storage);
  delete document.documentElement.dataset.theme;
  // The script is plain source with no imports. Direct eval compiles and runs
  // it in this scope with the globals it needs, as the page's parser does.
  eval(script);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the pre-paint theme script", () => {
  it("applies a stored light choice before the app renders", () => {
    runThemeScript(createMemoryStorage({ "hercule:theme": "light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("applies a stored dark choice before the app renders", () => {
    runThemeScript(createMemoryStorage({ "hercule:theme": "dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("applies nothing when no choice is stored or the value is unknown", () => {
    runThemeScript(createMemoryStorage());
    expect(document.documentElement.dataset.theme).toBeUndefined();

    runThemeScript(createMemoryStorage({ "hercule:theme": "purple" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("leaves the document unchanged when storage access fails", () => {
    const denied = {
      getItem: () => {
        throw new Error("The quota has been exceeded");
      },
    } as unknown as Storage;
    runThemeScript(denied);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "@hydra/ui/testing";
import script from "../public/theme-init.js?raw";

/**
 * The pre-paint script (`apps/web/public/theme-init.js`) is the half of the
 * theme choice that runs before the app does, and nothing else can exercise
 * it: the component's tests prove what is written under `hydra:theme`, and
 * this one proves the script reads that same key and paints the document with
 * it - the two literals this test and those tests seed are what keep the pair
 * honest. The CSP allows the page no inline script, which is why the script is
 * a file at all; it is read raw and run exactly as a browser runs it, as plain
 * source against the globals it finds.
 */

/** Runs the script the way the page does, against this storage and document. */
const run = (storage: Storage): void => {
  vi.stubGlobal("localStorage", storage);
  delete document.documentElement.dataset.theme;
  // The script is plain source with no imports; direct eval compiles and runs
  // it in this scope against the globals it needs, as the page's parser does.
  eval(script);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the pre-paint theme script", () => {
  it("paints a stored light choice before the app renders", () => {
    run(memoryStorage({ "hydra:theme": "light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("paints a stored dark choice before the app renders", () => {
    run(memoryStorage({ "hydra:theme": "dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("paints nothing for no choice and for a value it does not know", () => {
    run(memoryStorage());
    expect(document.documentElement.dataset.theme).toBeUndefined();

    run(memoryStorage({ "hydra:theme": "purple" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("leaves the document alone where storage is denied", () => {
    const denied = {
      getItem: () => {
        throw new Error("The quota has been exceeded");
      },
    } as unknown as Storage;
    run(denied);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

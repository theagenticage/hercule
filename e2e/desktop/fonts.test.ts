/**
 * Tests which fonts the app reads at launch (spec 17, §Performance, rule 6).
 * The page preloads the Latin subset of Bricolage Grotesque, the UI font, so
 * that its request starts while the HTML parses. Every other face loads only
 * when text first needs it.
 *
 * The test starts the packaged test package on the connect screen, whose field
 * and button use Bricolage and whose wordmark uses Limelight. Run
 * `pnpm build:desktop` first.
 */
import type { Request } from "playwright";
import { describe, expect, it } from "vitest";
import { launchForTest } from "./harness";

/** The file name of the preloaded font, without the hash Vite adds to it. */
const PRELOADED_FONT = "bricolage-grotesque-latin-standard-normal";

/**
 * Returns the file name in `url` without the 8-character hash Vite adds to an
 * asset: `app://hercule/assets/limelight-latin-400-normal-Ab12Cd34.woff2` gives
 * `limelight-latin-400-normal`. Returns `url` unchanged when it is not a font.
 */
const stripFontHash = (url: string): string => url.replace(/^.*\/([^/]+)-[\w-]{8}\.woff2$/, "$1");

describe("the fonts at launch", () => {
  it("reads Bricolage Latin once, from the preload, and every other face only when text uses it", async () => {
    const { page } = await launchForTest();
    // Playwright can attach to the page after its first requests have gone
    // out, so the test loads the page again with a listener already in place.
    // It then sees every request of that load, the document's own first.
    const requests: Request[] = [];
    page.on("request", (request) => requests.push(request));
    await page.reload();
    await page.getByRole("button", { name: "Connect" }).waitFor();

    const faces = await page.evaluate(async () => {
      await document.fonts.ready;
      // The first range of each face tells the two subsets of Bricolage apart.
      return [...document.fonts].map(({ family, unicodeRange, status }) => ({
        family,
        firstRange: unicodeRange.split(",")[0],
        status,
      }));
    });
    expect(faces).toEqual([
      { family: "Bricolage Grotesque", firstRange: "U+0-FF", status: "loaded" },
      { family: "Bricolage Grotesque", firstRange: "U+100-2BA", status: "unloaded" },
      { family: "Limelight", firstRange: "U+0-10FFFF", status: "loaded" },
      { family: "Recursive", firstRange: "U+0-10FFFF", status: "unloaded" },
      // The password field's bullet, drawn from Geneva, a system font; see
      // controls.css. The connect screen has no password field.
      { family: "Password bullet", firstRange: "U+2022", status: "unloaded" },
    ]);

    // The stylesheets name every font's address, so a font requested before
    // them was requested by the preload. A second request for the preloaded
    // file would mean the page's own request did not match the preload, and
    // the file was read twice. How many stylesheets the page links depends on
    // how the build splits the CSS between the shell and the thread route's
    // chunk, which this test does not check.
    const loads = requests
      .filter((request) => ["font", "stylesheet"].includes(request.resourceType()))
      .map((request) =>
        request.resourceType() === "stylesheet" ? "stylesheet" : stripFontHash(request.url()),
      );
    expect(loads.filter((load) => load !== "stylesheet")).toEqual([
      PRELOADED_FONT,
      "limelight-latin-400-normal",
    ]);
    expect(loads.indexOf("stylesheet")).toBe(1);

    // Chromium warns in the console about a preload whose credentials mode
    // does not match the font's request, and about a preload nothing uses.
    const preloadWarnings = (await page.consoleMessages())
      .map((message) => message.text())
      .filter((text) => text.includes("preload"));
    expect(preloadWarnings).toEqual([]);
  });
});

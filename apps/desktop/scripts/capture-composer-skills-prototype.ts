/**
 * PROTOTYPE (#766), throwaway. Captures every scene of the composer-skills
 * prototype in Whitehaven and Orient Express, switcher bar included, as
 * 2880 x 1800 PNGs in
 * src/renderer/specimens/composer-skills-prototype/screens/<NN>-<scene>-<theme>.png.
 *
 * Run it against a running renderer dev server:
 * `node scripts/capture-composer-skills-prototype.ts [http://127.0.0.1:5198]`.
 * NN is the scene's 1-based position in the switcher, zero-padded.
 *
 * The scene keys are read from the switcher's own scene menu, so a scene
 * added to the prototype is captured without a change here. A page is
 * captured once it sets `data-ready` on `<html>`, which it does after its
 * animations have ended and a frame holding the whole page was presented.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const THEMES = ["whitehaven", "orient-express"] as const;
const READY_TIMEOUT_MS = 30_000;
const outputDir = fileURLToPath(
  new URL("../src/renderer/specimens/composer-skills-prototype/screens/", import.meta.url),
);
const pageUrl = `${process.argv[2] ?? "http://127.0.0.1:5198"}/specimens/composer-skills-prototype/index.html`;

mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({
  // The same switches the Electron captures use: one colour profile, no scroll bars.
  args: ["--force-color-profile=srgb", "--hide-scrollbars"],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: "no-preference",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(pageUrl);
  await page.waitForSelector("html[data-ready]", { timeout: READY_TIMEOUT_MS });
  const options = await page.getByLabel("Scene").locator("option").all();
  const keys = await Promise.all(options.map((option) => option.getAttribute("value")));

  for (const [index, key] of keys.entries()) {
    if (key === null) throw new Error("A scene option has no value.");
    for (const theme of THEMES) {
      await page.goto(`${pageUrl}?scene=${key}&theme=${theme}`);
      await page.waitForSelector("html[data-ready]", { timeout: READY_TIMEOUT_MS });
      const name = `${String(index + 1).padStart(2, "0")}-${key}-${theme}.png`;
      await page.screenshot({ path: join(outputDir, name) });
      console.log(name);
    }
  }
  if (errors.length > 0) console.log(`Console errors:\n${errors.join("\n")}`);
} finally {
  await browser.close();
}

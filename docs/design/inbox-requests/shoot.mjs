// Usage: node shoot.mjs   (writes {light,beige,dark}-{controls,groups,lips}.png beside this file)
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
// No node_modules is installed here: point PLAYWRIGHT_DIR at any node_modules that has playwright.
const require = createRequire((process.env.PLAYWRIGHT_DIR ?? "/Users/rogier/.npm/_npx/e41f203b7505f1fb/node_modules") + "/");
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const themes = { light: "whitehaven", beige: "styles", dark: "orient-express" };
const browser = await chromium.launch();
for (const [name, theme] of Object.entries(themes)) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(`file://${here}/mockup.html?theme=${theme}`);
  await page.evaluate(() => document.fonts.ready);
  for (const id of ["controls", "groups", "lips"]) {
    await page.locator(`#${id}`).screenshot({ path: path.join(here, `${name}-${id}.png`) });
  }
}
await browser.close();

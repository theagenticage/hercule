// Captures frames of one animation, six times slower than life, into a contact sheet of PNGs.
// Usage: node tools/frames.mjs <name> [theme] [--out dir]
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
const [name, theme = "orient-express", outFlag, outDir = "/tmp/frames"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const base = pathToFileURL(resolve("desktop.html")).href;
const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--headless=new"], env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" } });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("ERROR", String(e)));
await page.goto(`${base}?theme=${theme}&replay=off&slow=6`, { waitUntil: "load" });
await page.waitForTimeout(700);
let n = 0;
const snap = async (ms = 0) => { if (ms) await page.waitForTimeout(ms); await page.screenshot({ path: `${outDir}/${name}-${String(n++).padStart(2, "0")}.png`, type: "png" }); };
const box = (id) => page.locator(`.card[data-id="${id}"]`).boundingBox();
const SCRIPTS = {
  drag: async () => {
    const c = await box("substitutions");
    await page.mouse.move(c.x + 60, c.y + 40); await page.mouse.down(); await snap();
    await page.mouse.move(c.x + 70, c.y + 44, { steps: 3 }); await snap(120);
    await page.mouse.move(c.x + 230, c.y + 90, { steps: 8 }); await snap(120); await snap(300);
    await page.mouse.move(c.x + 470, c.y + 140, { steps: 8 }); await snap(120); await snap(500);
    await page.mouse.up(); for (let i = 0; i < 6; i++) await snap(220);
  },
  open: async () => { await page.click('.card[data-id="substitutions"]'); for (let i = 0; i < 8; i++) await snap(i ? 260 : 60); await page.keyboard.press("Escape"); for (let i = 0; i < 6; i++) await snap(300); },
  fan: async () => { await page.click('.pile[data-kind="reviews"]'); for (let i = 0; i < 8; i++) await snap(i ? 300 : 60); await page.keyboard.press("Escape"); for (let i = 0; i < 6; i++) await snap(320); },
  fold: async () => { await page.click('.lane-btn[data-fold-lane="storefront"]'); for (let i = 0; i < 7; i++) await snap(i ? 300 : 60); await page.click('.lane-btn[data-fold-lane="storefront"]'); for (let i = 0; i < 7; i++) await snap(i ? 300 : 60); },
  plan: async () => { await page.click('.plan-head[data-fold-plan="priceengine"]'); for (let i = 0; i < 7; i++) await snap(i ? 300 : 60); },
  fact: async () => { await page.evaluate(() => Tray.mergeNext()); for (let i = 0; i < 10; i++) await snap(i ? 450 : 100); },
};
await SCRIPTS[name]();
console.log(n, "frames");
await browser.close();

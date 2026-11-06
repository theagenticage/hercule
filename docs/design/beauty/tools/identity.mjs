// Proves the point of the folder: with every move off, the copies are the clean builds.
// Shoots each state in the original and in the copy, and compares every pixel.
// Usage: node tools/identity.mjs   (from docs/design/beauty, with the docs/design folder served)
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { createHash } from "node:crypto";
const HOST = process.env.HOST || "http://127.0.0.1:8483";
const THEMES = ["whitehaven", "styles", "orient-express", "nile", "end-house", "blue-train"];
const WORK = ["replay=off", "scene=quiet", "scene=failed", "scene=empty", "replay=off&lanes=gutter"];
const INBOX = ["", "scene=first", "scene=zero"];
const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--headless=new"], env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" } });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
async function shot(url) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ animations: "disabled" });
  await page.close();
  return createHash("sha1").update(png).digest("hex");
}
let bad = 0, n = 0;
for (const theme of THEMES) {
  for (const [from, to, states] of [["overview", "beauty/work", WORK], ["inbox", "beauty/inbox", INBOX]]) {
    for (const s of states) {
      const q = "?theme=" + theme + (s ? "&" + s : "");
      const original = (process.env.CLEAN_HOST || "http://127.0.0.1:8484") + "/" + from + "/desktop.html" + q;
      const a = await shot(original);
      const b = await shot(HOST + "/" + to + "/desktop.html" + q);
      n++;
      if (a !== b) { bad++; console.log("DIFFERENT", from, q); }
    }
  }
}
console.log(n - bad + " of " + n + " states identical");
await browser.close();
process.exit(bad ? 1 : 0);

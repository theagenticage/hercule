// PROTOTYPE helper: screenshots a page so a design can be checked by eye.
// Usage: node shoot.mjs <file-or-url> <out.png> [--w 1440] [--h 900] [--scheme light|dark]
//        [--scale 1] [--full] [--wait 400] [--scrollTo <css selector>] [--scrollBy <px>]
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("/Users/rogier/.npm-global/lib/node_modules/playwright");

const [target, out, ...rest] = process.argv.slice(2);
const opt = { w: 1440, h: 900, scheme: "light", scale: 1, wait: 400 };
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, "");
  if (k === "full") opt.full = true;
  else opt[k] = rest[++i];
}
const url = /^[a-z]+:\/\//.test(target) ? target : pathToFileURL(resolve(target.split("?")[0])).href + (target.includes("?") ? "?" + target.split("?")[1] : "");
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(opt.w), height: Number(opt.h) },
  deviceScaleFactor: Number(opt.scale),
  colorScheme: opt.scheme,
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
if (opt.scrollTo) await page.evaluate((s) => document.querySelector(s)?.scrollIntoView(), opt.scrollTo);
if (opt.scrollBy) await page.mouse.wheel(0, Number(opt.scrollBy));
await page.waitForTimeout(Number(opt.wait));
await page.screenshot({ path: out, fullPage: !!opt.full });
await browser.close();
if (errors.length) console.error("page errors:\n" + errors.join("\n"));
console.log("wrote " + out);

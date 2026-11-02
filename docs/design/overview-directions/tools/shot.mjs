// Screenshot helper for the overview drawings on the Linux runner.
// Usage: node shot.mjs <url-or-file> <out.png> [--w 1440] [--h 900] [--scale 1] [--full] [--wait 600] [--mobile]
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [target, out, ...rest] = process.argv.slice(2);
const opt = { w: 1440, h: 900, scale: 1, wait: 600 };
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, "");
  if (k === "full" || k === "mobile") opt[k] = true;
  else opt[k] = rest[++i];
}
const url = /^[a-z]+:\/\//.test(target) ? target : pathToFileURL(resolve(target.split("?")[0])).href + (target.includes("?") ? "?" + target.split("?")[1] : "");
const browser = await chromium.launch({
  executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  args: ["--no-sandbox", "--headless=new"],
  env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" },
});
const ctx = await browser.newContext({ viewport: { width: Number(opt.w), height: Number(opt.h) }, deviceScaleFactor: Number(opt.scale), isMobile: !!opt.mobile, hasTouch: !!opt.mobile });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(Number(opt.wait));
await page.screenshot({ path: out, fullPage: !!opt.full });
if (errors.length) console.log("ERRORS:\n" + errors.join("\n"));
await browser.close();

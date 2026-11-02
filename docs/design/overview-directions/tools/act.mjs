// Usage: node act.mjs <url-or-file> <out.png> [--w 1440] [--h 900] [--full] [--mobile] [--scale 1] -- <steps...>
// steps: click:<css>  key:<Key>  wait:<ms>  eval:<js>  hover:<css>  shot:<file.png>
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const head = sep < 0 ? argv : argv.slice(0, sep);
const steps = sep < 0 ? [] : argv.slice(sep + 1);
const [target, out, ...rest] = head;
const opt = { w: 1440, h: 900, scale: 1, wait: 600 };
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, "");
  if (k === "full" || k === "mobile") opt[k] = true; else opt[k] = rest[++i];
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
for (const s of steps) {
  const i = s.indexOf(":"); const op = s.slice(0, i); const arg = s.slice(i + 1);
  if (op === "click") await page.click(arg);
  else if (op === "hover") await page.hover(arg);
  else if (op === "key") await page.keyboard.press(arg);
  else if (op === "wait") await page.waitForTimeout(Number(arg));
  else if (op === "eval") console.log(await page.evaluate(arg));
  else if (op === "shot") await page.screenshot({ path: arg, fullPage: !!opt.full });
}
await page.screenshot({ path: out, fullPage: !!opt.full });
if (errors.length) console.log("ERRORS:\n" + errors.join("\n"));
await browser.close();

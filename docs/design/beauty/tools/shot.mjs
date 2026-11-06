// Shoots a view with moves on. A review tool, not part of the study.
// Usage: node tools/shot.mjs <work|inbox> <moves,comma> <out.png> [--theme t] [--scale 2] [--clip x,y,w,h] [--q extra=1] [--w 1440] [--h 900] [--wait 1400] [--scroll n] [--hover sel] [--run js]
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
const [view, moves, out, ...rest] = process.argv.slice(2);
const o = { theme: "whitehaven", scale: 2, w: 1440, h: 900, wait: 1400, q: "" };
for (let i = 0; i < rest.length; i += 2) o[rest[i].replace(/^--/, "")] = rest[i + 1];
const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--headless=new"], env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" } });
const ctx = await browser.newContext({ viewport: { width: +o.w, height: +o.h }, deviceScaleFactor: +o.scale, reducedMotion: o.calm ? "reduce" : "no-preference" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const q = ["theme=" + o.theme, view === "work" ? "replay=off" : "", moves && moves !== "-" ? "m=" + moves : "", o.q].filter(Boolean).join("&");
await page.goto((process.env.HOST || "http://127.0.0.1:8483") + "/beauty/" + view + "/desktop.html?" + q, { waitUntil: "load" });
await page.waitForTimeout(+o.wait);
if (o.scroll) await page.evaluate((y) => { const s = document.getElementById("scroll") || document.getElementById("page"); s.scrollTop = y; }, +o.scroll);
if (o.hover) { const b = await page.locator(o.hover).first().boundingBox(); await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.4, { steps: 6 }); }
if (o.at) { const [x, y] = o.at.split(",").map(Number); await page.mouse.move(x - 20, y - 8); await page.mouse.move(x, y, { steps: 6 }); }
if (o.run) console.log(await page.evaluate(o.run));
if (o.scroll || o.hover || o.run || o.at) await page.waitForTimeout(+(o.after || 500));
const opts = { path: out };
if (o.clip) { const [x, y, width, height] = o.clip.split(",").map(Number); opts.clip = { x, y, width, height }; }
await page.screenshot(opts);
if (errors.length) console.log("ERRORS:\n" + errors.join("\n"));
await browser.close();

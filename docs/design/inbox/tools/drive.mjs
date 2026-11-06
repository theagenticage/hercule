// Drives desktop.html in headless Chromium and takes screenshots. Each step is one argument:
//   hover:<entity id>  click:<entity id>  act:<entity id>:<hand|take|dismiss>  key:<Key>  wait:<ms>  shot:<name>  frames:<name>:<count>:<ms>  eval:<js>
// usage: node tools/drive.mjs <out-dir> "<query>" [--w 1440] [--h 900] [--scale 1] [--page desktop.html] -- steps...
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const head = sep < 0 ? argv : argv.slice(0, sep);
const steps = sep < 0 ? [] : argv.slice(sep + 1);
const [outDir, query, ...rest] = head;
const opt = { w: 1440, h: 900, scale: 1, wait: 900, page: "desktop.html" };
for (let i = 0; i < rest.length; i++) opt[rest[i].replace(/^--/, "")] = rest[++i];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = pathToFileURL(resolve(root, opt.page)).href + (query ? "?" + query : "");
const browser = await chromium.launch({
  executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  args: ["--no-sandbox", "--headless=new"],
  env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" },
});
const ctx = await browser.newContext({ viewport: { width: +opt.w, height: +opt.h }, deviceScaleFactor: +opt.scale, reducedMotion: opt.reduced ? "reduce" : "no-preference" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(+opt.wait);
// --slow 0.1 plays every CSS transition and Web Animation at a tenth of its speed, to judge motion frame by frame.
if (opt.slow) { const cdp = await ctx.newCDPSession(page); await cdp.send("Animation.enable"); await cdp.send("Animation.setPlaybackRate", { playbackRate: +opt.slow }); }
// The point of a card that is really visible: 14px into its strip, left of the action buttons.
const pointOf = (id) => page.evaluate((id) => {
  const el = document.querySelector(`[data-id="${id}"]`);
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width * 0.45, y: r.top + 14 };
}, id);
for (const s of steps) {
  const parts = s.split(":");
  const op = parts[0];
  if (op === "hover") { const p = await pointOf(parts[1]); await page.mouse.move(p.x, p.y, { steps: 4 }); }
  else if (op === "click") { const p = await pointOf(parts[1]); await page.mouse.move(p.x, p.y); await page.mouse.click(p.x, p.y); }
  else if (op === "act") {
    const p = await pointOf(parts[1]);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await page.waitForTimeout(40);
    const b = await page.evaluate(([id, act]) => { const r = document.querySelector(`[data-id="${id}"] [data-act="${act}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, [parts[1], parts[2]]);
    await page.mouse.move(b.x, b.y, { steps: 3 });
    await page.mouse.click(b.x, b.y);
  }
  else if (op === "move") { await page.mouse.move(+parts[1], +parts[2], { steps: 6 }); }
  else if (op === "key") await page.keyboard.press(parts.slice(1).join(":"));
  else if (op === "wait") await page.waitForTimeout(+parts[1]);
  else if (op === "eval") console.log(await page.evaluate(parts.slice(1).join(":")));
  else if (op === "shot") await page.screenshot({ path: `${outDir}/${parts[1]}.png` });
  else if (op === "frames") {
    const [, name, count, ms] = parts;
    for (let i = 0; i < +count; i++) { await page.screenshot({ path: `${outDir}/${name}-${String(i).padStart(2, "0")}.png` }); await page.waitForTimeout(+ms); }
  }
}
if (errors.length) console.log("ERRORS:\n" + errors.join("\n"));
await browser.close();

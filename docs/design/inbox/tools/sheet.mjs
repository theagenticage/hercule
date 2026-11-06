// Lays cropped frames side by side in one image, to judge a motion at a glance.
// usage: node tools/sheet.mjs <out.png> <x,y,w,h> <cols> <frame.png>...
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
const [out, crop, cols, ...frames] = process.argv.slice(2);
const [x, y, w, h] = crop.split(",").map(Number);
const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--headless=new", "--allow-file-access-from-files"], env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" } });
const page = await (await browser.newContext({ viewport: { width: 200, height: 200 } })).newPage();
const cells = frames.map((f, i) => `<div style="width:${w}px;height:${h}px;overflow:hidden;position:relative;outline:1px solid #888"><img src="${pathToFileURL(resolve(f)).href}" style="position:absolute;left:${-x}px;top:${-y}px"><b style="position:absolute;left:2px;top:2px;font:10px sans-serif;background:#000;color:#fff;padding:0 3px">${i}</b></div>`).join("");
const html = `<body style="margin:0;background:#444"><div id=g style="display:grid;grid-template-columns:repeat(${cols},${w}px);gap:4px;width:max-content">${cells}</div></body>`;
const tmp = resolve(out + ".html");
writeFileSync(tmp, html);
await page.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
await page.waitForTimeout(400);
const g = await page.$("#g");
await g.screenshot({ path: out });
await browser.close();
rmSync(tmp);

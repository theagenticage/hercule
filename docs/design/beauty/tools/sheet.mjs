// Lays out shots of a view in all six themes on one page, for a first look across themes.
// Usage: node tools/sheet.mjs <work|inbox> <moves,comma> <out.png> [--q extra=1] [--scroll n]
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const [view, moves, out, ...rest] = process.argv.slice(2);
const THEMES = ["whitehaven", "styles", "orient-express", "nile", "end-house", "blue-train"];
mkdirSync("/tmp/beauty-sheet", { recursive: true });
for (const t of THEMES) execFileSync("node", ["tools/shot.mjs", view, moves, `/tmp/beauty-sheet/${t}.png`, "--theme", t, "--scale", "1", ...rest]);
writeFileSync("/tmp/beauty-sheet/sheet.html", `<body style="margin:0;background:#888;display:grid;grid-template-columns:1fr 1fr;gap:6px">${THEMES.map((t) => `<img src="${t}.png" style="width:100%;display:block">`).join("")}</body>`);
const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--headless=new"], env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" } });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1520 } })).newPage();
await page.goto("file:///tmp/beauty-sheet/sheet.html");
await page.waitForTimeout(400);
await page.screenshot({ path: out });
await browser.close();

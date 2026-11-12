// Lays captured screens out on one contact sheet, so a reviewer can see many at once.
//
//   node docs/design/inbox-list/tools/sheet.mjs <theme> <out.png> [state,state] [--cols 2]
import { chromium } from "playwright";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const cols = Number(argv[argv.indexOf("--cols") + 1]) || 2;
const [theme, out, pick] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--cols");
const dir = resolve(root, "screens", theme);
const files = readdirSync(dir).filter((f) => /\.(webp|png)$/.test(f)).filter((f) => !pick || pick.split(",").some((p) => f.includes(p))).sort();
const html = `<body style="margin:0;padding:16px;background:#888;font:13px sans-serif;display:grid;grid-template-columns:repeat(${cols},1fr);gap:14px">` +
  files.map((f) => `<figure style="margin:0"><img src="${pathToFileURL(resolve(dir, f)).href}" style="width:100%;display:block"><figcaption style="color:#fff;padding:4px 0">${f}</figcaption></figure>`).join("") + "</body>";
const tmp = resolve("/tmp", "sheet-" + process.pid + ".html");
writeFileSync(tmp, html);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440 * cols / 2 + 40, height: 900 } });
await p.goto(pathToFileURL(tmp).href);
await p.waitForTimeout(600);
await p.screenshot({ path: out, fullPage: true });
await b.close();

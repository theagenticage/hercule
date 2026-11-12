// Films a flow at real speed and lays its frames out on one sheet, each with its time since the move.
// It uses the browser's screencast, so frames are what was painted, when it was painted. The clock is
// never slowed: a slowed clock leaves springs behind CSS and shows motion that never happens.
//
//   node docs/design/inbox-list/tools/film.mjs <flow> [theme] [--every 2] [--clip list|pane|page|dialog]
//
// Writes /tmp/inbox-film/<flow>/sheet.png and the frames beside it.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i < 0 ? d : argv[i + 1]; };
const [flow, theme = "whitehaven"] = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] || "").startsWith("--"));
const every = Number(flag("every", 2));

const row = (p, key) => p.evaluate((k) => { const r = document.querySelector(`[data-key="${k}"]`).getBoundingClientRect(); return { x: r.left + 160, y: r.top + 20 }; }, key);
// Each flow: the query to open, what to do before filming, the move, how long to film after it, and the region.
const FLOWS = {
  "link-key": { q: "", clip: "list", before: async (p) => { await p.evaluate(() => { App.focusRow("r:pr-6213"); Moves.toggleSelect("pr-6213"); Moves.toggleSelect("pr-6230"); }); }, move: (p) => p.keyboard.press("l"), after: 1100 },
  "link-drag": { q: "", clip: "list", move: async (p) => { const a = await row(p, "r:pr-6213"), b = await row(p, "r:pr-6230"); await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move(a.x + 8, a.y + 6, { steps: 2 }); await p.mouse.move(b.x + 40, b.y + 6, { steps: 18 }); await p.waitForTimeout(200); await p.mouse.up(); }, after: 1100 },
  unlink: { q: "", clip: "list", before: async (p) => { await p.evaluate(() => { App.focusRow("r:pr-6213"); Moves.toggleSelect("pr-6213"); Moves.toggleSelect("pr-6230"); Moves.linkKey(); }); await p.waitForTimeout(1400); }, move: (p) => p.keyboard.press("Control+z"), after: 1000 },
  hand: { q: "scene=sentry", clip: "list", move: (p) => p.keyboard.press("h"), after: 1500 },
  "hand-menu": { q: "scene=pr", clip: "page", move: async (p) => { await p.keyboard.press("h"); await p.waitForTimeout(500); await p.keyboard.press("1"); }, after: 1500 },
  dismiss: { q: "", clip: "list", before: (p) => p.evaluate(() => App.focusRow("r:gm-quote")), move: (p) => p.keyboard.press("e"), after: 800 },
  "dismiss-undo": { q: "", clip: "list", before: async (p) => { await p.evaluate(() => { App.focusRow("r:gm-quote"); Moves.dismiss(); }); await p.waitForTimeout(900); }, move: (p) => p.keyboard.press("Control+z"), after: 800 },
  "accept-link": { q: "scene=suggestion", clip: "list", before: (p) => p.focus('[data-key="t:link-6251"]'), move: (p) => p.keyboard.press("l"), after: 1100 },
  "take-member": { q: "scene=group-member", clip: "list", before: (p) => p.focus('[data-key="m:shop-142:pr-6244"]'), move: (p) => p.keyboard.press("t"), after: 1200 },
  fold: { q: "scene=group", clip: "list", move: (p) => p.keyboard.press("ArrowRight"), after: 700 },
  unfold: { q: "scene=group-open", clip: "list", move: (p) => p.keyboard.press("ArrowLeft"), after: 700 },
  "dialog-open": { q: "scene=group", clip: "page", move: (p) => p.keyboard.press("n"), after: 900 },
  "dialog-send": { q: "scene=group", clip: "dialog", before: async (p) => { await p.keyboard.press("n"); await p.waitForTimeout(900); }, move: (p) => p.keyboard.press("Control+Enter"), after: 3200 },
  "dialog-close": { q: "scene=group", clip: "page", before: async (p) => { await p.keyboard.press("n"); await p.waitForTimeout(900); }, move: (p) => p.keyboard.press("Escape"), after: 700 },
  "new-bar": { q: "", clip: "list", move: (p) => p.evaluate(() => Live.arrive(World.arrivals())), after: 1200 },
  "new-show": { q: "scene=new", clip: "list", before: (p) => p.waitForTimeout(800), move: (p) => p.keyboard.press("."), after: 1800 },
  "signal-fold": { q: "scene=pr", clip: "pane", move: (p) => p.click('#pane [data-sig-fold="s2"]'), after: 700 },
  walk: { q: "", clip: "page", before: (p) => p.focus("#rows"), move: async (p) => { for (let i = 0; i < 4; i++) { await p.keyboard.press("j"); await p.waitForTimeout(90); } }, after: 500 },
  resize: { q: "", clip: "page", before: (p) => p.focus("#edge"), move: (p) => p.keyboard.press("ArrowLeft"), after: 700 },
  "zero": { q: "", clip: "page", before: (p) => p.evaluate(() => { Model.live().forEach((t) => { if (Model.asks(t) && !t.held && t.id !== "gm-quote") Model.gone.add(t.id); }); Model.triage().forEach((x) => Model.gone.add(x.id)); App.render({}); App.focusRow("r:gm-quote"); }), move: (p) => p.keyboard.press("e"), after: 2600 },
};

const f = FLOWS[flow];
if (!f) { console.log("Flows: " + Object.keys(FLOWS).join(", ")); process.exit(1); }
const out = resolve("/tmp/inbox-film", flow + (theme !== "whitehaven" ? "-" + theme : ""));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("PAGE ERROR " + e.message));
await page.goto(pathToFileURL(resolve(root, "desktop.html")).href + `?theme=${theme}&${f.q}${argv.includes("--reduced") ? "&motion=reduced" : ""}`);
await page.waitForSelector("html[data-ready]");
await page.waitForTimeout(900);
if (f.before) await f.before(page);
await page.waitForTimeout(250);

const cdp = await page.context().newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", async (e) => {
  frames.push({ t: e.metadata.timestamp * 1000, data: e.data });
  await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 82, everyNthFrame: 1 });
await page.waitForTimeout(120);
const t0 = Date.now();
await f.move(page);
await page.waitForTimeout(f.after);
await cdp.send("Page.stopScreencast");
await browser.close();

const start = frames.find((x) => x.t >= t0 - 30) ? t0 : frames[0].t;
const kept = frames.filter((x) => x.t >= start - 40).filter((_, i) => i % every === 0);
kept.forEach((x, i) => writeFileSync(resolve(out, `frame-${String(i).padStart(3, "0")}.jpg`), Buffer.from(x.data, "base64")));
const CLIPS = { list: [500, 50, 520, 560], pane: [1020, 50, 420, 600], page: [272, 0, 1168, 900], dialog: [370, 90, 700, 720] };
const [cx, cy, cw, ch] = CLIPS[flag("clip", f.clip)];
const cols = cw > 900 ? 3 : 4;
const html = `<body style="margin:0;padding:12px;background:#777;display:grid;grid-template-columns:repeat(${cols},${cw / 2}px);gap:10px;font:12px sans-serif;color:#fff">` +
  kept.map((x, i) => `<figure style="margin:0"><div style="width:${cw / 2}px;height:${ch / 2}px;overflow:hidden;position:relative"><img src="frame-${String(i).padStart(3, "0")}.jpg" style="position:absolute;left:${-cx / 2}px;top:${-cy / 2}px;width:720px"></div><figcaption>${Math.round(x.t - start)} ms</figcaption></figure>`).join("") + "</body>";
writeFileSync(resolve(out, "sheet.html"), html);
const b2 = await chromium.launch();
const p2 = await b2.newPage({ viewport: { width: cols * (cw / 2 + 10) + 24, height: 600 } });
await p2.goto(pathToFileURL(resolve(out, "sheet.html")).href);
await p2.waitForTimeout(400);
await p2.screenshot({ path: resolve(out, "sheet.png"), fullPage: true });
await b2.close();
console.log(`${kept.length} frames over ${Math.round(kept[kept.length - 1].t - start)} ms → ${out}/sheet.png`);

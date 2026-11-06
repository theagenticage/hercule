// Takes the full-size screens of every key state, in every theme, into screens/<theme>/<state>.png.
// usage: node tools/capture.mjs [out-dir] [theme,theme] [state,state] [--w 1440 --h 900]
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf("--" + name); return i < 0 ? fallback : argv[i + 1]; };
const pos = argv.filter((a, i) => !a.startsWith("--") && !(argv[i - 1] || "").startsWith("--"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(pos[0] || resolve(root, "screens"));
const THEMES = (pos[1] || "whitehaven,styles,orient-express,nile,end-house,blue-train").split(",");
const W = +flag("w", 1440), H = +flag("h", 900);

const inPlace = async (page, id) => page.evaluate((id) => { const r = document.querySelector(`[data-id="${id}"]`).getBoundingClientRect(); return { x: r.left + r.width * 0.45, y: r.top + 14 }; }, id);
const hover = async (page, id) => { const p = await inPlace(page, id); await page.mouse.move(p.x, p.y, { steps: 3 }); };
const click = async (page, id) => { const p = await inPlace(page, id); await page.mouse.move(p.x, p.y); await page.mouse.click(p.x, p.y); };

const box = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); const g = document.getElementById("page"); const r0 = e.getBoundingClientRect(); if (r0.bottom > innerHeight - 60) g.scrollTop += r0.top - 300; const t = e.querySelector(".c-title, .b-title") || e; const r = t.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 8 }; }, sel);
const clickOn = async (p, sel) => { const c = await box(p, sel); await p.waitForTimeout(60); await p.mouse.move(c.x, c.y); await p.mouse.click(c.x, c.y); };
const STATES = {
  "01-morning": { q: "" },
  "02-hover": { q: "", run: async (p) => { await hover(p, "pr-6204"); await p.waitForTimeout(300); } },
  "03-open": { q: "", run: async (p) => { await clickOn(p, '.card[data-id="ln-SHOP-371"]'); await p.waitForTimeout(800); } },
  "04-open-noticed": { q: "", run: async (p) => { await click(p, "c-search"); await p.waitForTimeout(800); } },
  "05-menu": { q: "", run: async (p) => { await hover(p, "ln-SHOP-371"); await p.waitForTimeout(160); const b = await p.evaluate(() => { const r = document.querySelector('.card[data-id="ln-SHOP-371"] [data-act="hand"]').getBoundingClientRect(); return { x: r.left + 8, y: r.top + 10 }; }); await p.mouse.move(b.x, b.y); await p.mouse.click(b.x, b.y); await p.waitForTimeout(400); } },
  "06-handed": { q: "scene=handed" },
  "07-signal-landing": { q: "", run: async (p) => { await p.evaluate(() => Landing.land(App.findEntity("pr-6238"), World.signal("commented", 0.02, "omar-haddad"))); await p.waitForTimeout(430); } },
  "08-carrying": { q: "", run: async (p) => { const a = await inPlace(p, "pr-6213"); await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move(a.x - 40, a.y + 20, { steps: 4 }); await p.mouse.move(520, 300, { steps: 12 }); await p.waitForTimeout(500); } },
  "09-light-day": { q: "scene=light" },
  "10-300-cards": { q: "scene=volume" },
  "11-open-project": { q: "", run: async (p) => { await clickOn(p, '.b-open[data-id="prj-retries"]'); await p.waitForTimeout(800); } },
  "12-long-and-huge": { q: "scene=edge" },
  "13-loading": { q: "scene=loading&hold=9000" },
  "14-offline": { q: "scene=offline" },
  "15-github-failing": { q: "scene=error" },
  "16-inbox-zero": { q: "scene=zero", wait: 1800 },
  "17-first-run": { q: "scene=firstrun" },
  "19-requests-clear": { q: "scene=light", run: async (p) => { await p.evaluate(() => { App.state.entities.filter((e) => !App.isRich(e) && !["pr-6238"].includes(e.id)).forEach((e) => { e.settled = true; }); App.layOut(true); }); await p.waitForTimeout(1900); } },
  "20-link-hint": { q: "", run: async (p) => { await clickOn(p, '.card[data-id="pr-6263"]'); await p.waitForTimeout(800); } },
  "21-by-initiative": { q: "", run: async (p) => { await p.click('[data-tool="group"]'); await p.click('[data-group="Initiative"]'); await p.waitForTimeout(700); } },
  "18-intake": { q: "", run: async (p) => { await p.click('[data-view="intake"]'); await p.waitForTimeout(400); } },
};
const only = pos[2] ? pos[2].split(",") : null;

const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--headless=new"], env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" } });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
const errors = [];
// With --webp, every screen is re-encoded by Chromium itself at quality 0.86: a fifth of the size, with no visible loss.
const webp = argv.includes("--webp");
const encoder = webp ? await ctx.newPage() : null;
async function save(page, path) {
  if (!webp) { await page.screenshot({ path: path + ".png" }); return; }
  const png = (await page.screenshot()).toString("base64");
  const out = await encoder.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    const buf = new Uint8Array(await (await c.convertToBlob({ type: "image/webp", quality: 0.86 })).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, png);
  writeFileSync(path + ".webp", Buffer.from(out, "base64"));
}
for (const theme of THEMES) {
  mkdirSync(`${out}/${theme}`, { recursive: true });
  for (const [name, s] of Object.entries(STATES)) {
    if (only && !only.some((o) => name.includes(o))) continue;
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${theme}/${name}: ${e}`));
    await page.goto(pathToFileURL(resolve(root, "desktop.html")).href + `?theme=${theme}&live=0&dock=0&${s.q}`, { waitUntil: "load" });
    await page.waitForTimeout(s.wait || 800);
    if (s.run) await s.run(page);
    await save(page, `${out}/${theme}/${name}`);
    await page.close();
  }
}
if (errors.length) console.log("ERRORS\n" + errors.join("\n"));
await browser.close();

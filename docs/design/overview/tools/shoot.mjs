// Takes every key state of desktop.html, in the given themes, into screens/.
// Usage: node tools/shoot.mjs [--themes a,b] [--states x,y] [--out dir] [--w 1440 --h 900] [--suffix -small]
// Needs a Chromium and playwright-core; on the Linux runner see the wiki page on drawings.
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const opt = { themes: "whitehaven,styles,orient-express,nile,end-house,blue-train", states: "", out: "screens", w: 1440, h: 900, suffix: "", scale: 1 };
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, "")] = args[i + 1];
mkdirSync(opt.out, { recursive: true });

const base = pathToFileURL(resolve("desktop.html")).href;
const card = (p, id) => p.locator(`.card[data-id="${id}"]`).boundingBox();

const STATES = {
  today: { q: "replay=off" },
  hover: { q: "replay=off", run: async (p) => { await p.hover('.card[data-id="substitutions"]'); await p.waitForTimeout(500); } },
  focus: { q: "replay=off", run: async (p) => { await p.keyboard.press("ArrowDown"); for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowRight"]) await p.keyboard.press(k); await p.waitForTimeout(250); } },
  lens: { q: "replay=off", run: async (p) => { await p.click('.lens[data-lens="think"]'); await p.mouse.move(700, 880); await p.waitForTimeout(450); } },
  plan: { q: "replay=off", run: async (p) => { await p.click('.plan-head[data-fold-plan="priceengine"]'); await p.mouse.move(700, 880); await p.waitForTimeout(1100); } },
  folded: { q: "replay=off", run: async (p) => { await p.keyboard.press("Shift+F"); await p.waitForTimeout(1200); } },
  pile: { q: "replay=off", run: async (p) => { await p.click('.cell[data-stage="reviewing"] .card-more'); await p.mouse.move(700, 120); await p.waitForTimeout(1200); } },
  full: { q: "replay=off", run: async (p) => { await p.click('.lane-btn[data-fold-lane="storefront"]'); await p.mouse.move(700, 890); await p.waitForTimeout(1000); } },
  drag: { q: "replay=off", run: async (p) => {
    const c = await card(p, "substitutions");
    await p.mouse.move(c.x + 60, c.y + 40); await p.mouse.down();
    await p.mouse.move(c.x + 360, c.y + 150, { steps: 12 }); await p.waitForTimeout(700);
  }, after: async (p) => { await p.keyboard.press("Escape"); await p.mouse.up(); } },
  merge: { q: "replay=off", run: async (p) => {
    const a = await card(p, "image-sizes"); const b = await card(p, "substitutions");
    await p.mouse.move(b.x + 60, b.y + 40); await p.mouse.down();
    await p.mouse.move(a.x + 110, a.y + 44, { steps: 12 }); await p.waitForTimeout(1500);
  }, after: async (p) => { await p.keyboard.press("Escape"); await p.mouse.up(); } },
  pane: { q: "replay=off", run: async (p) => { await p.click('.card[data-id="substitutions"]'); await p.mouse.move(400, 880); await p.waitForTimeout(1200); } },
  "pane-agent": { q: "replay=off", run: async (p) => { await p.evaluate(() => Pane.show("t-cancelled")); await p.waitForTimeout(1200); } },
  wear: { q: "replay=off&wear=1" },
  many: { q: "scene=many" },
  "many-folded": { q: "scene=many", run: async (p) => { await p.keyboard.press("Shift+F"); await p.waitForTimeout(1200); } },
  one: { q: "scene=one" },
  first: { q: "scene=first" },
  empty: { q: "scene=empty" },
  loading: { q: "scene=loading&hold=20000" },
  offline: { q: "scene=offline" },
  awkward: { q: "scene=awkward" },
  office: { q: "replay=off", wait: 1800, run: async (p) => { await p.click('.switch-tab[data-view="office"]'); await p.waitForTimeout(3500); } },
  later: { q: "replay=off&later=1", run: async (p) => { await p.click('.switch-tab[data-view="list"]'); await p.waitForTimeout(500); } },
};

const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--headless=new"], env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" } });
const ctx = await browser.newContext({ viewport: { width: +opt.w, height: +opt.h }, deviceScaleFactor: +opt.scale });
const names = opt.states ? opt.states.split(",") : Object.keys(STATES);
for (const theme of opt.themes.split(",")) {
  for (const name of names) {
    const s = STATES[name];
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("ERROR", name, theme, String(e)));
    await page.goto(`${base}?theme=${theme}&${s.q}`, { waitUntil: "load" });
    await page.waitForTimeout(s.wait || 750);
    if (s.run) await s.run(page);
    await page.screenshot({ path: `${opt.out}/${name}--${theme}${opt.suffix}.jpg`, type: "jpeg", quality: 92 });
    if (s.after) await s.after(page);
    await page.close();
  }
  console.log("done", theme);
}
await browser.close();

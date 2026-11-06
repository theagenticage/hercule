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

const fold = async (p) => { await p.keyboard.press("Shift+F"); await p.mouse.move(700, 890); await p.waitForTimeout(1200); };
const rest = async (p, ms) => { await p.mouse.move(700, 890); await p.waitForTimeout(ms || 900); };

const STATES = {
  today: { q: "replay=off" },
  "in-lanes": { q: "replay=off&plans=lanes" },
  "side-labels": { q: "replay=off&lanes=gutter" },
  "side-labels-in-lanes": { q: "replay=off&lanes=gutter&plans=lanes" },
  folded: { q: "replay=off", run: fold },
  "folded-in-lanes": { q: "replay=off&plans=lanes", run: fold },
  "folded-side-labels": { q: "replay=off&lanes=gutter", run: fold },
  "folded-side-labels-in-lanes": { q: "replay=off&lanes=gutter&plans=lanes", run: fold },
  quiet: { q: "scene=quiet" },
  hover: { q: "replay=off", run: async (p) => { await p.hover('.card[data-id="substitutions"]'); await p.waitForTimeout(500); } },
  focus: { q: "replay=off", run: async (p) => { for (const k of ["ArrowDown", "ArrowRight", "ArrowRight"]) await p.keyboard.press(k); await p.waitForTimeout(250); } },
  plan: { q: "replay=off", run: async (p) => { await p.click('.plan-head[data-fold-plan="priceengine"]'); await rest(p, 1100); } },
  stack: { q: "replay=off", run: async (p) => { await p.evaluate(() => document.querySelector('[data-stack="t-faster-checkout"]').scrollIntoView({ block: "center" })); await rest(p, 300); } },
  "stack-open": { q: "replay=off", run: async (p) => { await p.click('[data-stack="t-faster-checkout"]'); await p.evaluate(() => document.querySelector('[data-stack="t-faster-checkout"]').scrollIntoView({ block: "center" })); await rest(p); } },
  more: { q: "replay=off&plans=lanes", run: async (p) => { await p.click('.cell[data-owner="lane-storefront"][data-stage="reviewing"] .cell-more'); await rest(p, 1000); } },
  "group-menu": { q: "replay=off", run: async (p) => { await p.click('[data-tool="group"]'); await p.waitForTimeout(350); } },
  "group-context": { q: "replay=off&group=linear/project" },
  "group-repo": { q: "replay=off&group=github/repo" },
  "group-initiative": { q: "replay=off&group=initiative" },
  "filter-menu": { q: "replay=off", run: async (p) => { await p.click('[data-tool="filter"]'); await p.waitForTimeout(350); } },
  "filter-context": { q: "replay=off", run: async (p) => { await p.evaluate(() => Filters.showContext("linear/project", "proj/returns")); await rest(p, 1000); } },
  "filter-question": { q: "replay=off", run: async (p) => { await p.evaluate(() => Filters.toggle("state", "question")); await rest(p, 1000); } },
  add: { q: "replay=off&group=linear/project", run: async (p) => { await p.evaluate(() => Adder.show("ctx:proj/basket")); await p.waitForTimeout(600); } },
  "add-all": { q: "replay=off", run: async (p) => { await p.click("#add-btn"); await p.waitForTimeout(600); } },
  "add-searching": { q: "replay=off&hold=20000", run: async (p) => { await p.evaluate(() => Adder.demo("gift")); await p.waitForTimeout(500); } },
  "add-results": { q: "replay=off", run: async (p) => { await p.evaluate(() => { Adder.show("storefront"); Adder.demo("gift"); }); await p.waitForTimeout(1000); } },
  "add-link": { q: "replay=off", run: async (p) => { await p.evaluate(() => { Adder.show(); Adder.demo("https://github.example/northwind/storefront-web/pull/6290"); }); await p.waitForTimeout(1000); } },
  "add-followed": { q: "replay=off", run: async (p) => { await p.evaluate(() => { Adder.show("storefront"); Adder.demo("gift"); }); await p.waitForTimeout(900); await p.click('[data-add-ref="issue/WEB-301"]'); await p.waitForTimeout(700); } },
  "add-none": { q: "replay=off", run: async (p) => { await p.evaluate(() => { Adder.show("storefront"); Adder.demo("toaster"); }); await p.waitForTimeout(1000); } },
  "add-locked": { q: "replay=off", run: async (p) => { await p.evaluate(() => { Adder.show(); Adder.demo("https://linear.example/northwind/issue/FIN-12"); }); await p.waitForTimeout(1000); } },
  "add-offline": { q: "scene=offline", run: async (p) => { await p.click("#add-btn"); await p.waitForTimeout(600); } },
  drag: { q: "replay=off", run: async (p) => {
    const c = await card(p, "substitutions");
    await p.mouse.move(c.x + 60, c.y + 40); await p.mouse.down();
    await p.mouse.move(c.x + 300, c.y + 130, { steps: 12 }); await p.waitForTimeout(700);
  }, after: async (p) => { await p.keyboard.press("Escape"); await p.mouse.up(); } },
  merge: { q: "replay=off", run: async (p) => {
    const a = await card(p, "image-sizes"); const b = await card(p, "substitutions");
    await p.mouse.move(b.x + 60, b.y + 40); await p.mouse.down();
    await p.mouse.move(a.x + 110, a.y + 44, { steps: 12 }); await p.waitForTimeout(1500);
  }, after: async (p) => { await p.keyboard.press("Escape"); await p.mouse.up(); } },
  pane: { q: "replay=off", run: async (p) => { await p.evaluate(() => Pane.show("image-sizes")); await p.mouse.move(400, 880); await p.waitForTimeout(1200); } },
  "pane-question": { q: "replay=off", run: async (p) => { await p.evaluate(() => Pane.show("basket-restore")); await p.mouse.move(400, 880); await p.waitForTimeout(1200); } },
  failed: { q: "scene=failed" },
  "failed-filter": { q: "scene=failed", run: async (p) => { await p.click('.nav-row[data-nav="overview"]'); await rest(p); } },
  "failed-pane": { q: "scene=failed", run: async (p) => { await p.evaluate(() => Pane.show("rv-6252")); await p.mouse.move(400, 880); await p.waitForTimeout(1200); } },
  "failed-folded": { q: "scene=failed", run: fold },
  "failed-threads": { q: "scene=failed", run: async (p) => { await p.click('[data-face="threads"]'); await rest(p, 400); } },
  wear: { q: "replay=off&wear=1" },
  many: { q: "scene=many" },
  "many-folded": { q: "scene=many", run: fold },
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

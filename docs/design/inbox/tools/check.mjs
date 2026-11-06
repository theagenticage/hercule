// Drives the flows that have broken before, and fails on any page error or broken promise. Run it before every push.
// usage: node tools/check.mjs
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--headless=new"], env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" } });
const failures = [];
async function open(query, w = 1440, h = 900) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.goto(pathToFileURL(resolve(root, "desktop.html")).href + "?theme=whitehaven&live=0&dock=0&" + query, { waitUntil: "load" });
  await page.waitForTimeout(500);
  return page;
}
const point = (p, id, where = "title") => p.evaluate(([id, where]) => {
  const el = document.querySelector(`[data-id="${id}"]`);
  const r = el.getBoundingClientRect();
  return where === "title" ? { x: r.left + 90, y: r.top + 14 } : { x: r.right - 22, y: r.top + 18 };
}, [id, where]);
const hover = async (p, id) => { const a = await point(p, id); await p.mouse.move(a.x, a.y, { steps: 3 }); };
const count = (p) => p.evaluate(() => App.state.entities.length);
const has = (p, id) => p.evaluate((id) => !!App.findEntity(id), id);
async function check(name, fn) {
  let page;
  try { page = await fn(); } catch (e) { failures.push(`${name}: ${e.message}`); console.log("FAIL", name, e.message.split("\n")[0]); return; }
  if (page && page.errors.length) { failures.push(`${name}: ${page.errors[0]}`); console.log("FAIL", name, page.errors[0]); return; }
  console.log("ok  ", name);
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const THEMES = ["whitehaven", "styles", "orient-express", "nile", "end-house", "blue-train"];
const SCENES = ["morning", "light", "volume", "handed", "edge", "loading", "offline", "error", "zero", "firstrun"];

await check("every scene opens in every theme", async () => {
  const p = await open("");
  for (const scene of SCENES) await p.evaluate((s) => Scenes.play(s), scene);
  for (const theme of THEMES) await p.evaluate((t) => { document.documentElement.dataset.theme = t; Scenes.play("morning"); }, theme);
  return p;
});
await check("the display font is nowhere on the page, and no rule is doubled", async () => {
  const p = await open("");
  const bad = await p.evaluate(() => [...document.querySelectorAll("#main *")].filter((el) => /deco/i.test(getComputedStyle(el).fontFamily) || (el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) > 20)).map((el) => el.className));
  assert(!bad.length, `too loud: ${bad.slice(0, 4)}`);
  return p;
});
await check("no view knows a system by name", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["app.js", "card.js", "relations.js", "open.js", "pointer.js", "keys.js", "moves.js", "landing.js", "drag.js"]) {
    const code = readFileSync(resolve(root, "js", f), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "").replace(/\blinear'/g, "").replace(/\d+ms linear/g, "");
    const hit = code.match(/\b(github|linear|sentry|gmail|slack|quayside)\b/i);
    assert(!hit, `${f} says ${hit && hit[0]}`);
  }
  return null;
});
await check("a pull request linked to a ticket rides on the ticket, not in the column", async () => {
  const p = await open("");
  const where = await p.evaluate(() => ({ part: !!document.querySelector('.bundle .part[data-id="pr-6238"]'), card: !!document.querySelector('#requests .card[data-id="pr-6238"]'), lead: !!document.querySelector('#work .card[data-id="ln-SHOP-371"]') }));
  assert(where.part && !where.card && where.lead, JSON.stringify(where));
  return p;
});
await check("a reference in text never groups, until a person confirms it", async () => {
  const p = await open("");
  assert(await p.evaluate(() => !!document.querySelector('#requests .card[data-id="pr-6263"]')), "a hint pulled the card onto the ticket");
  await p.evaluate(() => Moves.link(App.findEntity("pr-6263"), App.findEntity("ln-OPS-47"))); await p.waitForTimeout(500);
  assert(await p.evaluate(() => !!document.querySelector('#work .part[data-id="pr-6263"]')), "the confirmed link did not join them");
  await p.keyboard.press("Control+z"); await p.waitForTimeout(500);
  assert(await p.evaluate(() => !!document.querySelector('#requests .card[data-id="pr-6263"]')), "undo left the link");
  return p;
});
await check("only direct links join: a chain never pulls in the neighbourhood", async () => {
  const p = await open("");
  const n = await p.evaluate(() => Relations.buildBundles(App.readLying()).filter((b) => b.lead.id === "ln-OPS-41")[0].parts.length);
  assert(n === 2, `${n} parts`);
  return p;
});
await check("a thing in two places shows under both and counts once", async () => {
  const p = await open("");
  const r = await p.evaluate(() => ({ cards: document.querySelectorAll('.card[data-id="ln-SHOP-360"]').length, echoes: document.querySelectorAll('.echo[data-id="ln-SHOP-360"]').length }));
  assert(r.cards === 1 && r.echoes === 1, JSON.stringify(r));
  return p;
});
await check("progress shows only where the source reports it", async () => {
  const p = await open("");
  const r = await p.evaluate(() => ({ reported: !!document.querySelector('[data-place="prj-depot"] .b-progress'), silent: !!document.querySelector('[data-place="prj-browsers"] .b-progress') }));
  assert(r.reported && !r.silent, JSON.stringify(r));
  return p;
});
await check("every grouping draws, and the sidebar's number never moves", async () => {
  const p = await open("");
  const before = await p.evaluate(() => App.countOverdue());
  const options = await p.evaluate(() => [...document.querySelector("[data-grouping]").options].map((o) => o.value));
  for (const o of options) { await p.selectOption("[data-grouping]", o); await p.waitForTimeout(250); }
  assert((await p.evaluate(() => App.countOverdue())) === before, "a grouping changed the count");
  return p;
});
await check("a click on a title never makes a move", async () => {
  const p = await open("");
  const a = await point(p, "pr-6213");
  await p.mouse.move(a.x, a.y); await p.mouse.click(a.x, a.y); await p.waitForTimeout(500);
  assert(!(await p.evaluate(() => App.findEntity("pr-6213").task)), "a click handed the card on");
  assert(await p.evaluate(() => Open.isOpen()), "the card did not open");
  return p;
});
await check("the second click of a double click never starts a run", async () => {
  const p = await open("");
  const a = await point(p, "pr-6213");
  await p.mouse.move(a.x, a.y); await p.waitForTimeout(30);
  await p.mouse.click(a.x, a.y); await p.waitForTimeout(180); await p.mouse.click(a.x, a.y); await p.waitForTimeout(700);
  assert(!(await p.evaluate(() => App.findEntity("pr-6213").task)), "a double click handed the card on");
  return p;
});
await check("dismiss and undo keep every card, by pointer at the same spot", async () => {
  const p = await open("");
  await hover(p, "pr-6204"); await p.waitForTimeout(120);
  const x = await p.evaluate(() => { const r = document.querySelector('[data-id="pr-6204"] [data-act="dismiss"]').getBoundingClientRect(); return { x: r.left + 8, y: r.top + 8 }; });
  await p.mouse.move(x.x, x.y); await p.waitForTimeout(80);
  const n = await count(p);
  for (let i = 0; i < 3; i++) { await p.mouse.click(x.x, x.y); await p.waitForTimeout(420); }
  assert((await count(p)) === n - 3, "three clicks at one spot did not dismiss three cards");
  for (let i = 0; i < 3; i++) { await p.keyboard.press("Control+z"); await p.waitForTimeout(300); }
  await p.waitForTimeout(400);
  assert((await count(p)) === n, "undo lost a card");
  return p;
});
await check("fast moves and fast undos leave every card visible", async () => {
  const p = await open("");
  await p.evaluate(() => Keys.focus("pr-6204"));
  for (let i = 0; i < 5; i++) { await p.keyboard.press("t"); await p.waitForTimeout(140); }
  await p.waitForTimeout(800);
  for (let i = 0; i < 5; i++) { await p.keyboard.press("Control+z"); await p.waitForTimeout(450); }
  await p.waitForTimeout(600);
  const hidden = await p.evaluate(() => [...document.querySelectorAll("#page .bundle, #page .card")].filter((c) => getComputedStyle(c).opacity !== "1").map((c) => c.dataset.id || c.className));
  assert(!hidden.length, `invisible: ${hidden}`);
  assert((await p.evaluate(() => App.state.entities.filter((e) => e.task && !e.settled).length)) === 0, "a task survived the undos");
  return p;
});
await check("taking a card again during an undo keeps who holds it", async () => {
  const p = await open("");
  await p.evaluate(() => Keys.focus("pr-6204"));
  await p.keyboard.press("t"); await p.waitForTimeout(200); await p.keyboard.press("Control+z"); await p.waitForTimeout(150); await p.keyboard.press("t"); await p.waitForTimeout(1200);
  const holders = await p.evaluate(() => document.querySelectorAll('.card[data-id="pr-6204"] .card-holder').length);
  assert(holders === 1, `${holders} holders drawn`);
  return p;
});
await check("the same arrival never lands twice", async () => {
  const p = await open("");
  const e = `({ id: "pr-9000", kind: "github/pull-request", concern: "reviewRequested", title: "New", since: World.hoursAgo(0.02), fields: { number: 9000, repo: "storefront-web", author: "ines-carvalho", state: "running", diff: [1, 1], files: 1 }, signals: [World.signal("reviewRequested", 0.02, "ines-carvalho")], task: null })`;
  await p.evaluate((e) => { App.arrive(eval(e)); App.arrive(eval(e)); }, e);
  await p.waitForTimeout(500);
  assert((await p.evaluate(() => App.state.entities.filter((x) => x.id === "pr-9000").length)) === 1, "the card landed twice");
  return p;
});
await check("a signal on a part changes its row and moves nothing", async () => {
  const p = await open("");
  const y0 = await p.evaluate(() => document.querySelector('.part[data-id="pr-6238"]').getBoundingClientRect().top);
  await p.evaluate(() => Landing.land(App.findEntity("pr-6238"), World.signal("commented", 0.02, "omar-haddad"))); await p.waitForTimeout(600);
  const r = await p.evaluate(() => { const e = document.querySelector('.part[data-id="pr-6238"]'); return { y: e.getBoundingClientRect().top, said: e.textContent }; });
  assert(r.said.includes("Omar commented"), r.said);
  assert(Math.abs(r.y - y0) < 1, `the row moved ${r.y - y0}px`);
  return p;
});
await check("every move of an open card stays on one line", async () => {
  const p = await open("");
  const wrapped = await p.evaluate(() => {
    const out = [];
    App.state.entities.filter((e) => e.concern && !e.settled).concat(App.state.clusters).forEach((e) => {
      Open.show(e.id);
      document.querySelectorAll("#open .o-label, #open .o-says").forEach((el) => { if (el.getClientRects().length > 1 || (el.matches(".o-says") && el.offsetHeight > 17)) out.push(e.id + ": " + el.textContent); });
      Open.hide(true);
    });
    return out;
  });
  assert(!wrapped.length, `wrapped: ${wrapped.join(" | ")}`);
  return p;
});
await check("a carry raises the rail, and a drop on a card links the two", async () => {
  const p = await open("");
  const a = await point(p, "pr-6213");
  await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move(a.x - 30, a.y + 40, { steps: 4 }); await p.waitForTimeout(450);
  const o = await p.evaluate(() => getComputedStyle(document.getElementById("rail")).opacity);
  assert(Number(o) > 0.9, `the rail is at opacity ${o}`);
  const t = await p.evaluate(() => { const r = document.querySelector('.card[data-id="ln-OPS-44"]').getBoundingClientRect(); return { x: r.left + 90, y: r.top + 20 }; });
  await p.mouse.move(t.x, t.y, { steps: 8 }); await p.waitForTimeout(200);
  await p.mouse.up(); await p.waitForTimeout(700);
  assert(await p.evaluate(() => !!document.querySelector('.bundle .part[data-id="pr-6213"]')), "the drop did not link them");
  return p;
});

await browser.close();
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log("\nall good");

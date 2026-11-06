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
const allReachable = (p) => p.evaluate(() => {
  const shown = new Set();
  document.querySelectorAll(".stack .card").forEach((c) => {
    if (c.style.display === "none") return;
    if (c.dataset.id) shown.add(c.dataset.id);
    (c._members || []).forEach((e) => shown.add(e.id));
  });
  return App.state.entities.filter((e) => !e.settled && !shown.has(e.id)).map((e) => e.id);
});
async function check(name, fn) {
  let page;
  try { page = await fn(); } catch (e) { failures.push(`${name}: ${e.message}`); console.log("FAIL", name, e.message.split("\n")[0]); return; }
  if (page && page.errors.length) { failures.push(`${name}: ${page.errors[0]}`); console.log("FAIL", name, page.errors[0]); return; }
  console.log("ok  ", name);
}
const assert = (c, m) => { if (!c) throw new Error(m); };

await check("a click on a title opens the card and starts nothing", async () => {
  const p = await open("");
  const a = await point(p, "pr-6238");
  await p.mouse.move(a.x, a.y); await p.waitForTimeout(120); await p.mouse.click(a.x + 40, a.y);
  await p.waitForTimeout(500);
  assert(await p.evaluate(() => Open.isOpen()), "the card did not open");
  assert(!(await p.evaluate(() => App.findEntity("pr-6238").task)), "a click on the title handed the card on");
  return p;
});
await check("Enter Enter never starts an agent", async () => {
  const p = await open("");
  await p.keyboard.press("j"); await p.keyboard.press("j"); await p.keyboard.press("Enter"); await p.waitForTimeout(300); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  assert(!(await p.evaluate(() => App.state.entities.some((e) => e.task && !e.settled))), "Enter started an agent");
  return p;
});
await check("the same spot dismisses card after card", async () => {
  const p = await open("");
  await hover(p, "pr-6209");
  const before = await count(p);
  await p.waitForTimeout(80);
  const x = await p.evaluate(() => { const r = document.querySelector('[data-id="pr-6209"] [data-act="dismiss"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await p.mouse.move(x.x, x.y, { steps: 3 }); await p.waitForTimeout(60);
  for (let i = 0; i < 4; i++) { await p.mouse.click(x.x, x.y); await p.waitForTimeout(180); }
  assert((await count(p)) === before - 4, `dismissed ${before - (await count(p))} of 4`);
  assert(!(await p.evaluate(() => Open.isOpen())), "a click opened a card");
  return p;
});
await check("E works through by keys without touching the parked pointer's card", async () => {
  const p = await open("");
  await hover(p, "pr-6238");
  await p.mouse.move(120, 700);
  await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown");
  const first = await p.evaluate(() => Keys.current());
  await p.keyboard.press("e"); await p.waitForTimeout(100);
  const second = await p.evaluate(() => Keys.current());
  await p.keyboard.press("e"); await p.waitForTimeout(100);
  assert(!(await has(p, first)) && !(await has(p, second)), "the wrong cards were dismissed");
  return p;
});
await check("undo goes five deep, from another view", async () => {
  const p = await open("");
  const before = await p.evaluate(() => App.state.entities.map((e) => e.id).join());
  await p.keyboard.press("j"); await p.keyboard.press("j"); await p.keyboard.press("j"); await p.keyboard.press("j");
  for (const k of ["e", "e", "t", "e", "t"]) { await p.keyboard.press(k); await p.waitForTimeout(240); }
  await p.evaluate(() => Pages.setView("intake")); await p.waitForTimeout(100);
  for (let i = 0; i < 5; i++) { await p.keyboard.press("Control+z"); await p.waitForTimeout(600); }
  const after = await p.evaluate(() => App.state.entities.map((e) => e.id).join());
  assert(before === after, "the order did not come back");
  assert(await p.evaluate(() => !App.state.entities.some((e) => e.task && !e.settled)), "a Task stayed behind");
  return p;
});
await check("undo from the sunrise brings the card back", async () => {
  const p = await open("scene=light");
  await p.evaluate(() => { App.state.clusters.length = 0; App.drawNoticed(); App.state.entities.slice(1).forEach((e) => { e.settled = true; e.task = { by: "you" }; }); App.layOut(true); });
  const id = await p.evaluate(() => App.state.entities[0].id);
  await p.evaluate((id) => Moves.dismiss(App.findEntity(id)), id);
  await p.waitForTimeout(900);
  assert((await p.evaluate(() => App.state.mode)) === "zero", "the sunrise did not come");
  await p.keyboard.press("Control+z"); await p.waitForTimeout(500);
  assert(await has(p, id), "the card did not come back");
  assert((await p.evaluate(() => App.state.mode)) === "stacks", "the page stayed on the sunrise");
  return p;
});
await check("Hand all and Dismiss all undo exactly", async () => {
  const p = await open("scene=volume");
  const before = await p.evaluate(() => App.state.entities.map((e) => e.id).join());
  await p.evaluate(() => document.querySelector('.card.is-pile').click()); await p.waitForTimeout(500);
  await p.evaluate(() => document.querySelector('[data-all="dismiss"]').click()); await p.waitForTimeout(500);
  await p.keyboard.press("Control+z"); await p.waitForTimeout(600);
  assert((await p.evaluate(() => App.state.entities.map((e) => e.id).join())) === before, "Dismiss all did not undo exactly");
  return p;
});
await check("a page-locking double tap cannot lock the page", async () => {
  const p = await open("");
  await p.keyboard.press("j"); await p.keyboard.press("j"); await p.keyboard.press("Enter"); await p.waitForTimeout(300);
  for (const gap of [40, 120, 240, 420]) { await p.keyboard.press("Escape"); await p.waitForTimeout(gap); await p.keyboard.press("Enter"); await p.waitForTimeout(300); }
  await p.keyboard.press("Escape"); await p.waitForTimeout(700);
  assert(!(await p.evaluate(() => Open.isOpen())), "the sheet stayed open");
  assert(await p.evaluate(() => document.getElementById("open").hidden), "the sheet stayed on screen");
  assert(await p.evaluate(() => document.getElementById("scrim").hidden), "the veil stayed");
  return p;
});
await check("every card is reachable at every window size", async () => {
  for (const [w, h, q] of [[1440, 900, ""], [1280, 800, ""], [1160, 900, ""], [1000, 900, ""], [800, 900, ""], [720, 450, ""], [1440, 900, "scene=volume"], [1000, 700, "scene=volume"]]) {
    const p = await open(q, w, h);
    const lost = await allReachable(p);
    assert(!lost.length, `${w}x${h} ${q}: ${lost.length} cards out of reach`);
    await p.context().close();
  }
});
await check("a held card refuses another hand-off in the sheet", async () => {
  const p = await open("scene=handed");
  await p.evaluate(() => Open.show("pr-6204", null, true)); await p.waitForTimeout(500);
  await p.keyboard.press("h"); await p.waitForTimeout(300);
  assert((await p.evaluate(() => Open.current())) === "pr-6204", "the sheet walked on");
  return p;
});
await check("views can be left and clicks still work", async () => {
  const p = await open("");
  await p.click('[data-view="intake"]'); await p.waitForTimeout(200);
  await p.click('[data-view="cards"]'); await p.waitForTimeout(300);
  const a = await point(p, "pr-6238");
  await p.mouse.click(a.x, a.y); await p.waitForTimeout(500);
  assert(await p.evaluate(() => Open.isOpen()), "the card did not open after visiting Intake");
  return p;
});
await check("a card can be carried, dropped and cancelled", async () => {
  const p = await open("");
  const a = await point(p, "pr-6213");
  await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move(a.x + 30, a.y + 40, { steps: 4 });
  const t = await p.evaluate(() => { const r = document.querySelector('.rail-t[data-target="take"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await p.mouse.move(t.x, t.y, { steps: 10 }); await p.waitForTimeout(120); await p.mouse.up(); await p.waitForTimeout(900);
  assert(await p.evaluate(() => !!App.findEntity("pr-6213").task), "the drop did nothing");
  const b = await point(p, "pr-6238");
  await p.mouse.move(b.x, b.y); await p.mouse.down(); await p.mouse.move(b.x + 30, b.y + 60, { steps: 4 }); await p.keyboard.press("Escape"); await p.mouse.up(); await p.waitForTimeout(600);
  assert(!(await p.evaluate(() => Open.isOpen())), "a cancelled drag opened the card");
  assert(!(await p.evaluate(() => App.findEntity("pr-6238").task)), "a cancelled drag handed the card on");
  return p;
});

await check("a stack can be worked through to its end by keys, and a card comes out of the pile", async () => {
  const p = await open("");
  await p.evaluate(() => Keys.focus("pr-6204"));
  const n = () => p.evaluate(() => App.state.entities.filter((e) => App.readStack(e) === "review" && !e.task && !e.settled).length);
  const before = await n();
  for (let i = 0; i < before; i++) {
    await p.keyboard.press("t");
    await p.waitForTimeout(260);
    // When the last card in view is taken, the stack turns over and the keys move on to what it deals.
    if (!(await p.evaluate(() => Keys.current()))) await p.waitForTimeout(1600);
    if ((await n()) === 0) break;
  }
  assert((await n()) === 0, `${await n()} cards left in To review`);
  return p;
});
await check("stacks never cover each other, at any height", async () => {
  for (const [w, h] of [[1440, 900], [1280, 800], [1280, 720], [1000, 700]]) {
    const p = await open("", w, h);
    const bad = await p.evaluate(() => {
      const wraps = [].slice.call(document.querySelectorAll('[data-wrap="answer"], [data-wrap="finish"]'));
      const a = wraps[0].querySelector('.stack'), b = wraps[1].querySelector('.stack-h');
      const last = Math.max.apply(null, [].map.call(a.querySelectorAll('.card'), (c) => c._plan ? c.getBoundingClientRect().bottom : 0));
      return last > b.getBoundingClientRect().top + 2;
    });
    assert(!bad, `${w}x${h}: To answer runs into To finish`);
    await p.context().close();
  }
});
await check("a new card held back is never lost", async () => {
  const p = await open("scene=light");
  await p.evaluate(() => { App.state.entities.filter((e) => e.id !== "pr-6204").forEach((e) => { e.settled = true; e.task = { by: "you" }; }); App.state.clusters.length = 0; App.drawNoticed(); App.layOut(true); });
  await hover(p, "pr-6204");
  await p.evaluate(() => App.arrive({ id: "pr-6270", kind: "github/pull-request", concern: "reviewRequested", title: "New", since: World.hoursAgo(0.02), fields: { number: 6270, repo: "storefront-web", author: "ines-carvalho", state: "running", diff: [1, 1], files: 1 }, signals: [World.signal("reviewRequested", 0.02, "ines-carvalho")], task: null, project: "storefront-web" }));
  await p.evaluate(() => Moves.dismiss(App.findEntity("pr-6204")));
  await p.waitForTimeout(800);
  assert(await has(p, "pr-6270"), "the card that waited was lost");
  assert((await p.evaluate(() => App.state.mode)) === "stacks", "the sunrise came with a card waiting");
  return p;
});
await check("a stack turns over: held cards settle, nothing is lost, keys carry on", async () => {
  const p = await open("");
  await p.evaluate(() => Keys.focus("pr-6204"));
  for (let i = 0; i < 4; i++) { await p.keyboard.press("t"); await p.waitForTimeout(90); }
  await p.keyboard.press("t"); await p.waitForTimeout(400);
  const taken = await p.evaluate(() => App.state.entities.filter((e) => App.readStack(e) === "review" && e.task && e.signals.length >= 0 && !["pr-6199"].includes(e.id)).length);
  assert(taken === 5, `a key was lost: ${taken} of 5 taken`);
  await p.waitForTimeout(900);
  const held = await p.evaluate(() => [].slice.call(document.querySelectorAll('[data-stack="review"] .card.is-folding')).length);
  assert(held === 0, "held cards are still on their way");
  return p;
});
await check("a slow second click at the same spot dismisses the next card", async () => {
  const p = await open("");
  await hover(p, "pr-6209"); await p.waitForTimeout(80);
  const x = await p.evaluate(() => { const r = document.querySelector('[data-id="pr-6209"] [data-act="dismiss"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await p.mouse.move(x.x, x.y, { steps: 3 }); await p.waitForTimeout(700);
  const before = await count(p);
  await p.mouse.click(x.x, x.y); await p.waitForTimeout(800); await p.mouse.click(x.x, x.y); await p.waitForTimeout(300);
  assert((await count(p)) === before - 2, `dismissed ${before - (await count(p))} of 2`);
  assert(!(await p.evaluate(() => Open.isOpen())), "the second click opened a card");
  return p;
});
await check("undo keeps what Hercule noticed since", async () => {
  const p = await open("");
  await p.evaluate(() => { Keys.focus("c-coupons"); });
  await p.keyboard.press("e"); await p.waitForTimeout(300);
  await p.evaluate(() => Live.next()); await p.waitForTimeout(300);
  await p.keyboard.press("Control+z"); await p.waitForTimeout(400);
  const ids = await p.evaluate(() => App.state.clusters.map((c) => c.id));
  assert(ids.includes("c-scanners") && ids.includes("c-coupons"), `the plate holds ${ids}`);
  const slots = await p.evaluate(() => [].map.call(document.querySelectorAll(".plaque"), (e) => e.dataset.slot));
  assert(new Set(slots).size === slots.length, "two things share a column of the plate");
  return p;
});
await check("a carry raises the rail", async () => {
  const p = await open("");
  const a = await point(p, "pr-6213");
  await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move(a.x + 30, a.y + 40, { steps: 4 }); await p.waitForTimeout(450);
  const o = await p.evaluate(() => getComputedStyle(document.getElementById("rail")).opacity);
  assert(Number(o) > 0.9, `the rail is at opacity ${o}`);
  await p.mouse.up();
  return p;
});

await browser.close();
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log("\nall good");

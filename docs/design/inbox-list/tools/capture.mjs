// Captures every state of the drawing in every theme, as WebP, into screens/<theme>/<state>.webp.
//
//   node docs/design/inbox-list/tools/capture.mjs [theme,theme] [state,state] [--png]
//
// The story page's gallery reads the same list (STATES), so a state added here shows there too.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith("--"));
const THEMES = (pos[0] || "whitehaven,styles,orient-express,nile,end-house,blue-train").split(",");
const only = pos[1] ? pos[1].split(",") : null;
const png = argv.includes("--png");

// [file name, query, { w, h, wait, run }]
const carry = async (p) => {
  const at = await p.evaluate(() => { const r = document.querySelector('[data-key="r:pr-6213"]').getBoundingClientRect(); return { x: r.left + 140, y: r.top + 20 }; });
  const to = await p.evaluate(() => { const r = document.querySelector('[data-key="r:pr-6230"]').getBoundingClientRect(); return { x: r.left + 200, y: r.top + 30 }; });
  await p.mouse.move(at.x, at.y); await p.mouse.down(); await p.mouse.move(at.x + 12, at.y + 8, { steps: 3 }); await p.mouse.move(to.x, to.y, { steps: 14 }); await p.waitForTimeout(400);
};
const hoverRow = (key) => async (p) => { const at = await p.evaluate((k) => { const r = document.querySelector(`[data-key="${k}"]`).getBoundingClientRect(); return { x: r.left + 9, y: r.top + 17 }; }, key); await p.mouse.move(at.x + 260, at.y); await p.waitForTimeout(120); await p.mouse.move(at.x + 12, at.y + 1); await p.waitForTimeout(300); };
const scopeMenu = async (p) => { await p.click("#scope-btn"); await p.waitForTimeout(300); };
export const STATES = [
  ["01-waits", "", {}, "Someone waits on me"],
  ["02-hover-select", "", { run: hoverRow("r:pr-6213") }, "A row under the pointer: its mark makes way for a tick"],
  ["03-pr-two-signals", "scene=pr", {}, "A pull request with two open signals"],
  ["04-pr-second-signal", "scene=pr-second", { wait: 1200 }, "The review request unfolded"],
  ["05-linear", "scene=linear", {}, "A Linear issue, in Mine"],
  ["06-sentry", "scene=sentry", {}, "A Sentry error that came back"],
  ["07-email", "scene=email", {}, "An email that asks you"],
  ["08-group-closed", "scene=group", {}, "A linked group, closed"],
  ["09-group-open", "scene=group-open", {}, "A linked group, open"],
  ["10-group-large", "scene=large", {}, "A long chain of links: one large group"],
  ["11-triage", "scene=triage", {}, "Triage: a Proposal"],
  ["12-suggestion", "scene=suggestion", {}, "Triage: a link Hercule suggests"],
  ["13-browse", "scene=browse", {}, "Browse: one Linear project"],
  ["14-two-accounts", "scene=accounts", {}, "Browse: Sentry with two accounts"],
  ["15-search", "scene=search,searchmenu", { wait: 1100 }, "Search tokens, with values offered"],
  ["16-narrow", "scene=narrowmenu", { wait: 1100 }, "Narrow: a facet's values"],
  ["17-selection", "scene=selection", {}, "Three selected"],
  ["18-hand-menu", "scene=hand", { wait: 1300 }, "Hand-off: several workflows fit"],
  ["19-link-to", "scene=linkto", { wait: 1100 }, "L on one thing: Link to…"],
  ["20-carrying", "", { run: carry }, "Carrying a row onto another"],
  ["21-dialog", "scene=dialog", { wait: 1300 }, "N on a group: the thread dialog"],
  ["22-dialog-why", "scene=dialog-why", { wait: 1400 }, "The reason behind a default"],
  ["23-dialog-unpicked", "scene=dialog-unpicked", { wait: 1300 }, "No evidence: the project waits for you"],
  ["24-dialog-started", "scene=dialog-started", { wait: 4200 }, "The thread's first moments"],
  ["25-dialog-context", "scene=dialog-context", { wait: 4200 }, "Context sent with it, unfolded"],
  ["26-reply", "scene=reply", { wait: 1100 }, "Reply…, in its signal's section"],
  ["27-new-bar", "scene=new", { wait: 1300 }, "Arrivals wait behind the bar"],
  ["28-held", "scene=held", {}, "With Hercule"],
  ["29-empty", "scene=empty", { wait: 2600 }, "Nobody waits on you"],
  ["30-zero", "scene=zero", { wait: 2600 }, "All clear"],
  ["31-loading", "scene=loading", {}, "Loading"],
  ["32-offline", "scene=offline", {}, "Offline"],
  ["33-failing", "scene=failing", {}, "A source that can’t be read"],
  ["34-light", "load=light", {}, "A light day"],
  ["35-extreme", "load=extreme", { wait: 1600 }, "2,400 things"],
  ["36-width-1280", "scene=pr", { w: 1280, h: 800 }, "At 1280 px: the rail folds into the bar, the list keeps 400 px"],
  ["37-width-1024-scope", "", { w: 1024, h: 768, run: scopeMenu }, "At 1024 px: the rail as a menu"],
  ["41-stacked-880", "", { w: 880, h: 700, run: async (p) => { await p.evaluate(() => App.focusRow("r:pr-6213", { keyboard: true })); await p.keyboard.press("Enter"); await p.waitForTimeout(500); } }, "Under 1032 px, or at 200% zoom: the pane over the list"],
  ["42-selection-one", "", { run: async (p) => { await p.evaluate(() => { App.focusRow("r:gm-quote"); Moves.toggleSelect("gm-quote"); App.focusRow("r:pr-6230"); }); await p.waitForTimeout(300); } }, "One thing selected, another current: the pane shows the selection"],
  ["38-keys", "scene=keys", {}, "The keys"],
  ["39-pane-wide", "scene=wide", {}, "The pane, made wide"],
  ["40-undo", "scene=undo", { wait: 1200 }, "Dismissed, with Undo"],
];

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await chromium.launch();
  const errors = [];
  const ctxs = {};
  const ctxFor = async (w, h) => { const k = w + "x" + h; if (!ctxs[k]) ctxs[k] = await browser.newContext({ viewport: { width: w, height: h } }); return ctxs[k]; };
  const encoder = await (await ctxFor(1440, 900)).newPage();
  async function save(page, path) {
    if (png) { await page.screenshot({ path: path + ".png" }); return; }
    const b64 = (await page.screenshot()).toString("base64");
    const out = await encoder.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext("2d").drawImage(bmp, 0, 0);
      const buf = new Uint8Array(await (await c.convertToBlob({ type: "image/webp", quality: 0.84 })).arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    }, b64);
    writeFileSync(path + ".webp", Buffer.from(out, "base64"));
  }
  for (const theme of THEMES) {
    mkdirSync(resolve(root, "screens", theme), { recursive: true });
    for (const [name, q, o] of STATES) {
      if (only && !only.some((x) => name.includes(x))) continue;
      const ctx = await ctxFor(o.w || 1440, o.h || 900);
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(`${theme}/${name}: ${e.message}`));
      await page.goto(pathToFileURL(resolve(root, "desktop.html")).href + `?theme=${theme}&${q}`);
      await page.waitForSelector("html[data-ready]");
      await page.waitForTimeout(o.wait || 900);
      if (o.run) await o.run(page);
      await save(page, resolve(root, "screens", theme, name));
      await page.close();
    }
    console.log("captured " + theme);
  }
  // The story page's gallery reads this list.
  writeFileSync(resolve(root, "screens", "states.js"), "// Written by tools/capture.mjs: the states the gallery shows.\nwindow.STATES = " + JSON.stringify(STATES.map((s) => [s[0], s[3]])) + ";\n");
  await browser.close();
  if (errors.length) { console.log("ERRORS\n" + errors.join("\n")); process.exit(1); }
}

// Drives the drawing's flows and fails on any page error, console error, or broken expectation.
// It also fails when a view file names a source: every source word must come from js/kinds.js.
//
//   node docs/design/inbox-list/tools/check.mjs
//
// On a Linux machine without Chromium's libraries, run it in the desktop container image (see
// DESIGN.md, "Running the tools").
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const page0 = pathToFileURL(resolve(root, "desktop.html")).href;
const failures = [];
const fail = (what) => { failures.push(what); console.log("FAIL " + what); };

// ---- No view names a source ----
const VIEWS = ["app", "rail", "list", "pane", "parts", "bar", "menus", "moves", "dialog", "drag", "keys", "draw", "model"];
for (const v of VIEWS) {
  const text = readFileSync(resolve(root, "js", v + ".js"), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const m = text.match(/\b(github|linear|sentry|gmail|slack|quayside)\b/i);
  if (m) fail(`js/${v}.js names the source "${m[0]}"; read it from js/kinds.js instead`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

async function open(query) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fail(`${query}: page error: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error") fail(`${query}: console error: ${m.text()}`); });
  await p.goto(page0 + "?" + query);
  await p.waitForSelector("html[data-ready]");
  await p.waitForTimeout(150);
  return p;
}
const expect = async (p, what, fn, arg) => { if (!(await p.evaluate(fn, arg))) fail(what); };
const key = async (p, k, n = 1) => { for (let i = 0; i < n; i++) { await p.keyboard.press(k); await p.waitForTimeout(40); } };
const settle = (p, ms = 700) => p.waitForTimeout(ms);

// ---- Every scene opens without an error, in two themes ----
const SCENES = ["", "pr", "pr-second", "linear", "sentry", "email", "group", "group-open", "large", "large-all", "triage", "proposal", "suggestion", "browse", "accounts", "selection", "search", "held", "updates", "everything", "empty", "zero", "nosearch", "loading", "offline", "failing", "new", "wide", "narrow", "hand", "linkto", "narrowmenu", "searchmenu", "keys", "dialog", "dialog-one", "dialog-unpicked", "dialog-why", "dialog-started", "dialog-context", "reply", "undo"];
for (const theme of ["whitehaven", "blue-train"]) {
  for (const s of SCENES) { const p = await open(`theme=${theme}&scene=${s}`); await settle(p, 300); await p.close(); }
}
for (const load of ["light", "extreme"]) { const p = await open(`load=${load}`); await settle(p, 300); await p.close(); }

// ---- J and K walk the list, and the pane follows ----
{
  const p = await open("theme=whitehaven");
  await p.focus("#rows");
  await key(p, "j", 3);
  await expect(p, "J moves the current row", () => App.state.focus && App.state.rows.findIndex((r) => r.key === App.state.focus) === 3);
  await key(p, "k");
  await expect(p, "K moves back", () => App.state.rows.findIndex((r) => r.key === App.state.focus) === 2);
  await expect(p, "the pane shows the current row", () => !!document.querySelector("#pane .pn-title"));
  await p.close();
}

// ---- X selects two, L links them into a group, ⌘Z takes the link back ----
{
  const p = await open("theme=whitehaven");
  const before = await p.evaluate(() => Model.links().length);
  await p.evaluate(() => App.focusRow("r:pr-6213"));
  await key(p, "x");
  await p.evaluate(() => App.focusRow("r:pr-6230"));
  await key(p, "x");
  await expect(p, "X selects", () => App.state.selection.size === 2);
  await expect(p, "the selection bar shows", () => !document.getElementById("selbar").hidden);
  await key(p, "l");
  await settle(p);
  await expect(p, "L links the selection", (b) => Model.links().length === b + 1, before);
  await expect(p, "the new group is open and current", () => App.currentRow() && App.currentRow().type === "group" && App.currentRow().open);
  await expect(p, "the flight layer is empty after the link", () => document.getElementById("flight").children.length === 0);
  await p.keyboard.press("Control+z");
  await settle(p);
  await expect(p, "⌘Z unlinks", (b) => Model.links().length === b, before);
  await p.close();
}

// ---- E dismisses and the next row becomes current; undo brings it back ----
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => App.focusRow("r:gm-quote"));
  const at = await p.evaluate(() => App.state.rows.findIndex((r) => r.key === "r:gm-quote"));
  await key(p, "e");
  await settle(p);
  await expect(p, "E dismisses", () => Model.gone.has("gm-quote") && !App.state.rows.some((r) => r.key === "r:gm-quote") && !document.querySelector('#rows [data-key="r:gm-quote"]'));
  await expect(p, "the row that took its place is current", (i) => App.state.rows.findIndex((r) => r.key === App.state.focus) === i, at);
  await expect(p, "the undo line shows", () => document.getElementById("undo").classList.contains("is-on"));
  await p.click("#undo [data-undo]");
  await settle(p);
  await expect(p, "Undo brings it back", () => !Model.gone.has("gm-quote"));
  await p.close();
}

// ---- E on a group dismisses all of it with one undo ----
{
  const p = await open("theme=whitehaven&scene=group");
  await key(p, "e");
  await settle(p);
  await expect(p, "E dismisses the whole group", () => ["shop-142", "pr-6244", "sn-1z9", "sl-2201"].every((id) => Model.gone.has(id)));
  await p.keyboard.press("Control+z");
  await settle(p);
  await expect(p, "one undo brings the group back", () => ["shop-142", "pr-6244", "sn-1z9", "sl-2201"].every((id) => !Model.gone.has(id)));
  await p.close();
}

// ---- H: the menu with several workflows, a pick by number; a single workflow hands at once ----
{
  const p = await open("theme=whitehaven&scene=pr");
  await key(p, "h");
  await settle(p, 300);
  await expect(p, "H opens the menu when several workflows fit", () => !document.getElementById("handmenu").hidden);
  await key(p, "j");
  await expect(p, "an open menu keeps J from the page", () => App.state.focus === "m:shop-142:pr-6244");
  await key(p, "1");
  await settle(p, 1400);
  await expect(p, "1 hands it to the first workflow", () => Model.byId("pr-6244").held && Model.byId("pr-6244").held.by === "Review PR");
  await expect(p, "the review request ended, the mention stays", () => Model.byId("pr-6244").signals.find((s) => s.kind === "review").done && !Model.byId("pr-6244").signals.find((s) => s.kind === "mention").done);
  await p.close();
  const q = await open("theme=whitehaven&scene=sentry");
  await key(q, "h");
  await settle(q, 1400);
  await expect(q, "H hands at once with one workflow", () => Model.byId("sn-21c").held && Model.byId("sn-21c").held.by === "Triage errors");
  await q.close();
  const g = await open("theme=whitehaven&scene=group");
  await key(g, "h");
  await expect(g, "H on a group refuses with a reason", () => /one thing at a time/.test(document.getElementById("undo").textContent));
  await g.close();
}

// ---- T takes it on; G says where the Task is ----
{
  const p = await open("theme=whitehaven&scene=email");
  await key(p, "t");
  await settle(p);
  await expect(p, "T takes it on", () => Model.byId("gm-quote").held && Model.byId("gm-quote").held.by === "you");
  await expect(p, "it leaves Someone waits on me", () => !App.state.rows.some((r) => r.thing && r.thing.id === "gm-quote"));
  await p.close();
}

// ---- N opens the thread dialog; defaults from evidence; Esc closes; ⌘↩ starts ----
{
  const p = await open("theme=whitehaven&scene=group");
  await key(p, "n");
  await settle(p, 500);
  await expect(p, "N opens the dialog", () => !document.getElementById("dialog").hidden);
  await expect(p, "the project comes from #6244's repository", () => /webshop/.test(document.querySelector("#dialog .td-why").textContent));
  await expect(p, "the things are chips", () => document.querySelectorAll("#dialog .td-chip").length === 4);
  await expect(p, "the message box has the focus", () => document.activeElement && document.activeElement.matches("[data-text]"));
  await key(p, "j");
  await expect(p, "page keys stay out of the dialog", () => App.state.focus === "g:shop-142");
  await p.keyboard.press("Control+Enter");
  await settle(p, 2600);
  await expect(p, "⌘↩ starts the thread and shows its first moments", () => !!document.querySelector("#dialog .td-msg--you") && document.querySelectorAll("#dialog .td-tools li").length === 4);
  await key(p, "Escape");
  await settle(p, 500);
  await expect(p, "Esc closes the dialog", () => document.getElementById("dialog").hidden);
  await expect(p, "the things left the list", () => !App.state.rows.some((r) => r.key === "g:shop-142"));
  await p.close();
  const q = await open("theme=whitehaven&scene=dialog-unpicked");
  await settle(q, 400);
  await expect(q, "with no evidence the project is unpicked", () => /Choose a project/.test(document.querySelector("#dialog .lip").textContent));
  await expect(q, "and Send waits for it", () => document.querySelector("#dialog [data-send]").getAttribute("aria-disabled") === "true");
  await q.close();
}

// ---- Search tokens, offered values, and Narrow ----
{
  const p = await open("theme=whitehaven");
  await key(p, "/");
  await p.keyboard.type("team:");
  await settle(p, 200);
  await expect(p, "team: offers values with counts", () => document.querySelectorAll("#sx-menu .sx-item").length > 0 && /\d/.test(document.querySelector("#sx-menu .sx-n").textContent));
  await key(p, "Enter");
  await settle(p, 200);
  await expect(p, "Enter adds a token", () => App.state.search.clauses.length === 1);
  await key(p, "Backspace");
  await expect(p, "Backspace removes the last token", () => App.state.search.clauses.length === 0);
  await key(p, "Escape");
  await p.click("[data-narrow]");
  await p.click('#narrow [data-nf="linear|project"]');
  await p.click("#narrow [data-nv]");
  await expect(p, "Narrow adds the same clause the search would", () => App.state.search.clauses.length === 1 && App.state.search.clauses[0].key === "project");
  await p.close();
}

// ---- The rail: saved queries by number, Browse values, pins, Triage ----
{
  const p = await open("theme=whitehaven");
  for (let i = 1; i <= 7; i++) { await key(p, String(i)); await expect(p, `${i} picks a saved query`, (n) => App.state.scope.saved === Kinds.SAVED[n - 1].id, i); }
  await key(p, "8");
  await expect(p, "8 opens Triage", () => App.state.scope.triage === 1);
  await p.click('.ib-rail [data-fold="sentry"]');
  await expect(p, "a Browse source unfolds", () => !App.state.folded.has("sentry"));
  await expect(p, "Sentry browses by account", () => document.querySelectorAll(".ib-rail .rl-acct").length === 2);
  await p.click('.ib-rail .rl-row--val');
  await expect(p, "a Browse value scopes the list", () => !!App.state.scope.browse);
  await p.close();
}

// ---- Groups fold by arrows; a large group folds after five ----
{
  const p = await open("theme=whitehaven&scene=large");
  await expect(p, "a large group shows five and a row for the rest", () => App.state.rows.filter((r) => r.type === "member" && r.group.lead.id === "pay-88").length === 5 && App.state.rows.some((r) => r.type === "more"));
  await key(p, "ArrowLeft");
  await settle(p);
  await expect(p, "← folds the group", () => !App.state.open.has("g:pay-88"));
  await key(p, "ArrowRight");
  await settle(p);
  await expect(p, "→ unfolds it", () => App.state.open.has("g:pay-88"));
  await p.close();
}

// ---- Dragging a row onto another links them ----
{
  const p = await open("theme=whitehaven");
  const box = async (k) => p.evaluate((k) => { const r = document.querySelector(`[data-key="${k}"]`).getBoundingClientRect(); return { x: r.left + 120, y: r.top + 20 }; }, k);
  const a = await box("r:pr-6213"), b = await box("r:pr-6230");
  await p.mouse.move(a.x, a.y);
  await p.mouse.down();
  await p.mouse.move(a.x + 10, a.y + 10, { steps: 3 });
  await p.mouse.move(b.x, b.y, { steps: 10 });
  await expect(p, "the row under a carried row lights", () => !!document.querySelector(".row.is-drop"));
  await p.mouse.up();
  await settle(p);
  await expect(p, "letting go links them", () => Model.links().some((l) => (l[0] === "pr-6230" && l[1] === "pr-6213") || (l[0] === "pr-6213" && l[1] === "pr-6230")));
  await p.close();
}

// ---- New arrivals wait behind the bar; . shows them ----
{
  const p = await open("theme=whitehaven&scene=arrive");
  await settle(p, 1700);
  await expect(p, "arrivals wait behind the bar", () => !!document.querySelector("[data-newbar]") && App.state.pending.length === 3 && !App.state.rows.some((r) => r.thing && r.thing.id === "pr-6281"));
  await key(p, ".");
  await settle(p, 900);
  await expect(p, ". shows them", () => App.state.pending.length === 0 && App.state.rows.some((r) => r.thing && r.thing.id === "pr-6281"));
  await p.close();
}

// ---- Answers are scoped to one signal ----
{
  const p = await open("theme=whitehaven&scene=pr-second");
  await settle(p, 400);
  await p.click('#pane [data-done="s3"]');
  await settle(p);
  await expect(p, "Done on the mention leaves the review request open", () => Model.byId("pr-6244").signals.find((s) => s.id === "s3").done && !Model.byId("pr-6244").signals.find((s) => s.id === "s2").done);
  await p.close();
}

// ---- The pane resizes by keyboard ----
{
  const p = await open("theme=whitehaven");
  await p.focus("#edge");
  await key(p, "ArrowLeft");
  await settle(p, 500);
  await expect(p, "← widens the pane", () => App.state.paneW === 460);
  await p.close();
}

// ---- Round-one regressions ----
{
  const p = await open("theme=whitehaven&scene=pr");
  await expect(p, "a folded ask's answers are out of reach", () => document.querySelector('#pane [data-signal="s2"] .sig-body').inert === true);
  await p.focus('#pane [data-done="s3"]');
  await key(p, "Enter");
  await settle(p);
  await expect(p, "↩ on a focused button runs that button, not the suggested answer", () => Model.byId("pr-6244").signals.find((x) => x.id === "s3").done && !Model.byId("pr-6244").signals.find((x) => x.id === "s2").done);
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await p.focus('#rail .rl-row.is-on');
  await key(p, "e");
  await expect(p, "E in the rail dismisses nothing", () => Model.gone.size === 0);
  await expect(p, "the rail is one Tab stop", () => document.querySelectorAll('#rail [tabindex="0"]').length === 1);
  await key(p, "/");
  await p.keyboard.type("events:>500");
  await key(p, "Enter");
  await expect(p, "a typed token with any threshold becomes a token", () => App.state.search.clauses.some((c) => c.key === "events" && c.value === ">500"));
  await key(p, "Escape");
  await expect(p, "Esc leaves the search and keeps it", () => App.state.search.clauses.length === 1 && document.activeElement !== document.getElementById("sx-input"));
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=dialog-unpicked");
  await settle(p, 400);
  await p.keyboard.press("Control+Enter");
  await settle(p, 300);
  await expect(p, "with no project, ⌘↩ opens the project picker in view", () => { const m = document.getElementById("td-pop"); const r = m.getBoundingClientRect(); return !m.hidden && r.bottom <= innerHeight && r.top >= 0 && r.height > 40; });
  await p.click('#td-pop [data-pick-project=""]');
  await settle(p, 200);
  await expect(p, "No project is a choice, and Send is ready", () => /No project/.test(document.querySelector("#dialog .lip").textContent) && document.querySelector("#dialog [data-send]").getAttribute("aria-disabled") !== "true");
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=sentry");
  await key(p, "h");
  await p.waitForTimeout(250);
  await p.keyboard.press("Control+z");
  await settle(p, 1400);
  await expect(p, "undo inside the hand-off chain wins", () => !Model.byId("sn-21c").held && App.state.rows.some((r) => r.thing && r.thing.id === "sn-21c"));
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  const y0 = await p.evaluate(() => document.querySelector('#rows [data-key]').getBoundingClientRect().top);
  await p.evaluate(() => Live.arrive(World.arrivals()));
  await settle(p, 500);
  await expect(p, "the N new bar moves no row", (y) => document.querySelector('#rows [data-key]').getBoundingClientRect().top === y, y0);
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=group");
  await key(p, "x");
  await expect(p, "a picked group shows its tick", () => getComputedStyle(document.querySelector('[data-key="g:shop-142"] .row-tick')).opacity === "1");
  await p.close();
}
for (const s of ["pr", "accounts", "selection", "reply", "proposal"]) {
  const p = await open("theme=end-house&scene=" + s);
  await settle(p, 300);
  await expect(p, `the pane footer fits (${s})`, () => { const f = document.querySelector("#pane .pn-foot"); return !f || f.scrollWidth <= f.clientWidth + 1; });
  await p.close();
}

// ---- Round-three regressions ----
{
  const p = await open("theme=whitehaven&scene=suggestion");
  const before = await p.evaluate(() => Model.links().length);
  await p.focus('[data-key="t:link-6251"]');
  await key(p, "l");
  await settle(p);
  await expect(p, "accepting a suggested link writes the link", (b) => Model.links().length === b + 1 && !!Model.groupOf("pr-6251"), before);
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=group-member");
  await p.focus('[data-key="m:shop-142:pr-6244"]');
  await key(p, "t");
  await settle(p, 900);
  await expect(p, "after a move the current row is in view", () => { const el = document.querySelector('[data-key="' + App.state.focus + '"]'); const r = el.getBoundingClientRect(), box = document.getElementById("list-scroll").getBoundingClientRect(); return r.top >= box.top - 1 && r.bottom <= box.bottom + 1; });
  await p.close();
}

{
  const p = await open("theme=whitehaven");
  await key(p, "?");
  await p.keyboard.press("Shift+Tab");
  await settle(p, 200);
  await expect(p, "the keys sheet closes when the focus leaves it", () => document.getElementById("keys").hidden);
  await p.evaluate(() => App.focusRow("r:pr-6213", { keyboard: true }));
  await key(p, "5");
  await p.keyboard.press("Shift+J");
  await expect(p, "⇧J after changing lists selects two rows, not a stale range", () => { const i = App.state.rows.findIndex((r) => r.key === App.state.focus); return App.state.selection.size === new Set([...Keys.idsOf(App.state.rows[i - 1]), ...Keys.idsOf(App.state.rows[i])]).size; });
  await key(p, "Escape");
  await key(p, "/");
  await p.keyboard.type("events:>10");
  await settle(p, 150);
  await key(p, "Enter");
  await expect(p, "a threshold typed in full is kept as typed", () => App.state.search.clauses.some((c) => c.value === ">10"));
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=large");
  await p.evaluate(() => App.focusRow("x:pay-88", { keyboard: true }));
  await key(p, "Enter");
  await settle(p, 500);
  await expect(p, "Show N more makes the first newly shown member current", () => App.currentRow() && App.currentRow().type === "member" && App.currentRow().group.lead.id === "pay-88");
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=sentry");
  await p.focus('[data-key="r:sn-21c"]');
  await key(p, "h");
  await expect(p, "after H the next row is current at once", () => App.state.focus !== "r:sn-21c");
  await p.close();
}
{
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx3.newPage();
  p.on("pageerror", (e) => fail(`1280: page error: ${e.message}`));
  await p.goto(page0 + "?theme=whitehaven");
  await p.waitForSelector("html[data-ready]");
  await p.focus("#scope-btn");
  await key(p, "Enter");
  await expect(p, "the scope menu puts the focus in it", () => document.getElementById("scope-pop").contains(document.activeElement));
  await key(p, "ArrowDown");
  await key(p, "Enter");
  await expect(p, "↓ and ↩ pick the next entry", () => App.state.scope.saved === "mine");
  await ctx3.close();
}

// ---- Round-two regressions ----
{
  const p = await open("theme=whitehaven");
  await expect(p, "a closed group says it is closed", () => document.querySelector('[data-key="g:shop-142"]').getAttribute("aria-expanded") === "false");
  await key(p, "/");
  await p.keyboard.type("team:Ch");
  await settle(p, 200);
  await key(p, "Enter");
  await expect(p, "↩ on a half-typed value takes the highlighted value", () => App.state.search.clauses.length === 1 && App.state.search.clauses[0].value === "Checkout");
  await key(p, "Backspace");
  await key(p, "Backspace");
  await expect(p, "⌫ with no query never changes the saved query", () => App.state.scope.saved === "waits");
  await key(p, "Escape");
  await p.focus(".side .nav-row");
  await key(p, "e");
  await key(p, "3");
  await expect(p, "single keys do nothing from the sidebar", () => Model.gone.size === 0 && App.state.scope.saved === "waits");
  await p.evaluate(() => App.focusRow("r:pr-6213"));
  await key(p, "l");
  await settle(p, 200);
  await p.keyboard.press("Tab");
  await expect(p, "Tab out of Link to… closes it", () => document.getElementById("linkto").hidden);
  await key(p, "?");
  await key(p, "Escape");
  await expect(p, "Esc in the keys sheet closes it", () => document.getElementById("keys").hidden);
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => { App.focusRow("r:gm-quote"); Moves.toggleSelect("gm-quote"); App.focusRow("r:pr-6230"); });
  await expect(p, "one thing selected elsewhere gets the selection pane", () => /1 thing selected/.test(document.querySelector("#pane .pn-title").textContent));
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => App.focusRow("r:po-2291"));
  await p.focus('[data-key="r:po-2291"]');
  await key(p, "e");
  await p.waitForTimeout(150);
  const onGroup = await p.evaluate(() => App.currentRow() && App.currentRow().type === "group");
  if (onGroup) { await key(p, "e"); await expect(p, "a quick E never dismisses a group that just came under the keys", () => !Model.gone.has("shop-142") && !Model.gone.has("pay-88")); }
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=new");
  await settle(p, 300);
  await key(p, ".");
  await settle(p, 900);
  await expect(p, ". makes the first new row current and puts it in view", () => { const r = App.currentRow(); const el = document.querySelector('[data-key="' + App.state.focus + '"]').getBoundingClientRect(); const box = document.getElementById("list-scroll").getBoundingClientRect(); return r && r.thing && ["pr-6281", "gm-crates2", "sl-2270"].includes(r.thing.id) && el.top >= box.top && el.bottom <= box.bottom; });
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=pr");
  await expect(p, "the hand-off face is drawn whole", () => { const f = document.querySelector("#pane .pn-faces svg"); return !f || Math.round(f.getBoundingClientRect().width) === 18; });
  await p.evaluate(() => App.setPaneWidth(640));
  await expect(p, "the pane never squeezes the list under 400px", () => document.querySelector(".ib-list").getBoundingClientRect().width >= 399);
  await p.close();
}
{
  const ctx2 = await browser.newContext({ viewport: { width: 880, height: 700 } });
  const p = await ctx2.newPage();
  p.on("pageerror", (e) => fail(`stacked: page error: ${e.message}`));
  await p.goto(page0 + "?theme=whitehaven");
  await p.waitForSelector("html[data-ready]");
  await p.evaluate(() => App.focusRow("r:pr-6213", { keyboard: true }));
  await key(p, "Enter");
  await settle(p, 400);
  await expect(p, "under 1032px ↩ slides the pane in over the list", () => { const r = document.getElementById("pane").getBoundingClientRect(); return r.width > 300 && r.right <= innerWidth + 1 && r.left >= 0; });
  await key(p, "Escape");
  await settle(p, 400);
  await expect(p, "Esc slides it out and the row has the focus", () => !document.getElementById("ib").classList.contains("is-pane-open") && document.activeElement.dataset.key === "r:pr-6213");
  await ctx2.close();
}

// ---- Round-four regressions ----
{
  const p = await open("theme=whitehaven&scene=suggestion");
  await p.focus('[data-key="t:link-6251"]');
  await key(p, "l");
  await p.waitForTimeout(60);
  await expect(p, "an accepted suggestion's row never flies into the group", () => !document.querySelector("#flight [data-triage]"));
  await settle(p);
  await p.keyboard.press("Meta+z");
  await settle(p, 500);
  await expect(p, "⌘Z on an accepted suggestion brings the suggestion back", () => !Model.gone.has("link-6251") && App.state.rows.some((r) => r.key === "t:link-6251"));
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => App.focusRow("r:pr-6213", { keyboard: true }));
  await key(p, "e");
  await settle(p, 400);
  await p.keyboard.press("Meta+z");
  await settle(p, 500);
  await expect(p, "⌘Z after E makes the thing current and focused again", () => App.state.focus === "r:pr-6213" && document.activeElement.dataset.key === "r:pr-6213");
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  const row = await p.evaluate(() => App.state.rows.find((r) => r.thing && r.thing.id === "gm-invoice").key);
  await p.evaluate((k) => App.focusRow(k, { keyboard: true }), row);
  await key(p, "h");
  await p.waitForTimeout(120);
  const onGroup = await p.evaluate(() => App.currentRow() && App.currentRow().type === "group");
  await key(p, "e");
  if (onGroup) await expect(p, "H then a quick E never dismisses a group", () => !App.state.rows.length || Model.gone.size === 0);
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await key(p, "/");
  await p.keyboard.type("project:Checkout revamp");
  await settle(p, 200);
  await key(p, "Enter");
  await settle(p, 200);
  await expect(p, "a value with a space is typed out whole", () => App.state.search.clauses.length === 1 && App.state.search.clauses[0].value === "Checkout revamp" && !App.state.search.text);
  await key(p, "Backspace");
  await p.keyboard.type("team:Checkout bug");
  await settle(p, 200);
  await expect(p, "a space still ends a value nothing continues", () => App.state.search.clauses.some((c) => c.key === "team" && c.value === "Checkout") && App.state.search.text === "bug");
  await key(p, "Escape");
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=zero");
  await settle(p, 300);
  await expect(p, "with nothing current, ? stays inside the window", () => document.querySelector("[data-help]").getBoundingClientRect().right <= innerWidth);
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => App.focusRow("r:pr-6213", { keyboard: true }));
  await key(p, "e");
  await key(p, "x");
  await key(p, "j");
  await key(p, "x");
  await settle(p, 300);
  await expect(p, "the undo line rises over the selection bar", () => { const a = document.getElementById("undo").getBoundingClientRect(), b = document.getElementById("selbar").getBoundingClientRect(); return a.bottom <= b.top; });
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=hand");
  await settle(p, 400);
  await key(p, "Tab");
  await expect(p, "Tab in the hand-off menu reaches the account picker", () => document.activeElement && document.activeElement.matches("#handmenu select"));
  await key(p, "Escape");
  await p.close();
}
for (const w of [1024, 1120]) {
  const c = await browser.newContext({ viewport: { width: w, height: 760 } });
  const p = await c.newPage();
  p.on("pageerror", (e) => fail(`${w}: page error: ${e.message}`));
  await p.goto(page0 + "?theme=whitehaven&scene=offline");
  await p.waitForSelector("html[data-ready]");
  await expect(p, `the search hint fits whole at ${w}px`, () => { const i = document.getElementById("sx-input"); const s = document.createElement("span"); s.className = "sx-measure"; s.textContent = i.placeholder; i.parentElement.appendChild(s); const ok = s.offsetWidth <= i.clientWidth; s.remove(); return ok; });
  await p.evaluate(() => { App.state.search.clauses.push({ key: "team", value: "Checkout" }, { key: "waiting", value: ">2d" }, { key: "project", value: "Checkout revamp" }); App.render({}); });
  await p.focus("#sx-input");
  await settle(p, 200);
  await expect(p, `no search token is cut at ${w}px`, () => { const box = document.getElementById("sx-chips").getBoundingClientRect(); return [...document.querySelectorAll(".sx-chip")].filter((c) => c.getClientRects().length).every((c) => c.getBoundingClientRect().right <= box.right + 0.5); });
  await c.close();
}
{
  const c = await browser.newContext({ viewport: { width: 880, height: 700 } });
  const p = await c.newPage();
  p.on("pageerror", (e) => fail(`stacked keys: page error: ${e.message}`));
  await p.goto(page0 + "?theme=whitehaven");
  await p.waitForSelector("html[data-ready]");
  await p.evaluate(() => App.focusRow("r:pr-6213", { keyboard: true }));
  await key(p, "Enter");
  await settle(p, 400);
  await key(p, "j");
  await expect(p, "under 1032px with the pane open, J keeps the focus in the pane", () => document.getElementById("pane").contains(document.activeElement));
  await key(p, "e");
  await settle(p, 400);
  await expect(p, "under 1032px with the pane open, E keeps the focus in the pane", () => document.getElementById("pane").contains(document.activeElement));
  await key(p, "F6");
  await expect(p, "F6 moves on from the stacked pane", () => !document.getElementById("pane").contains(document.activeElement));
  await c.close();
}

// ---- Round-five regressions ----
{
  const p = await open("theme=whitehaven");
  await key(p, "/");
  await key(p, "Enter");
  await expect(p, "↩ in an empty search field adds no token", () => App.state.search.clauses.length === 0 && !document.getElementById("sx-input").value);
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=suggestion");
  await p.focus('[data-key="t:link-6251"]');
  await key(p, "l");
  await settle(p);
  await p.keyboard.press("Meta+z");
  await p.waitForTimeout(60);
  await expect(p, "⌘Z on an accepted link never flies a member onto the suggestion's row", () => document.querySelector('[data-key="t:link-6251"]').style.opacity !== "0");
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=triage");
  await p.focus('[data-key="t:prop-kp"]');
  await key(p, "e");
  await settle(p, 400);
  await p.keyboard.press("Meta+z");
  await settle(p, 400);
  await expect(p, "⌘Z on a dismissed Proposal makes it current again", () => App.state.focus === "t:prop-kp");
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=pr");
  await expect(p, "the pane's hand-off button is named for the hand-off, not the face", () => { const b = document.querySelector('#pane [data-move="hand"]'); return !b || /^Hand to/.test(b.getAttribute("aria-label") || ""); });
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => App.focusRow("r:pr-6230", { keyboard: true }));
  await key(p, "Enter");
  await settle(p, 300);
  const box = await p.evaluate(() => { const r = document.getElementById("undo").getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
  await p.mouse.move(box.x, box.y);
  await p.waitForTimeout(9000);
  await expect(p, "a held undo line holds the answer: Undo still shows and nothing is sent", () => !!document.querySelector("#undo [data-undo]") && !Moves.last().sent);
  await p.mouse.move(5, 5);
  await p.waitForTimeout(800);
  await expect(p, "once let go, the answer is sent and Undo goes from the line", () => !document.querySelector("#undo [data-undo]") && !!Moves.last().sent);
  await p.close();
}
{
  const c = await browser.newContext({ viewport: { width: 880, height: 700 } });
  const p = await c.newPage();
  p.on("pageerror", (e) => fail(`stacked inert: page error: ${e.message}`));
  await p.goto(page0 + "?theme=whitehaven");
  await p.waitForSelector("html[data-ready]");
  await p.evaluate(() => App.focusRow("r:pr-6213", { keyboard: true }));
  await key(p, "Enter");
  await settle(p, 400);
  await expect(p, "under 1032px the list under the open pane is inert", () => document.querySelector(".ib-list").inert === true);
  await key(p, "Escape");
  await settle(p, 300);
  await expect(p, "and comes back when the pane slides away", () => document.querySelector(".ib-list").inert === false);
  await c.close();
}

// ---- Round-six regressions ----
for (const w of [960, 1024, 1100]) {
  const c = await browser.newContext({ viewport: { width: w, height: 760 } });
  const p = await c.newPage();
  await p.goto(page0 + "?theme=whitehaven&scene=pr");
  await p.waitForSelector("html[data-ready]");
  await expect(p, `at ${w}px the list keeps 400px or the pane lies over it`, () => App.isStacked() || document.querySelector(".ib-list").getBoundingClientRect().width >= 399);
  await c.close();
}
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => { App.focusRow("r:pr-6213", { keyboard: true }); Moves.toggleSelect("pr-6213"); Moves.toggleSelect("pr-6230"); });
  await p.hover('[data-key="r:gm-quote"]');
  await p.click('[data-key="r:gm-quote"] [data-row-act="dismiss"]');
  await settle(p, 300);
  await expect(p, "a row's own Dismiss acts on that row, not on the selection elsewhere", () => Model.gone.has("gm-quote") && !Model.gone.has("pr-6213") && App.state.selection.has("pr-6213") && App.state.selection.has("pr-6230"));
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await key(p, "/");
  await p.keyboard.type("team:Checkout ");
  await settle(p, 200);
  await key(p, "Enter");
  await expect(p, "↩ after a typed token adds nothing more", () => App.state.search.clauses.length === 1 && !document.getElementById("sx-input").value);
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=reply");
  await settle(p, 500);
  await p.keyboard.type("Friday works for us.");
  await p.keyboard.press("Meta+Enter");
  await settle(p, 400);
  await p.keyboard.press("Meta+z");
  await settle(p, 500);
  await expect(p, "⌘Z on a sent reply opens it again with its words", () => { const t = document.querySelector("#pane .reply textarea"); return !!t && t.value === "Friday works for us." && document.activeElement === t; });
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => App.focusRow(App.state.rows.find((r) => r.thing && r.thing.id === "pr-1302").key));
  await expect(p, "a hand-off button that opens a menu says so, in the words it shows", () => { const b = document.querySelector('#pane [data-move="hand"]'); return !b || (b.getAttribute("aria-label") === "Hand to…" && b.getAttribute("aria-haspopup") === "menu"); });
  await p.close();
}

// ---- Round-seven regressions ----
{
  const c = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const p = await c.newPage();
  p.on("pageerror", (e) => fail(`stacked last row: page error: ${e.message}`));
  await p.goto(page0 + "?theme=whitehaven");
  await p.waitForSelector("html[data-ready]");
  await expect(p, "at 960 to 1031px the bar keeps Inbox | Intake", () => getComputedStyle(document.querySelector(".ib-pill")).display !== "none");
  await key(p, "/");
  await p.keyboard.type("Rotterdam");
  await key(p, "Enter");
  await settle(p, 300);
  await key(p, "Enter");
  await settle(p, 400);
  await key(p, "e");
  await settle(p, 700);
  await expect(p, "under 1032px, when the pane's last row goes, the pane slides away and the empty state has the focus", () => !App.isPaneOpen() && !document.querySelector(".ib-list").inert && !!document.activeElement.closest("#empty"));
  await c.close();
}
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => { Model.live().forEach((t) => { if (Model.asks(t) && !t.held && t.id !== "gm-quote") Model.gone.add(t.id); }); Model.triage().forEach((x) => Model.gone.add(x.id)); App.render({}); App.focusRow("r:gm-quote", { keyboard: true }); });
  await key(p, "e");
  await settle(p, 600);
  await expect(p, "when the last row goes, the focus goes to the empty state, not the page", () => !!document.activeElement.closest("#empty"));
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await key(p, "/");
  await p.keyboard.type("team:Checkout");
  await settle(p, 150);
  await key(p, "Escape");
  await settle(p, 200);
  await expect(p, "leaving the search keeps a filter typed out in full", () => App.state.search.clauses.some((c) => c.key === "team" && c.value === "Checkout"));
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => App.focusRow("r:gm-quote", { keyboard: true }));
  await key(p, "t");
  await settle(p, 400);
  await expect(p, "at 1440 the undo line keeps its buttons' words", () => !document.getElementById("undo").classList.contains("is-tight"));
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=group");
  const before = await p.evaluate(() => [...document.querySelectorAll("#pane .pc li")].map((l) => l.offsetHeight).join());
  await p.hover("#pane .pc li");
  await p.waitForTimeout(150);
  await expect(p, "hovering a link pair moves nothing", (b) => [...document.querySelectorAll("#pane .pc li")].map((l) => l.offsetHeight).join() === b, before);
  await p.close();
}

// ---- Round-eight regressions ----
{
  const p = await open("theme=whitehaven&load=light&scene=new");
  await settle(p, 300);
  const n = await p.evaluate(() => App.state.rows.filter((r) => r.thing || r.type === "group").length);
  await p.evaluate(() => App.focusRow(App.state.rows.find((r) => r.thing || r.type === "group").key, { keyboard: true }));
  for (let i = 0; i < n + 4; i++) { await key(p, "e"); await p.waitForTimeout(700); }
  await expect(p, "an emptied list puts the focus on the empty state's heading", () => document.activeElement.matches("#empty .em-title"));
  await key(p, ".");
  await settle(p, 300);
  await expect(p, "the list's keys work from the empty state", () => App.state.pending.length === 0);
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=empty");
  await settle(p, 300);
  await p.evaluate(() => App.emptyHeading().focus());
  await key(p, "F6");
  await key(p, "F6");
  await key(p, "F6");
  await expect(p, "F6 goes round an empty list and comes back to it", () => document.activeElement.matches("#empty .em-title"));
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await key(p, "/");
  await p.keyboard.type("team:Check");
  await settle(p, 150);
  await key(p, "Escape");
  await settle(p, 200);
  await expect(p, "leaving the search takes what ↩ would: the highlighted value", () => App.state.search.clauses.some((c) => c.key === "team" && c.value === "Checkout"));
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => { Model.live().forEach((t) => { if (Model.asks(t) && !t.held && t.id !== "pr-6213") Model.gone.add(t.id); }); Model.triage().forEach((x) => Model.gone.add(x.id)); App.render({}); App.focusRow("r:pr-6213", { keyboard: true }); });
  await key(p, "n");
  await settle(p, 700);
  await p.keyboard.press("Meta+Enter");
  await settle(p, 900);
  await expect(p, "the thread starts on the last row", () => !App.state.rows.some((r) => r.key === "r:pr-6213"));
  await key(p, "Escape");
  await settle(p, 600);
  await expect(p, "after a thread takes the last row, the focus goes to the empty state, not the page", () => !!document.activeElement.closest("#empty"));
  await p.close();
}

// ---- Round-nine regressions ----
{
  const p = await open("theme=whitehaven");
  await p.evaluate(() => App.focusRow("r:pr-6230", { keyboard: true }));
  await key(p, "x");
  await key(p, "h");
  await settle(p, 300);
  if (await p.evaluate(() => !document.getElementById("handmenu").hidden)) await key(p, "1");
  await settle(p, 200);
  await expect(p, "a handed thing leaves the selection at once", () => !App.state.selection.has("pr-6230"));
  await settle(p, 1200);
  await key(p, "e");
  await settle(p, 300);
  await expect(p, "so the next E never acts on the handed thing", () => !Model.gone.has("pr-6230"));
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=triage");
  await p.focus('[data-key="t:prop-kp"]');
  await key(p, "n");
  await settle(p, 700);
  await p.keyboard.press("Meta+Enter");
  await settle(p, 500);
  // With no project to go on, ⌘↩ asks for one first: ↩ picks the offered one, and ⌘↩ starts.
  if (await p.evaluate(() => !document.getElementById("td-pop").hidden)) { await key(p, "Enter"); await settle(p, 300); await p.keyboard.press("Meta+Enter"); }
  await settle(p, 900);
  const started = await p.evaluate(() => Model.gone.has("prop-kp"));
  await key(p, "Escape");
  await settle(p, 500);
  await p.keyboard.press("Meta+z");
  await settle(p, 500);
  if (started) await expect(p, "⌘Z on it brings the Proposal back, current", () => !Model.gone.has("prop-kp") && App.state.focus === "t:prop-kp");
  else fail("the thread from a Proposal did not start, so its undo was not checked");
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=empty");
  await settle(p, 300);
  await p.evaluate(() => App.emptyHeading().focus());
  await key(p, "x");
  await p.evaluate(() => Live.arrive(World.arrivals()));
  await settle(p, 300);
  await expect(p, "the empty state keeps its focus when things arrive", () => document.activeElement.matches("#empty .em-title"));
  await p.close();
}
{
  const p = await open("theme=whitehaven");
  await key(p, "8");
  await p.evaluate(() => Live.arrive(World.arrivals()));
  await settle(p, 300);
  await expect(p, "the N new pill counts only what arrived for the list on screen", () => !document.querySelector("[data-newbar]"));
  await p.close();
}

// ---- Rogier's questions, 2026-11-12: hand-off by name, asks a workflow leaves, the group's chevron ----
{
  const p = await open("theme=whitehaven&scene=hand");
  await settle(p, 900);
  await expect(p, "the hand-off menu puts the workflows that end an ask first, each naming whose asks it ends and leaves", () => { const rows = [...document.querySelectorAll("#handmenu [data-hand-row] small")].map((s) => s.textContent); return /^Ends Mei’s review request\. Leaves Omar’s mention with you\.$/.test(rows[0]) && /^Ends none/.test(rows[rows.length - 1]); });
  await key(p, "1");
  await settle(p, 1600);
  await expect(p, "an ask the workflow leaves keeps the thing in Someone waits on me, saying who has the rest", () => { const r = App.state.rows.find((x) => x.thing && x.thing.id === "pr-6244"); return !!r && /Omar mentioned you · Review PR has the rest/.test(document.querySelector('[data-key="' + r.key + '"] .row-why').textContent); });
  await expect(p, "and the undo line says so", () => /Omar’s mention stays with you/.test(document.querySelector("#undo .undo-text").textContent));
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=hand-many");
  await settle(p, 900);
  await expect(p, "with six or more workflows the menu has a find field with the focus", () => document.activeElement && document.activeElement.id === "hand-find");
  await p.keyboard.type("migr");
  await settle(p, 150);
  await expect(p, "the find field keeps only the workflows whose name or work holds what is typed", () => [...document.querySelectorAll("#handmenu [data-hand-row]")].filter((r) => !r.hidden).map((r) => r.querySelector("b").textContent).join() === "Check the migration");
  await key(p, "Enter");
  await settle(p, 400);
  await expect(p, "↩ hands to the one found", () => Model.byId("pr-6244").held && Model.byId("pr-6244").held.by === "Check the migration");
  await p.close();
}
for (const w of [640, 420, 360]) {
  const p = await open("theme=whitehaven&scene=sentry");
  await p.evaluate((w) => App.setPaneWidth(w), w);
  await settle(p, 200);
  await expect(p, `at a ${w}px pane the hand-off shows the workflow's whole name`, () => { const t = document.querySelector('#pane [data-move="hand"] .pn-move-t'); return !!t && t.getClientRects().length > 0 && t.textContent === "Triage errors" && t.scrollWidth <= t.clientWidth + 1; });
  await p.close();
}
{
  const p = await open("theme=whitehaven&scene=group");
  await settle(p, 300);
  const g = await p.evaluate(() => { const r = document.querySelector(".row--group").getBoundingClientRect(); return { x: r.left + 20, y: r.top }; });
  const hit = (dy) => p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e.closest("[data-tick]") ? "tick" : e.closest("[data-fold-group]") ? "fold" : "row"; }, [g.x, g.y + dy]);
  if ((await hit(17)) !== "tick") fail("a group's first line selects it");
  if ((await hit(38)) !== "fold") fail("a group's second line holds the chevron, apart from the tick");
  await p.mouse.click(g.x, g.y + 38);
  await settle(p, 500);
  await expect(p, "a click on a group's chevron unfolds it", () => document.querySelector(".row--group").classList.contains("is-open") && App.state.selection.size === 0);
  await p.close();
}

// ---- A dismissed thing comes back for a new ask, and only for one ----
{
  const p = await open("theme=whitehaven&scene=returned");
  await settle(p, 300);
  await expect(p, "a new ask brings a dismissed thing back, and its row says it was dismissed", () => { const el = document.querySelector('[data-key="r:pr-6230"]'); return !!el && /Kwame mentioned you.*dismissed 1d ago/.test(el.querySelector(".row-why").textContent); });
  await expect(p, "its pane says what brought it back", () => /Dismissed 1 day ago, back for Kwame’s mention/.test(document.querySelector("#pane .pn-meta").textContent));
  await p.evaluate(() => { const t = Model.byId("pr-6230"); t.signals = t.signals.filter((s) => s.id !== "s12b"); App.render({}); });
  await expect(p, "an ask that was open when it was dismissed does not bring it back", () => !App.state.rows.some((r) => r.thing && r.thing.id === "pr-6230"));
  await p.close();
}

await browser.close();
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log("All checks passed.");

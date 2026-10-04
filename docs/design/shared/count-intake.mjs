// PROTOTYPE helper: counts the buttons, words and numbers on a page, in total and in view, so the
// Intake directions can be compared by how much they ask of the reader.
// Usage: node count-intake.mjs <file-or-url> [w 1440] [h 900]
// Prints one JSON line: buttonsTotal, buttonsInView, words, wordsView, nums, numsView.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("/Users/rogier/.npm-global/lib/node_modules/playwright");
const target = process.argv[2];
const url = /^[a-z]+:/.test(target) ? target : pathToFileURL(resolve(target)).href;
const [w, h] = [Number(process.argv[3] || 1440), Number(process.argv[4] || 900)];
const b = await chromium.launch({ channel: "chromium" });
const p = await b.newPage({ viewport: { width: w, height: h } });
await p.goto(url); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
const r = await p.evaluate(([W, H]) => {
  const main = document.querySelector("main, .phone, .web") || document.body;
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0 && r.top < H && r.bottom > 0 && r.left < W && r.right > 0 && getComputedStyle(el).visibility !== "hidden")) return false;
    // Clipped by a scrolling ancestor (a stage, the phone body) means not in view.
    for (let a = el.parentElement; a; a = a.parentElement) {
      const o = getComputedStyle(a).overflowY;
      if (o === "auto" || o === "scroll" || o === "hidden") { const c = a.getBoundingClientRect(); if (r.top >= c.bottom || r.bottom <= c.top) return false; }
    }
    return true;
  };
  const all = (sel) => [...main.querySelectorAll(sel)];
  const btns = all("button, .btn, a.btn, .m-ans").filter((e) => !e.closest(".side, .webbar, .tabbar")).filter((v, i, a) => !a.some((o) => o !== v && o.contains(v)));
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  let words = 0, wordsView = 0, nums = 0, numsView = 0, n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement; if (!el || el.closest(".side, .webbar, .tabbar, .status, script, style")) continue;
    const cs = getComputedStyle(el); if (cs.display === "none") continue;
    let hidden = false; for (let e = el; e; e = e.parentElement) if (getComputedStyle(e).display === "none") { hidden = true; break; }
    if (hidden) continue;
    const t = n.textContent.trim(); if (!t) continue;
    const wc = t.split(/\s+/).length; const nc = (t.match(/[-+€]?\d[\d.,k%]*/g) || []).length;
    words += wc; nums += nc;
    if (inView(el)) { wordsView += wc; numsView += nc; }
  }
  return { buttonsTotal: btns.length, buttonsInView: btns.filter(inView).length, words, wordsView, nums, numsView };
}, [w, h]);
console.log(JSON.stringify(r));
await b.close();

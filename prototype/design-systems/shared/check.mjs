// PROTOTYPE - checks one design folder against the brief's mechanical rules and shoots every page.
//
//   node shared/check.mjs 01-docket [--themes light,dark] [--out /tmp/review] [--no-shots]
//
// Reports: missing screen files, banned words and dashes in visible text, requests that leave the
// machine, pages that scroll or overflow their viewport, console errors, and the theme count.
// Screenshots land in <out>/<design>/<kind>-<page>-<theme>.png; the book in 1600px slices,
// <out>/<design>/book-<theme>-01.png and on.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/rogier/.npm-global/lib/node_modules/playwright");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const id = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const themes = opt("themes", "light,dark").split(",");
const out = join(opt("out", "/tmp/review"), id);
const shots = !args.includes("--no-shots");
const base = opt("base", "http://localhost:4870");

const SCREENS = {
  desktop: [
    "session-empty", "session-active", "intake", "assistant", "settings-appearance",
    "settings-assistants", "settings-connections", "office", "glance",
  ],
  web: ["session-empty", "session-active", "intake", "decision", "assistant", "settings-providers"],
  mobile: ["intake", "decision", "session-empty", "session-active", "assistant", "settings", "lock"],
};
const SIZE = { desktop: [1440, 900], web: [1280, 800], mobile: [390, 844] };
const BANNED = [
  [/[–—]/, "en/em dash"],
  [/\bhydra\b/i, "old name Hydra"],
  [/agentick/i, "retired name"],
  [/\binbox\b/i, "'inbox' (use Intake)"],
  [/\bdashboard\b/i, "'dashboard'"],
  [/\bpersona\b/i, "'persona' (use Assistant)"],
  [/lorem ipsum/i, "lorem ipsum"],
];

// Frames in a book load lazily and a screenshot never scrolls, so load them all before shooting.
async function loadAllFrames(page) {
  const count = await page.evaluate(() => {
    const frames = [...document.querySelectorAll("iframe")];
    frames.forEach((f) => (f.loading = "eager"));
    return frames.length;
  });
  if (count) await page.waitForLoadState("load");
  if (count) await page.waitForTimeout(800);
}

const problems = [];
const note = (where, what) => problems.push(`${where}: ${what}`);

const dir = join(root, id);
if (!existsSync(dir)) {
  console.error(`No folder ${dir}`);
  process.exit(1);
}
for (const f of ["index.html", "tokens.css", "system.css"]) {
  if (!existsSync(join(dir, f))) note(f, "missing");
}
if (existsSync(join(dir, "tokens.css"))) {
  const tokens = readFileSync(join(dir, "tokens.css"), "utf8");
  const names = new Set([...tokens.matchAll(/data-theme\s*=\s*["']?([\w-]+)/g)].map((m) => m[1]));
  if (!names.has("light") || !names.has("dark")) note("tokens.css", "no light/dark alias");
  const real = [...names].filter((n) => n !== "light" && n !== "dark");
  if (real.length < 5) note("tokens.css", `only ${real.length} themes besides the light/dark aliases: ${real.join(", ")}`);
  console.log(`themes: ${real.join(", ")} (plus the light/dark aliases)`);
}

const pages = [["book", "index", `${id}/index.html`]];
for (const [kind, list] of Object.entries(SCREENS)) {
  for (const name of list) {
    const rel = `${id}/${kind}/${name}.html`;
    if (!existsSync(join(root, rel))) note(rel, "missing");
    else pages.push([kind, name, rel]);
  }
}

if (shots) mkdirSync(out, { recursive: true });
// The "chromium" channel is the new headless mode, which draws backdrop-filter blur; the default
// headless shell does not, and glass would look like plain see-through panels.
const browser = await chromium.launch({ channel: "chromium" });
for (const [kind, name, rel] of pages) {
  const [w, h] = SIZE[kind] ?? [1440, 900];
  const variants = themes.map((t) => [t, ""]);
  if (name === "session-active") variants.push([themes[themes.length - 1], "scrolled"]);
  for (const [theme, state] of variants) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    // New headless mode asks for /favicon.ico, which no design has; its 404 is not a page error.
    await page.route("**/favicon.ico", (r) => r.fulfill({ status: 204 }));
    const errors = [];
    const external = new Set();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith(base) && !u.startsWith("file:") && !u.startsWith("data:") && !u.startsWith("blob:") && !u.startsWith("about:")) external.add(u);
    });
    const q = new URLSearchParams({ theme });
    if (state) q.set("state", state);
    await page.goto(`${base}/${rel}?${q}`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    if (kind === "book") await loadAllFrames(page);
    await page.waitForTimeout(350);
    const where = `${rel}?${q}`;
    errors.forEach((e) => note(where, `error: ${e}`));
    external.forEach((u) => note(where, `external request: ${u}`));
    if (theme === themes[0] && !state) {
      const text = await page.evaluate(() => document.body.innerText);
      for (const [re, label] of BANNED) {
        const m = text.match(re);
        if (m) {
          const at = text.indexOf(m[0]);
          note(where, `${label}: "...${text.slice(Math.max(0, at - 30), at + 30).replace(/\s+/g, " ")}..."`);
        }
      }
    }
    if (kind !== "book") {
      const size = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.scrollHeight,
      ]);
      if (size[0] > w + 1 || size[1] > h + 1) note(where, `page scrolls: ${size[0]}x${size[1]} in ${w}x${h}`);
    }
    if (shots && kind === "book") {
      // One full-page shot of a long book can start mid-page, so the book is shot in slices.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let i = 0; i * 1600 < height; i++) {
        const clip = { x: 0, y: i * 1600, width: w, height: Math.min(1600, height - i * 1600) };
        const file = join(out, `book-${theme}-${String(i + 1).padStart(2, "0")}.png`);
        await page.screenshot({ path: file, fullPage: true, clip });
      }
    } else if (shots) {
      const file = join(out, `${kind}-${name}-${theme}${state ? "-" + state : ""}.png`);
      await page.screenshot({ path: file });
    }
    await page.close();
  }
}
await browser.close();

console.log(problems.length ? problems.join("\n") : "no problems found");
if (shots) console.log(`shots: ${out}`);

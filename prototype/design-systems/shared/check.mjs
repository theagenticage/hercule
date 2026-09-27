// PROTOTYPE - checks one design folder against the brief's mechanical rules and shoots every page.
//
//   node shared/check.mjs 01-docket [--themes light,dark] [--out /tmp/review] [--no-shots]
//
// Reports: missing screen files, banned words and dashes in visible text, requests that leave the
// machine, pages that scroll or overflow their viewport, console errors, and the theme count.
// Screenshots land in <out>/<design>/<kind>-<page>-<theme>.png.
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
  if (names.size < 7) note("tokens.css", `only ${names.size} theme names incl. aliases: ${[...names].join(", ")}`);
  console.log(`themes: ${[...names].join(", ")}`);
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
const browser = await chromium.launch();
for (const [kind, name, rel] of pages) {
  const [w, h] = SIZE[kind] ?? [1440, 900];
  const variants = themes.map((t) => [t, ""]);
  if (name === "session-active") variants.push([themes[themes.length - 1], "scrolled"]);
  for (const [theme, state] of variants) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
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
    if (shots) {
      const file = join(out, `${kind}-${name}-${theme}${state ? "-" + state : ""}.png`);
      await page.screenshot({ path: file, fullPage: kind === "book" });
    }
    await page.close();
  }
}
await browser.close();

console.log(problems.length ? problems.join("\n") : "no problems found");
if (shots) console.log(`shots: ${out}`);

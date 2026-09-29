#!/usr/bin/env bun
/**
 * Checks the size of an app's first paint against its budget: the web app's,
 * or the desktop renderer's.
 *
 * The budget is on the JavaScript a browser must have before it can show
 * anything: the entry module plus everything `index.html` preloads beside it.
 * Every route is a chunk of its own and is fetched when it is first visited, so
 * a screen added later costs nothing here. That is why the check measures the
 * entry rather than the whole directory.
 *
 * CSS and fonts are outside the budget. They are one stylesheet and a fixed set
 * of font subsets, and application code does not change their size.
 *
 * The same check rejects a development build. React ships two builds behind an
 * export condition, a stray `NODE_ENV` selects the development one, and it is
 * both slower and far larger - a difference the budget alone might absorb
 * rather than report.
 *
 * Usage: `bun run scripts/check-bundle-budget.ts [<build folder>]`. The build
 * folder is the one that holds `index.html`, `apps/web/dist` by default; the
 * desktop renderer's is `apps/desktop/out/renderer`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The largest the first paint may be, gzipped. */
const BUDGET_BYTES = 250 * 1024;

const dist = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../apps/web/dist", import.meta.url)),
);

if (!existsSync(dist)) {
  console.error(
    `check-bundle-budget: there is no build in ${dist}. Build the app first; for the web app, ` +
      "run `pnpm --filter @hercule/web build`.",
  );
  process.exit(1);
}

const html = readFileSync(join(dist, "index.html"), "utf8");

/**
 * Converts a `src` or `href` in `index.html` to a path inside the build
 * folder. `index.html` sits at the folder's root, so an absolute
 * `/assets/a.js`, which a server or the desktop app's `app://hercule/` scheme
 * serves from that root, and a relative `./assets/a.js` both name
 * `assets/a.js`.
 */
const resolveBuildPath = (reference: string): string => reference.replace(/^\.?\//, "");

/** The files the page fetches before it can render: the entry module and its preloads. */
const firstPaint = new Set(
  [
    ...html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"/g),
    ...html.matchAll(/<link[^>]*\srel="modulepreload"[^>]*\shref="([^"]+\.js)"/g),
  ].map((match) => resolveBuildPath(match[1]!)),
);

if (firstPaint.size === 0) {
  console.error("check-bundle-budget: index.html has no script; the build produced no entry.");
  process.exit(1);
}

const readBuildFile = (buildPath: string) => readFileSync(join(dist, buildPath));

/** Strings that only React's development build contains. */
const DEVELOPMENT_MARKERS = ["jsx-dev-runtime", "Invalid hook call"];

const shipped = [...firstPaint];
for (const marker of DEVELOPMENT_MARKERS) {
  const carrier = shipped.find((buildPath) => readBuildFile(buildPath).includes(marker));
  if (carrier !== undefined) {
    console.error(
      `check-bundle-budget: ${carrier} contains "${marker}", so this is a development build. ` +
        `Build with NODE_ENV=production, or find what unset it.`,
    );
    process.exit(1);
  }
}

const chunks = readdirSync(join(dist, "assets"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => `assets/${name}`)
  .map((buildPath) => ({
    buildPath,
    bytes: Bun.gzipSync(readBuildFile(buildPath)).byteLength,
    first: firstPaint.has(buildPath),
  }))
  .sort((a, b) => b.bytes - a.bytes);

const formatKilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`;

const width = Math.max(...chunks.map((chunk) => chunk.buildPath.length));
console.log(`${"chunk".padEnd(width)}  gzipped   first paint`);
for (const chunk of chunks) {
  console.log(
    `${chunk.buildPath.padEnd(width)}  ${formatKilobytes(chunk.bytes).padStart(8)}  ${chunk.first ? "yes" : ""}`,
  );
}

// Summed over what the page fetches, not over what the directory holds: a
// first-paint chunk emitted outside `assets/` still counts.
const total = shipped.reduce(
  (sum, buildPath) => sum + Bun.gzipSync(readBuildFile(buildPath)).byteLength,
  0,
);
console.log(
  `\ncheck-bundle-budget: first paint is ${formatKilobytes(total)} gzipped across ${String(shipped.length)} ` +
    `chunks, of ${String(chunks.length)} built; the budget is ${formatKilobytes(BUDGET_BYTES)}.`,
);

if (total > BUDGET_BYTES) {
  console.error(
    `check-bundle-budget: over budget by ${formatKilobytes(total - BUDGET_BYTES)}. Move what the first paint ` +
      `does not need behind a route, or raise the budget deliberately and say why in spec 14 ` +
      `(the web app) or spec 17 (the desktop app).`,
  );
  process.exit(1);
}

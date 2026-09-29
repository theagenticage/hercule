#!/usr/bin/env bun
/**
 * Checks a build against its size budget. It checks one of two things:
 *
 * - An app's first paint: the web app's, or the desktop renderer's.
 * - The startup file of the desktop app's main process.
 *
 * The first-paint budget is on the JavaScript a browser must have before it
 * can show anything: the entry module plus everything `index.html` preloads
 * beside it. Every route is a chunk of its own and is fetched when it is first
 * visited, so a screen added later costs nothing here. That is why the check
 * measures the entry rather than the whole directory.
 *
 * CSS and fonts are outside the first-paint budget. They are one stylesheet and
 * a fixed set of font subsets, and application code does not change their size.
 *
 * The same check rejects a development build. React ships two builds behind an
 * export condition, a stray `NODE_ENV` selects the development one, and it is
 * both slower and far larger - a difference the budget alone might absorb
 * rather than report.
 *
 * Main's startup budget is on the one file Electron reads and compiles before
 * the app is ready. Main imports what the first window does not need with a
 * dynamic `import()`, which the build writes to a chunk of its own beside the
 * startup file, so those chunks cost nothing here. The budget counts minified
 * bytes rather than gzipped ones, because main loads from disk and what it
 * pays for is parsing the file.
 *
 * Usage:
 *
 * - `bun run scripts/check-bundle-budget.ts [<build folder>]` checks a first
 *   paint. The build folder is the one that holds `index.html`,
 *   `apps/web/dist` by default; the desktop renderer's is
 *   `apps/desktop/out/renderer`.
 * - `bun run scripts/check-bundle-budget.ts --main-startup <file>` checks main's
 *   startup file, `apps/desktop/out/main/index.js`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The largest the first paint may be, gzipped. */
const FIRST_PAINT_BUDGET_BYTES = 250 * 1024;

/** The largest main's startup file may be, minified (spec 17 §Performance, Budgets). */
const MAIN_STARTUP_BUDGET_BYTES = 160 * 1024;

const formatKilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`;

/**
 * Checks the size of the desktop main process's startup file against its
 * budget and prints the result. Exits the process with code 1 when the file
 * does not exist or is over the budget.
 */
const checkMainStartup = (file: string): void => {
  const shown = relative(root, file);
  if (!existsSync(file)) {
    console.error(
      `check-bundle-budget: there is no startup file at ${shown}. Build the desktop app first: ` +
        "run `pnpm --filter @hercule/desktop build`.",
    );
    process.exit(1);
  }

  const bytes = statSync(file).size;
  console.log(
    `check-bundle-budget: main's startup file ${shown} is ${formatKilobytes(bytes)} minified; ` +
      `the budget is ${formatKilobytes(MAIN_STARTUP_BUDGET_BYTES)}.`,
  );
  if (bytes > MAIN_STARTUP_BUDGET_BYTES) {
    console.error(
      `check-bundle-budget: ${shown} is ${formatKilobytes(bytes)} minified, over main's startup ` +
        `budget of ${formatKilobytes(MAIN_STARTUP_BUDGET_BYTES)} by ` +
        `${formatKilobytes(bytes - MAIN_STARTUP_BUDGET_BYTES)}. Spec 17 §Performance owns the ` +
        `number, in the "Main's startup" row of its budgets. Import what the first window does ` +
        "not need with a dynamic `import()` where it is first used, or raise the budget " +
        "deliberately in spec 17 and say why.",
    );
    process.exit(1);
  }
};

/**
 * Checks the size of an app's first paint against its budget and prints a
 * table of the build's chunks. Exits the process with code 1 when the build
 * folder does not exist, holds no entry, is a development build, or is over
 * the budget.
 */
const checkFirstPaint = (dist: string): void => {
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
   * `/assets/a.js`, which a server or the desktop app's `app://hercule/`
   * scheme serves from that root, and a relative `./assets/a.js` both name
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

  // Every chunk in `assets/`, and each first-paint file outside it, such as a
  // pre-paint script served from the public folder, so that the table lists
  // every file the total counts.
  const builtPaths = new Set([
    ...readdirSync(join(dist, "assets"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => `assets/${name}`),
    ...shipped,
  ]);
  const chunks = [...builtPaths]
    .map((buildPath) => ({
      buildPath,
      bytes: Bun.gzipSync(readBuildFile(buildPath)).byteLength,
      first: firstPaint.has(buildPath),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const width = Math.max(...chunks.map((chunk) => chunk.buildPath.length));
  console.log(`${"chunk".padEnd(width)}  gzipped   first paint`);
  for (const chunk of chunks) {
    console.log(
      `${chunk.buildPath.padEnd(width)}  ${formatKilobytes(chunk.bytes).padStart(8)}  ${chunk.first ? "yes" : ""}`,
    );
  }

  const total = chunks.filter((chunk) => chunk.first).reduce((sum, chunk) => sum + chunk.bytes, 0);
  console.log(
    `\ncheck-bundle-budget: first paint is ${formatKilobytes(total)} gzipped across ${String(shipped.length)} ` +
      `chunks, of ${String(chunks.length)} built; the budget is ${formatKilobytes(FIRST_PAINT_BUDGET_BYTES)}.`,
  );

  if (total > FIRST_PAINT_BUDGET_BYTES) {
    console.error(
      `check-bundle-budget: over budget by ${formatKilobytes(total - FIRST_PAINT_BUDGET_BYTES)}. Move what the first paint ` +
        `does not need behind a route, or raise the budget deliberately and say why in spec 14 ` +
        `(the web app) or spec 17 (the desktop app).`,
    );
    process.exit(1);
  }
};

const [argument, mainStartup] = process.argv.slice(2);
if (argument === "--main-startup") {
  if (mainStartup === undefined) {
    console.error(
      "check-bundle-budget: --main-startup needs the path of main's startup file, such as " +
        "apps/desktop/out/main/index.js.",
    );
    process.exit(1);
  }
  checkMainStartup(resolve(mainStartup));
} else {
  checkFirstPaint(resolve(argument ?? join(root, "apps/web/dist")));
}

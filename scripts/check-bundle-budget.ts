#!/usr/bin/env bun
/**
 * Checks a build against its size budget. It checks one of two things:
 *
 * - An app's first screen: the web app's, or the desktop renderer's.
 * - The startup file of the desktop app's main process.
 *
 * The first-screen budget is on the JavaScript a browser must have before it
 * can show the first screen. It always counts the first paint: the entry
 * module plus everything `index.html` preloads beside it. The router splits
 * most routes into chunks of their own, fetched when a route is first
 * visited, so a screen added later costs nothing here.
 *
 * A route the first screen renders can be split too, and its chunks would then
 * escape the count. Each `--route <file>` names such a route by its source
 * file. The check then also counts every chunk the router split that file
 * into, and every chunk those import. It finds them in the manifest Vite
 * writes with `build.manifest: true` (`.vite/manifest.json`), whose keys are
 * the source paths the chunks came from. The chunks a route loads only on an
 * error or a missing page are counted as well, so the count errs high.
 *
 * CSS and fonts are outside the first-screen budget. They are one stylesheet
 * and a fixed set of font subsets, and application code does not change their
 * size.
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
 * - `bun run scripts/check-bundle-budget.ts [<build folder>] [--route <file>]...`
 *   checks a first screen. The build folder is the one that holds
 *   `index.html`, `apps/web/dist` by default; the desktop renderer's is
 *   `apps/desktop/out/renderer`. Each `--route` is a route file the first
 *   screen renders, such as
 *   `apps/desktop/src/renderer/routes/_connected/_shell.tsx`.
 * - `bun run scripts/check-bundle-budget.ts --main-startup <file>` checks main's
 *   startup file, `apps/desktop/out/main/index.js`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The largest the first screen's JavaScript may be, gzipped. */
const FIRST_SCREEN_BUDGET_BYTES = 250 * 1024;

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

/** One chunk in Vite's build manifest, with only the fields the check reads. */
interface ManifestChunk {
  readonly file: string;
  readonly imports?: ReadonlyArray<string>;
}

/**
 * Returns the build paths of the chunks the router split the given route files
 * into, and of every chunk those import, read from the build's Vite manifest.
 * A route that was not split lives in the entry chunk and adds nothing. Exits
 * the process with code 1 when a route file does not exist or the build has
 * no manifest.
 */
const findRouteChunks = (dist: string, routeFiles: ReadonlyArray<string>): Set<string> => {
  const routeChunks = new Set<string>();
  if (routeFiles.length === 0) return routeChunks;

  // A misspelled route would otherwise count nothing and pass quietly.
  const missing = routeFiles.find((file) => !existsSync(file));
  if (missing !== undefined) {
    console.error(`check-bundle-budget: there is no route file at ${relative(root, missing)}.`);
    process.exit(1);
  }

  const manifestPath = join(dist, ".vite/manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(
      `check-bundle-budget: the build in ${dist} has no Vite manifest, so the chunks of the ` +
        "routes named with --route cannot be found. Set `build.manifest: true` in the app's " +
        "Vite config and build again.",
    );
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestChunk>;

  const addChunk = (key: string): void => {
    const chunk = manifest[key]!;
    if (routeChunks.has(chunk.file)) return;
    routeChunks.add(chunk.file);
    for (const imported of chunk.imports ?? []) addChunk(imported);
  };
  for (const key of Object.keys(manifest)) {
    // A key is the path of the chunk's source file relative to Vite's root,
    // and the key of a split route ends in a query, such as
    // `routes/a.tsx?tsr-split=component`.
    const source = key.split("?")[0]!;
    if (routeFiles.some((file) => file.endsWith(`/${source}`))) addChunk(key);
  }
  return routeChunks;
};

/**
 * Checks the size of an app's first screen against its budget and prints a
 * table of the build's chunks. The first screen is the first paint plus the
 * chunks of the given route files (see the top of this file). Exits the
 * process with code 1 when the build folder does not exist, holds no entry,
 * is a development build, or is over the budget.
 */
const checkFirstScreen = (dist: string, routeFiles: ReadonlyArray<string>): void => {
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

  const routeChunks = findRouteChunks(dist, routeFiles);
  const counted = new Set([...firstPaint, ...routeChunks]);

  const readBuildFile = (buildPath: string) => readFileSync(join(dist, buildPath));

  /** Strings that only React's development build contains. */
  const DEVELOPMENT_MARKERS = ["jsx-dev-runtime", "Invalid hook call"];

  for (const marker of DEVELOPMENT_MARKERS) {
    const carrier = [...counted].find((buildPath) => readBuildFile(buildPath).includes(marker));
    if (carrier !== undefined) {
      console.error(
        `check-bundle-budget: ${carrier} contains "${marker}", so this is a development build. ` +
          `Build with NODE_ENV=production, or find what unset it.`,
      );
      process.exit(1);
    }
  }

  // Every chunk in `assets/`, and each counted file outside it, such as a
  // pre-paint script served from the public folder, so that the table lists
  // every file the total counts.
  const builtPaths = new Set([
    ...readdirSync(join(dist, "assets"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => `assets/${name}`),
    ...counted,
  ]);
  const chunks = [...builtPaths]
    .map((buildPath) => ({
      buildPath,
      bytes: Bun.gzipSync(readBuildFile(buildPath)).byteLength,
      countedAs: firstPaint.has(buildPath)
        ? "first paint"
        : routeChunks.has(buildPath)
          ? "route"
          : "",
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const width = Math.max(...chunks.map((chunk) => chunk.buildPath.length));
  console.log(`${"chunk".padEnd(width)}  gzipped   counted as`);
  for (const chunk of chunks) {
    console.log(
      `${chunk.buildPath.padEnd(width)}  ${formatKilobytes(chunk.bytes).padStart(8)}  ${chunk.countedAs}`,
    );
  }

  const total = chunks
    .filter((chunk) => counted.has(chunk.buildPath))
    .reduce((sum, chunk) => sum + chunk.bytes, 0);
  console.log(
    `\ncheck-bundle-budget: the first screen is ${formatKilobytes(total)} gzipped across ${String(counted.size)} ` +
      `chunks, of ${String(chunks.length)} built; the budget is ${formatKilobytes(FIRST_SCREEN_BUDGET_BYTES)}.`,
  );

  if (total > FIRST_SCREEN_BUDGET_BYTES) {
    console.error(
      `check-bundle-budget: over budget by ${formatKilobytes(total - FIRST_SCREEN_BUDGET_BYTES)}. Move what the first ` +
        `screen does not need behind a route it does not render, or raise the budget deliberately and say why ` +
        `in spec 14 (the web app) or spec 17 (the desktop app).`,
    );
    process.exit(1);
  }
};

/**
 * Parses the command line into its options and its positional build folder.
 * Exits the process with code 1, naming the problem, when an option is unknown
 * or has no value.
 */
const parseArguments = () => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        "main-startup": { type: "string" },
        route: { type: "string", multiple: true },
      },
      allowPositionals: true,
    });
  } catch (error) {
    console.error(`check-bundle-budget: ${(error as Error).message}`);
    process.exit(1);
  }
};

const { values, positionals } = parseArguments();
if (values["main-startup"] !== undefined) {
  checkMainStartup(resolve(values["main-startup"]));
} else {
  checkFirstScreen(
    resolve(positionals[0] ?? join(root, "apps/web/dist")),
    (values.route ?? []).map((file) => resolve(file)),
  );
}

#!/usr/bin/env bun
/**
 * Compares the desktop app's bundle bytes before and after a change, and
 * prints the result as markdown (ADR 0037 asks for both numbers).
 *
 * "Before" is the merge-base of HEAD and the base branch, built in a
 * throwaway git worktree. "After" is the working tree as it is, uncommitted
 * changes included. Each side runs only the desktop bundle build,
 * `pnpm --filter @hercule/desktop build` (Vite for the renderer, main and
 * preload), with no packaging and no web build. The "after" build writes to
 * this checkout's `apps/desktop/out`, replacing any build already there, such
 * as the packaged one `pnpm test:desktop` reads. The worktree is removed when
 * the script ends, also on failure or Ctrl-C.
 *
 * Two tables come out:
 *
 * - Per layer (main, preload, renderer): total bytes and gzip bytes, source
 *   maps and manifests excluded. Plus the two numbers the budget check
 *   judges, computed with its own functions: the renderer's first screen
 *   (gzipped) and main's startup files (minified).
 * - Per chunk with the content hash stripped from its name: only the rows
 *   that changed. Names that collide after stripping are summed into one row
 *   and marked.
 *
 * Usage: `bun run scripts/compare-bundle.ts [--base <branch>]`. The base
 * defaults to `origin/main`, the branch every pull request targets. The local
 * `main` of a worktree is often far behind it. Pass `--base main` to use the
 * local branch anyway.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findFirstScreenFiles, findStartupFiles, measureGzipBytes } from "./check-bundle-budget";

const root = fileURLToPath(new URL("..", import.meta.url));

const LAYERS = ["main", "preload", "renderer"] as const;
type Layer = (typeof LAYERS)[number];

/** One built file: its path inside the layer's output folder, and its sizes. */
export interface BuiltFile {
  readonly path: string;
  readonly bytes: number;
  readonly gzipBytes: number;
}

/** What one build measures: every layer's files, and the two budget numbers. */
export interface BuildSizes {
  readonly files: Readonly<Record<Layer, ReadonlyArray<BuiltFile>>>;
  /** The renderer's first screen, gzipped, as the budget check counts it. */
  readonly firstScreenGzipBytes: number;
  /** Main's startup file and the chunks it imports statically, minified, as the budget check counts it. */
  readonly mainStartupBytes: number;
}

/** One line of a markdown table: a label and the same measure on both sides. */
interface MeasureRow {
  readonly label: string;
  readonly before: number;
  readonly after: number;
}

/**
 * Returns `path` without the content hash Vite puts in a built asset's name:
 * `renderer/assets/inbox-B3v2P7XR.js` becomes `renderer/assets/inbox.js`.
 * Vite's hash is eight characters from `A-Za-z0-9_-`, after a hyphen and
 * before the extension. Only files in an `assets` folder are hashed; the
 * `index.js` of main and preload are not, so they are returned unchanged.
 */
export const stripChunkHash = (path: string): string =>
  /(^|\/)assets\//.test(path) ? path.replace(/-[\w-]{8}(\.[a-z0-9]+)$/i, "$1") : path;

/** One row of the per-chunk table. `fileCount` above 1 means colliding names were summed. */
interface ChunkRow {
  readonly name: string;
  readonly before: number;
  readonly after: number;
  readonly status: "added" | "deleted" | "changed";
  /** The most files of this name on either side. */
  readonly fileCount: number;
}

/**
 * Returns the chunks whose minified size differs between the two builds, sorted
 * by the size of the change, largest first. Raw bytes are compared, not gzip:
 * a content hash has a fixed length, so a chunk's raw size changes only when
 * its code changes, while its gzip size also moves when an import's hash
 * changes. Files are matched by name without the
 * content hash. When several files share a name after stripping, they are
 * summed into one row and `fileCount` says how many, so a collision is never
 * hidden. A chunk that is on one side only is "added" or "deleted".
 */
export const compareChunks = (
  before: ReadonlyArray<BuiltFile>,
  after: ReadonlyArray<BuiltFile>,
): ChunkRow[] => {
  const sumByName = (files: ReadonlyArray<BuiltFile>) => {
    const sums = new Map<string, { bytes: number; count: number }>();
    for (const file of files) {
      const name = stripChunkHash(file.path);
      const sum = sums.get(name) ?? { bytes: 0, count: 0 };
      sums.set(name, { bytes: sum.bytes + file.bytes, count: sum.count + 1 });
    }
    return sums;
  };
  const beforeSums = sumByName(before);
  const afterSums = sumByName(after);

  const rows: ChunkRow[] = [];
  for (const name of new Set([...beforeSums.keys(), ...afterSums.keys()])) {
    const was = beforeSums.get(name);
    const now = afterSums.get(name);
    const row: ChunkRow = {
      name,
      before: was?.bytes ?? 0,
      after: now?.bytes ?? 0,
      status: was === undefined ? "added" : now === undefined ? "deleted" : "changed",
      fileCount: Math.max(was?.count ?? 0, now?.count ?? 0),
    };
    if (row.status !== "changed" || row.before !== row.after) rows.push(row);
  }
  return rows.sort(
    (a, b) =>
      Math.abs(b.after - b.before) - Math.abs(a.after - a.before) || (a.name < b.name ? -1 : 1),
  );
};

/** Returns `bytes` with thousands separators, such as `1,430,902`. */
const formatBytes = (bytes: number): string => bytes.toLocaleString("en-US");

/** Returns the signed difference `after - before` in bytes, such as `+714` or `-3`. */
const formatDelta = (before: number, after: number): string => {
  const delta = after - before;
  return `${delta > 0 ? "+" : ""}${formatBytes(delta)}`;
};

/** Returns the difference as a signed percentage of `before`, or `n/a` when `before` is 0. */
const formatPercent = (before: number, after: number): string => {
  if (before === after) return "0.0%";
  if (before === 0) return "n/a";
  const percent = ((after - before) / before) * 100;
  const sign = percent > 0 ? "+" : "-";
  // A change under 0.05% would print as "-0.0%", which reads as no change.
  return Math.abs(percent) < 0.05
    ? `${sign}<0.1%`
    : `${sign === "+" ? "+" : ""}${percent.toFixed(1)}%`;
};

/** Returns a markdown table with `heading` over the first column and the Before, After, Delta and Delta % columns. */
const renderTable = (heading: string, rows: ReadonlyArray<ReadonlyArray<string>>): string =>
  [
    `| ${heading} | Before | After | Delta | Delta % |`,
    "|---|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

/**
 * Returns the markdown table of the layer totals and the two budget numbers.
 * Every row shows bytes before, bytes after, the difference, and the
 * difference as a percentage of "before".
 */
export const renderMeasureTable = (before: BuildSizes, after: BuildSizes): string => {
  const sum = (files: ReadonlyArray<BuiltFile>, key: "bytes" | "gzipBytes") =>
    files.reduce((total, file) => total + file[key], 0);
  const rows: MeasureRow[] = [
    ...LAYERS.flatMap((layer) => [
      {
        label: `${layer}, all files`,
        before: sum(before.files[layer], "bytes"),
        after: sum(after.files[layer], "bytes"),
      },
      {
        label: `${layer}, all files, gzipped`,
        before: sum(before.files[layer], "gzipBytes"),
        after: sum(after.files[layer], "gzipBytes"),
      },
    ]),
    {
      label: "renderer first screen, gzipped",
      before: before.firstScreenGzipBytes,
      after: after.firstScreenGzipBytes,
    },
    {
      label: "main startup files, minified",
      before: before.mainStartupBytes,
      after: after.mainStartupBytes,
    },
  ];
  return renderTable(
    "Measure (bytes)",
    rows.map((row) => [
      row.label,
      formatBytes(row.before),
      formatBytes(row.after),
      formatDelta(row.before, row.after),
      formatPercent(row.before, row.after),
    ]),
  );
};

/**
 * Returns the markdown table of the chunks whose minified bytes changed, or a
 * sentence saying that none did. A row for colliding names is marked with the
 * number of files it sums.
 */
export const renderChunkTable = (rows: ReadonlyArray<ChunkRow>): string => {
  if (rows.length === 0) return "No chunk changed.";
  return renderTable(
    "Chunk, minified bytes",
    rows.map((row) => {
      const marks = [
        row.status === "changed" ? "" : row.status,
        row.fileCount > 1 ? `${String(row.fileCount)} files with this name, summed` : "",
      ].filter((mark) => mark !== "");
      return [
        marks.length === 0 ? row.name : `${row.name} (${marks.join("; ")})`,
        formatBytes(row.before),
        formatBytes(row.after),
        formatDelta(row.before, row.after),
        formatPercent(row.before, row.after),
      ];
    }),
  );
};

/**
 * Returns the route files that `build:desktop:bundle` passes to the budget
 * check as `--route`, read from the `package.json` text of one tree. Reading
 * them from there keeps this script in step with the build, which owns the
 * list.
 */
export const readFirstScreenRoutes = (packageJson: string): string[] => {
  const script = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts[
    "build:desktop:bundle"
  ];
  if (script === undefined) throw new Error("package.json has no build:desktop:bundle script.");
  const routes = [...script.matchAll(/--route\s+(?:'([^']+)'|(\S+))/g)].map(
    (match) => match[1] ?? match[2]!,
  );
  if (routes.length === 0) {
    throw new Error(
      "the build:desktop:bundle script in package.json has no --route argument, so the first screen's route chunks cannot be found. Update readFirstScreenRoutes if the script was renamed or rewritten.",
    );
  }
  return routes;
};

/** Lists the files under `folder` as paths relative to it, skipping the manifest folder and source maps. */
const listBuiltFiles = (folder: string, prefix = ""): string[] =>
  readdirSync(join(folder, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === ".vite" ? [] : listBuiltFiles(folder, path);
    return entry.name.endsWith(".map") || entry.name === "manifest.json" ? [] : [path];
  });

/**
 * Reads the sizes of the desktop build in `tree` (a checkout whose
 * `apps/desktop/out` has been built). The first screen and main's startup
 * files are found with the budget check's own functions, with the same
 * `--route` files `build:desktop:bundle` passes it. Throws when a file or the
 * manifest it needs is missing, so when the build did not run.
 */
const measureBuild = (tree: string): BuildSizes => {
  const out = join(tree, "apps/desktop/out");
  const files = Object.fromEntries(
    LAYERS.map((layer) => [
      layer,
      listBuiltFiles(join(out, layer)).map((path): BuiltFile => {
        const content = readFileSync(join(out, layer, path));
        return { path, bytes: content.byteLength, gzipBytes: measureGzipBytes(content) };
      }),
    ]),
  ) as Record<Layer, BuiltFile[]>;

  const renderer = join(out, "renderer");
  const routeFiles = readFirstScreenRoutes(readFileSync(join(tree, "package.json"), "utf8")).map(
    (route) => join(tree, route),
  );
  const { firstPaint, routeChunks } = findFirstScreenFiles(renderer, routeFiles);
  const firstScreenGzipBytes = [...new Set([...firstPaint, ...routeChunks])].reduce(
    (total, path) => total + measureGzipBytes(readFileSync(join(renderer, path))),
    0,
  );
  const mainStartupBytes = findStartupFiles(join(out, "main/index.js")).reduce(
    (total, path) => total + statSync(path).size,
    0,
  );
  return { files, firstScreenGzipBytes, mainStartupBytes };
};

// Everything below runs git and the build, and is not unit tested.

/** The command `run` is waiting for, so a signal handler can stop it. Undefined between commands. */
let activeChild: ReturnType<typeof spawn> | undefined;

/** Runs a command with its output on stderr, so stdout holds only the markdown. Fails when it exits non-zero. */
const run = (command: string, args: ReadonlyArray<string>, cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", 2, 2] });
    activeChild = child;
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      activeChild = undefined;
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `\`${command} ${args.join(" ")}\` failed in ${cwd} (${String(code ?? signal)}).`,
          ),
        );
    });
  });

/** Returns the trimmed stdout of a git command run in the repository. Throws when git fails. */
const runGit = (...args: string[]): string => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`\`git ${args.join(" ")}\` failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

/**
 * Installs what the desktop build needs in `tree`, then builds it. The install
 * runs in the working tree too, so a changed lockfile never builds against
 * stale `node_modules`. It skips install scripts: the root `prepare` generates
 * the controller's version file and web bundle, which need packages outside
 * the desktop's dependencies and which the desktop build does not read, and
 * the packages' own scripts (such as the Electron download) are not needed
 * to run Vite.
 */
const installAndBuild = async (tree: string): Promise<void> => {
  await run(
    "pnpm",
    ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@hercule/desktop..."],
    tree,
  );
  await run("pnpm", ["--filter", "@hercule/desktop", "build"], tree);
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { base: { type: "string", default: "origin/main" } },
  });
  const base = values.base;

  const mergeBase = runGit("merge-base", "--end-of-options", "HEAD", base);
  const dirtyFiles = runGit("status", "--porcelain")
    .split("\n")
    .filter((line) => line !== "");
  console.log(`Base: \`${base}\`, merge-base with HEAD \`${mergeBase}\`.`);
  console.log(
    `After: the working tree on \`${runGit("rev-parse", "HEAD")}\`` +
      (dirtyFiles.length === 0
        ? "."
        : `, with its ${String(dirtyFiles.length)} uncommitted changes included (the working tree is dirty).`),
  );
  console.log("The after build replaces this checkout's `apps/desktop/out`.");
  console.log("");

  const scratch = mkdtempSync(join(tmpdir(), "compare-bundle-"));
  const baseTree = join(scratch, "base");
  const removeWorktree = (): void => {
    spawnSync("git", ["worktree", "remove", "--force", baseTree], { cwd: root });
    rmSync(scratch, { recursive: true, force: true });
  };
  // The exit code of a program stopped by a signal is 128 plus its number.
  const signalExitCodes = { SIGINT: 130, SIGTERM: 143 } as const;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      const finish = (): never => {
        removeWorktree();
        process.exit(signalExitCodes[signal]);
      };
      // Wait for the running command to stop, so it is not writing into the worktree being removed.
      if (activeChild === undefined) finish();
      else {
        activeChild.once("exit", finish);
        activeChild.kill();
      }
    });
  }

  try {
    console.error(
      `compare-bundle: building the merge-base in ${relative(root, baseTree) || baseTree}`,
    );
    runGit("worktree", "add", "--detach", baseTree, mergeBase);
    await installAndBuild(baseTree);
    const before = measureBuild(baseTree);

    console.error("compare-bundle: building the working tree");
    await installAndBuild(root);
    const after = measureBuild(root);

    console.log(renderMeasureTable(before, after));
    console.log("");
    console.log(
      renderChunkTable(
        compareChunks(
          LAYERS.flatMap((layer) =>
            before.files[layer].map((file) => ({ ...file, path: `${layer}/${file.path}` })),
          ),
          LAYERS.flatMap((layer) =>
            after.files[layer].map((file) => ({ ...file, path: `${layer}/${file.path}` })),
          ),
        ),
      ),
    );
  } finally {
    removeWorktree();
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`compare-bundle: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

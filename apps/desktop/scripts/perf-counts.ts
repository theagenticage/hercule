/**
 * The counts check of a desktop change (spec 17 §Performance › The counts
 * check): `pnpm --filter @hercule/desktop perf:counts`. It measures what a
 * change costs in counts, which do not depend on how busy the machine is, and
 * compares them with the committed baseline, `apps/desktop/perf-counts.baseline.json`.
 *
 * Three parts run at the same time:
 *
 * - **Bundle.** The desktop build (`pnpm build`), then the bytes of each layer,
 *   the renderer's first screen gzipped, and main's startup files, counted as
 *   the bundle budget check counts them (`measureBuild` in scripts/compare-bundle.ts).
 * - **Controller reads.** The Work board's and the Inbox's speed tests, in their
 *   counts mode (apps/controller/src/db/speed-counts.testing.ts): the
 *   statements and the reply bytes of each read.
 * - **Screens.** The Inbox and Work, booted on a fake controller in one
 *   Chromium and driven step by step (scripts/perf-counts-screens.ts): the
 *   requests, elements restyled, React renders and elements of each step, and
 *   what stays pending while idle.
 *
 * It writes `apps/desktop/out/perf-counts/` (git-ignored):
 *
 * - `counts.json`, every count of the run;
 * - `report.md`, the report it prints;
 * - `steps.json`, every request and every component's renders of each step;
 * - the logs of the build and the speed tests.
 *
 * It exits with 0 when no count is worse than the
 * baseline and no key is missing on either side, and with 1 otherwise
 * (scripts/perf-counts-ratchet.ts says how counts are compared).
 *
 * When a count is worse on purpose, accept it with `--write-baseline`, which
 * writes the baseline from this run and exits with 0. Commit the file and
 * give the reason in the pull request.
 *
 * Chromium needs its system libraries. On a Linux machine without them, run
 * `perf:counts:container`, which runs this script in the desktop container.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatCountsReport, compareCounts } from "./perf-counts-ratchet.ts";
import { measureScreens, type ScreenCounts } from "./perf-counts-screens.ts";
import { startSpecimenServer } from "./sheet-server.ts";
import { formatBaseline, parseBaseline } from "./ui-ratchet.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repositoryDir = fileURLToPath(new URL("../../..", import.meta.url));
const outDir = join(packageDir, "out/perf-counts");
const baselinePath = join(packageDir, "perf-counts.baseline.json");

/** The speed tests whose counts the check keeps. */
const SPEED_TESTS = [
  "apps/controller/src/tasks/board.speed.test.ts",
  "apps/controller/src/external-entities/inbox.speed.test.ts",
];

/**
 * Runs `command` in `cwd` with its output in the log file `logName` under the
 * output folder. Fails when it exits non-zero, with the end of the log in the
 * message.
 */
async function runLogged(
  command: string,
  args: readonly string[],
  cwd: string,
  logName: string,
  env: Readonly<Record<string, string>> = {},
): Promise<void> {
  const logPath = join(outDir, logName);
  const log = createWriteStream(logPath);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Both streams write the one log, so neither may end it; it is ended once the command has exited.
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await new Promise<void>((resolve) => log.end(resolve));
  if (code !== 0) {
    const tail = (await readFile(logPath, "utf8")).split("\n").slice(-30).join("\n");
    throw new Error(
      `\`${command} ${args.join(" ")}\` exited with ${String(code)}. The end of ${logPath}:\n${tail}`,
    );
  }
}

/** Runs a command and returns what it printed on stdout. Fails when it exits non-zero. */
async function readOutput(command: string, args: readonly string[], cwd: string): Promise<string> {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) throw new Error(`\`${command} ${args.join(" ")}\` exited with ${String(code)}.`);
  return output;
}

/** What `measureBuild` returns, as far as the check reads it. */
interface BuildSizes {
  readonly files: Record<
    "main" | "preload" | "renderer",
    ReadonlyArray<{ bytes: number; gzipBytes: number }>
  >;
  readonly firstScreenGzipBytes: number;
  readonly mainStartupBytes: number;
}

/** Builds the desktop app and returns its bundle counts, keyed `bundle/<layer>/<measure>`. */
async function measureBundle(): Promise<Record<string, number>> {
  await runLogged("pnpm", ["build"], packageDir, "build.log");
  // The budget check's helpers gzip with Bun, so they run in Bun.
  const sizes = JSON.parse(
    await readOutput(
      "bun",
      [
        "-e",
        'import { measureBuild } from "./scripts/compare-bundle.ts"; console.log(JSON.stringify(measureBuild(process.cwd())));',
      ],
      repositoryDir,
    ),
  ) as BuildSizes;
  const sum = (
    files: ReadonlyArray<{ bytes: number; gzipBytes: number }>,
    field: "bytes" | "gzipBytes",
  ) => files.reduce((total, file) => total + file[field], 0);
  return {
    "bundle/renderer/bytes": sum(sizes.files.renderer, "bytes"),
    "bundle/renderer/gzipBytes": sum(sizes.files.renderer, "gzipBytes"),
    "bundle/renderer first screen/gzipBytes": sizes.firstScreenGzipBytes,
    "bundle/main/bytes": sum(sizes.files.main, "bytes"),
    "bundle/main startup/bytes": sizes.mainStartupBytes,
    "bundle/preload/bytes": sum(sizes.files.preload, "bytes"),
  };
}

/** Runs the speed tests in their counts mode and returns their counts, keyed `controller/<test>/<read>/<count>`. */
async function measureControllerReads(): Promise<Record<string, number>> {
  const countsFile = join(outDir, "controller.jsonl");
  await rm(countsFile, { force: true });
  await runLogged(
    "bun",
    ["--bun", "run", "vitest", "run", "--project", "node", ...SPEED_TESTS],
    repositoryDir,
    "speed-tests.log",
    { PERF_COUNTS_FILE: countsFile },
  );
  const counts: Record<string, number> = {};
  for (const line of (await readFile(countsFile, "utf8")).split("\n")) {
    if (line === "") continue;
    const { key, value } = JSON.parse(line) as { key: string; value: number };
    counts[`controller/${key}`] = value;
  }
  return counts;
}

/** Measures the screens on the specimen server and returns their counts and the notes for the report. */
async function measureScreenCounts(): Promise<{ counts: Record<string, number>; notes: string }> {
  const server = await startSpecimenServer();
  let screens: Record<string, ScreenCounts>;
  try {
    screens = await measureScreens(server.specimensUrl);
  } finally {
    await server.close();
  }
  // Every request and every component's renders of each step, to compare two runs by.
  await writeFile(join(outDir, "steps.json"), `${JSON.stringify(screens, null, 2)}\n`);
  const counts: Record<string, number> = {};
  const notes: string[] = [
    "## What each step sent and rendered most",
    "Every component's renders are in `steps.json`, beside this report.",
  ];
  for (const [screen, { steps, idle }] of Object.entries(screens)) {
    for (const [step, measured] of steps) {
      for (const metric of ["requests", "restyled", "renders", "rowRenders", "elements"] as const) {
        counts[`screens/${screen}/${step}/${metric}`] = measured[metric];
      }
      const renders = Object.entries(measured.renderList)
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name} ${String(count)}`)
        .join(", ");
      notes.push(
        `- **${screen}, ${step}**: ${measured.requestList.length === 0 ? "no request" : measured.requestList.join(", ")}. ` +
          `Rendered most: ${renders === "" ? "nothing" : renders}.`,
      );
    }
    for (const [metric, value] of Object.entries(idle)) counts[`idle/${screen}/${metric}`] = value;
  }
  return { counts, notes: notes.join("\n") };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { "write-baseline": { type: "boolean", default: false } },
  });
  const started = performance.now();
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const [bundle, controller, screens] = await Promise.all([
    measureBundle(),
    measureControllerReads(),
    measureScreenCounts(),
  ]);
  const current = { ...screens.counts, ...controller, ...bundle };
  await writeFile(join(outDir, "counts.json"), formatBaseline(current));
  const seconds = ((performance.now() - started) / 1000).toFixed(0);

  if (values["write-baseline"]) {
    await writeFile(baselinePath, formatBaseline(current));
    console.log(
      `Wrote ${String(Object.keys(current).length)} counts to ${baselinePath} in ${seconds} s.`,
    );
    return 0;
  }
  let baseline: Record<string, number>;
  try {
    baseline = parseBaseline(await readFile(baselinePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read the baseline ${baselinePath}. Write one with --write-baseline.`,
      {
        cause: error,
      },
    );
  }
  const comparison = compareCounts(current, baseline);
  const report = formatCountsReport(current, baseline, comparison, screens.notes);
  await writeFile(join(outDir, "report.md"), report);
  console.log(report);
  console.log(`The counts check took ${seconds} s.`);
  return comparison.passed ? 0 : 1;
}

process.exitCode = await main();

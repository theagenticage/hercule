/**
 * A stand-in for the Hercule binary, for the tests of the app's first run.
 *
 * Main runs the installed binary, `~/.local/bin/hercule`, to find and start
 * Hercule on this Mac. A test must never run this Mac's own Hercule: even
 * `hercule service status` reads this Mac's launchd, and `hercule service
 * install` writes `~/Library/LaunchAgents` whatever the Hercule Home is. So
 * every launch names another binary with `--hercule-binary` (see
 * `buildStandInBinaryPath`), and a test that needs one writes a stand-in
 * there: a shell script with a scratch Hercule Home of its own, which handles
 * the three commands main runs as the real binary does.
 *
 * - `service status --json` prints a status, as spec 15 §4 describes it.
 * - `service install --json` prints a status too, or fails; `StandInKind`
 *   lists what each kind does.
 * - `setup-url` prints the setup URL in the scratch Home, or exits with 3
 *   when there is none.
 *
 * Any other command fails with exit code 2, so a test notices when main runs
 * something it should not.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { buildStandInBinaryPath, waitForExitOrKill } from "../../apps/desktop/scripts/packaged-app";
import { isProcessRunning } from "../../apps/desktop/scripts/processes";
import { findCompiledBinary } from "../../scripts/controller-process";
import { createTemporaryHome } from "../harness";
import { findUnusedLoopbackUrl } from "./harness";

/**
 * What the stand-in does:
 *
 * - `serve`: no Service Unit is installed, until main installs one. Its
 *   install starts a real controller, the compiled `./hercule serve`, in the
 *   scratch Home, in the background, and exits at once. Run `pnpm
 *   build:binary` first.
 * - `start-error`: no Service Unit is installed, and the install fails with
 *   `START_ERROR_LINE`.
 * - `runner`: the Service Unit runs a runner. The stand-in has no `service
 *   install` case, so an install exits with 2: main must never install over a
 *   runner.
 * - `fresh`: no Service Unit is installed, and nothing answers at the
 *   address the status reports. The stand-in has no `service install` case
 *   either.
 *
 * The `serve` controller runs as launchd runs a Service Unit's process: in a
 * session of its own, so it outlives the install and anything main stops
 * with it. Its `PATH` holds only `/usr/bin` and `/bin`, so the runner it
 * starts finds no coding agent such as Claude Code, and the first run's
 * providers step is never done, whatever this Mac has installed.
 */
export type StandInKind = "serve" | "start-error" | "runner" | "fresh";

/** The line the `start-error` stand-in's install fails with, after `hercule: `. */
export const START_ERROR_LINE =
  "Hercule did not stay running: it exited with code 1 within 3 seconds. Its log is in the Hercule Home's logs folder.";

/** A stand-in binary that a test wrote. */
export interface StandInBinary {
  /** The scratch Hercule Home the stand-in reports, and the `serve` stand-in's controller runs in. */
  readonly home: string;
  /** The origin the stand-in reports as `controllerUrl`, such as `http://127.0.0.1:52001`. */
  readonly controllerUrl: string;
  /**
   * Returns the commands main has run the stand-in with, oldest first, one
   * string of arguments per run, such as `service status --json`.
   */
  readonly readCalls: () => string[];
}

/** Returns `value` quoted for a POSIX shell, so the shell reads it as one word. */
function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Builds the shell command that prints a status, in the shape spec 15 §4
 * gives `hercule service <verb> --json`. `pid` is shell text, such as
 * `null` or `$pid`; every other value is printed as given.
 */
function buildStatusPrintCommand(fields: {
  readonly installed: boolean;
  readonly role: "serve" | "runner" | null;
  readonly pid: string;
  readonly home: string;
  readonly controllerUrl: string;
}): string {
  const quoteJson = (value: string | null) => quoteForShell(JSON.stringify(value));
  const unitHome = fields.installed ? fields.home : null;
  return [
    'printf \'{"installed":%s,"running":%s,"pid":%s,"role":%s,"home":%s,"unitFile":%s,"controllerUrl":%s,"logsDir":%s}\\n\'',
    String(fields.installed),
    String(fields.installed),
    `"${fields.pid}"`,
    quoteJson(fields.role),
    quoteJson(unitHome),
    quoteJson(join(fields.home, "stand-in-unit.plist")),
    quoteJson(fields.controllerUrl),
    quoteJson(join(fields.home, "logs")),
  ].join(" ");
}

/**
 * Writes a stand-in binary of the given kind where a launch on `userDataDir`
 * runs it, with a scratch Hercule Home of its own, and returns it. Write it
 * before the app starts.
 *
 * When the current test finishes, the controller the `serve` stand-in
 * started is stopped by its PID, the master key it stored in the login
 * keychain is deleted, and the scratch Home is deleted. Fails when `kind` is
 * `serve` and the binary has not been built.
 */
export async function writeStandInBinaryForTest(
  userDataDir: string,
  kind: StandInKind,
): Promise<StandInBinary> {
  const compiled = kind === "serve" ? findCompiledBinary() : undefined;
  const { home, remove } = createTemporaryHome();
  // Nothing reserves the port, which is good enough for an address that
  // nothing should answer at, and for the one controller a test starts.
  const controllerUrl = await findUnusedLoopbackUrl();
  const { port } = new URL(controllerUrl);
  const calls = join(home, "stand-in-calls.log");
  const pidFile = join(home, "stand-in-serve.pid");

  const notInstalled = buildStatusPrintCommand({
    installed: false,
    role: null,
    pid: "null",
    home,
    controllerUrl,
  });
  const status = {
    serve: [
      `if [ -f ${quoteForShell(pidFile)} ]; then`,
      `  pid=$(cat ${quoteForShell(pidFile)})`,
      `  ${buildStatusPrintCommand({ installed: true, role: "serve", pid: "$pid", home, controllerUrl })}`,
      "else",
      `  ${notInstalled}`,
      "fi",
    ],
    "start-error": [notInstalled],
    runner: [
      buildStatusPrintCommand({ installed: true, role: "runner", pid: "$$", home, controllerUrl }),
    ],
    fresh: [notInstalled],
  }[kind];
  const install = {
    serve: [
      // Main kills the stand-in's whole process group once the stand-in
      // exits, as it would kill anything the real install left behind, so
      // `set -m` starts the controller in a process group of its own, as
      // launchd would. The controller also writes to a file, not to the
      // stand-in's output, which main stops reading soon after the exit.
      "set -m",
      `if [ ! -f ${quoteForShell(pidFile)} ]; then`,
      `  HERCULE_HOME=${quoteForShell(home)} PATH=/usr/bin:/bin /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' ${quoteForShell(compiled ?? "")} serve -c bind.port=${port} > ${quoteForShell(join(home, "stand-in-serve.log"))} 2>&1 < /dev/null &`,
      `  echo $! > ${quoteForShell(pidFile)}`,
      "fi",
      ...status,
    ],
    "start-error": [`echo ${quoteForShell(`hercule: ${START_ERROR_LINE}`)} >&2`, "exit 1"],
    runner: null,
    fresh: null,
  }[kind];

  const setupUrlFile = quoteForShell(join(home, "setup-url"));
  const script = [
    "#!/bin/sh",
    `# A ${kind} stand-in for the Hercule binary, written by e2e/desktop/stand-in-binary.ts.`,
    `printf '%s\\n' "$*" >> ${quoteForShell(calls)}`,
    'case "$*" in',
    '"service status --json")',
    ...status,
    "exit 0",
    ";;",
    ...(install === null ? [] : ['"service install --json")', ...install, "exit 0", ";;"]),
    "setup-url)",
    `if [ -f ${setupUrlFile} ]; then cat ${setupUrlFile}; exit 0; fi`,
    `echo ${quoteForShell(`hercule: No setup URL in ${join(home, "setup-url")}: either setup is already complete, or \`hercule serve\` has not run yet.`)} >&2`,
    "exit 3",
    ";;",
    "esac",
    `echo "hercule: the ${kind} stand-in has no case for \\\`hercule $*\\\`." >&2`,
    "exit 2",
    "",
  ].join("\n");
  const binary = buildStandInBinaryPath(userDataDir);
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);

  onTestFinished(async () => {
    try {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (isProcessRunning(pid)) {
          process.kill(pid, "SIGTERM");
          await waitForExitOrKill(pid, "the stand-in's controller", "SIGTERM");
        }
      }
    } finally {
      remove();
    }
  });

  return {
    home,
    controllerUrl,
    readCalls: () =>
      existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [],
  };
}

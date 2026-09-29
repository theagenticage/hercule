/**
 * Starts a controller the way an operator does, with `hercule serve`, and
 * runs CLI commands against it: first-run setup included. Three programs use
 * it:
 *
 * - the binary end-to-end suite (`e2e/`), on Bun;
 * - the desktop end-to-end suite (`e2e/desktop/`), on Node, to give the
 *   desktop app a controller to reach;
 * - the desktop perf script (`apps/desktop/scripts/perf.ts`), on plain Node,
 *   to measure the app signed in.
 *
 * So it uses only Node's APIs, which Bun also provides, imports nothing from
 * a test framework, and uses only TypeScript that Node can strip.
 *
 * Nothing here imports Hercule code. The processes are started with
 * `node:child_process` rather than `spawnOwnBinary`, which inherits stdio: a
 * caller has to read what the command printed.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** The repository root, so a caller runs from any working directory. */
export const ROOT = dirname(import.meta.dirname);

/** The dispatcher's source entrypoint: the same `main.ts` the binary compiles. */
const ENTRYPOINT = join(ROOT, "packages/hercule/src/main.ts");

/**
 * The Bun executable that runs the dispatcher's source. Under Bun that is the
 * running executable; under Node, `process.execPath` is Node, which cannot run
 * the dispatcher, so `bun` is looked up on the PATH.
 */
const BUN = process.execPath.endsWith("/bun") ? process.execPath : "bun";

/**
 * Builds the environment a spawned Hercule sees: this process's environment,
 * without any `HERCULE_` variable. A developer with `HERCULE_HOME` or
 * `HERCULE_TOKEN` set in their shell must not change what a test or a
 * measurement exercises.
 */
function buildCleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("HERCULE_"),
    ),
  );
}

/** The result of a finished command. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Picks a port to try. Nothing reserves it: `bind.port` rejects 0, so the
 * kernel cannot give the controller an ephemeral port, and probing one by
 * binding and closing it would only move the race. `startController` treats a
 * bind failure as an ordinary outcome and picks another number instead.
 */
function pickCandidatePort(): number {
  return 20_000 + Math.floor(Math.random() * 40_000);
}

/** A controller process that is running and responding. */
export interface Controller {
  readonly url: string;
  /** The port it bound, so a restart can ask for the same one. */
  readonly port: number;
  /** Everything the process has printed on stdout and stderr, in order. */
  output: () => string;
  /** Sends SIGTERM, then returns the exit code. */
  stop: () => Promise<number>;
}

/**
 * Starts `hercule serve` against a home, and resolves once it responds.
 *
 * Readiness is checked with the unauthenticated `setup.read`, not a line of
 * output: the tests need the listener, and the log line is printed just
 * before the listener is reachable anyway.
 *
 * With no `port`, a number is picked, and the start is retried on another
 * port if something else on the machine took it in the meantime. With a
 * `port` - a restart on the port the first run bound - a bind failure is the
 * result the test gets, so it is reported rather than retried.
 */
export async function startController(options: {
  readonly home: string;
  readonly port?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** The compiled binary to run instead of the dispatcher's source. */
  readonly binary?: string | undefined;
  /**
   * Extra environment for the controller - and the runner it starts for
   * itself - on top of the clean environment. A suite that has to set `HOME`,
   * because git must find none of the developer's own configuration, sets it
   * here.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
}): Promise<Controller> {
  const attempts = options.port === undefined ? 20 : 1;
  const command = options.binary === undefined ? [BUN, ENTRYPOINT] : [options.binary];
  let last: Error | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = options.port ?? pickCandidatePort();
    try {
      return await startControllerOnPort(
        command,
        options.home,
        port,
        options.timeoutMs,
        options.env,
      );
    } catch (error) {
      last = error as Error;
      if (!/in use/.test(last.message)) throw last;
    }
  }
  throw last ?? new Error("hercule serve did not start");
}

/** How long `stop` waits, at most, for the output of a process that has exited. */
const OUTPUT_DRAIN_BOUND_MS = 5_000;

/** Makes one attempt: spawns on this port and waits for it to respond. */
async function startControllerOnPort(
  command: ReadonlyArray<string>,
  home: string,
  port: number,
  timeoutMs: number | undefined,
  env?: Readonly<Record<string, string>>,
): Promise<Controller> {
  const url = `http://127.0.0.1:${String(port)}`;
  const chunks: Array<string> = [];

  const [executable, ...args] = command;
  const child = spawn(executable!, [...args, "serve", "-c", `bind.port=${String(port)}`], {
    cwd: ROOT,
    env: { ...buildCleanEnv(), ...env, HERCULE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => chunks.push(chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => chunks.push(chunk));
  // `exit` fires when the process ends; `close` fires once its output has
  // also been read to the end, which can be later.
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => resolve(code ?? -1));
  });
  const drained = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const waitForOutput = () => Promise.race([drained, sleep(OUTPUT_DRAIN_BOUND_MS)]);

  const readOutput = (): string => chunks.join("");
  const deadline = Date.now() + (timeoutMs ?? 20_000);
  for (;;) {
    if (spawnError !== undefined) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      // The caller reads the output to tell a port in use from other failures.
      await waitForOutput();
      const ending = child.signalCode ?? String(child.exitCode);
      throw new Error(`hercule serve exited with ${ending}:\n${readOutput()}`);
    }
    try {
      const response = await fetch(`${url}/api/v1/setup`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      // Stopped here, because the caller gets no handle on a start that failed.
      child.kill("SIGTERM");
      throw new Error(`hercule serve did not respond:\n${readOutput()}`);
    }
    await sleep(50);
  }

  return {
    url,
    port,
    output: readOutput,
    stop: async () => {
      child.kill("SIGTERM");
      const code = await exited;
      // The process can exit before all of its output has been read from the
      // pipes, and tests check the last lines it printed while stopping. The
      // pipes close only when every process holding them has exited. The local
      // runner shares the controller's stderr and is killed when the
      // controller exits, so the wait is normally short. The wait is capped
      // anyway, so a child that outlives the controller cannot block `stop`.
      await waitForOutput();
      return code;
    },
  };
}

/**
 * Runs the CLI once, the way a shell would: arguments in `argv`, content on
 * stdin, and nothing shared with the caller except the environment it is
 * given.
 */
export async function runCli(
  args: ReadonlyArray<string>,
  options: {
    readonly home: string;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly stdin?: string | undefined;
    /** The compiled binary to run instead of the dispatcher's source. */
    readonly binary?: string | undefined;
  },
): Promise<Ran> {
  const [executable, ...commandArgs] =
    options.binary === undefined ? [BUN, ENTRYPOINT] : [options.binary];
  const child = spawn(executable, [...commandArgs, ...args], {
    cwd: ROOT,
    env: { ...buildCleanEnv(), HERCULE_HOME: options.home, ...options.env },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  // With no input, the command reads end-of-file at once. A command that
  // exits before reading its input closes the pipe, and the write then fails
  // with EPIPE; the exit code tells the test what happened.
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.stdin);
  // `close` fires once the process has exited and its output has been read to
  // the end.
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? -1));
  });
  return { code, stdout, stderr };
}

/** The user every suite sets up as, and the password it logs in with. */
export const USERNAME = "rogier";
export const PASSWORD = "correct horse battery staple";

/**
 * Takes a fresh controller through first run, the way an operator does: reads
 * the setup URL it wrote into its home, and passes that token to the CLI. The
 * caller checks the exit code, because some suites expect this to fail.
 */
export async function completeSetup(options: {
  readonly home: string;
  readonly url: string;
  readonly binary?: string | undefined;
}): Promise<Ran> {
  const setupUrl = readFileSync(join(options.home, "setup-url"), "utf8").trim();
  const token = new URL(setupUrl).searchParams.get("token");
  if (token === null) throw new Error(`no setup token in ${setupUrl}`);
  return runCli(
    [
      "setup",
      "complete",
      "--setup-token",
      token,
      "--username",
      USERNAME,
      "--password-stdin",
      "--timezone",
      "Europe/Amsterdam",
      "--json",
    ],
    {
      home: options.home,
      binary: options.binary,
      env: { HERCULE_API_URL: options.url },
      stdin: PASSWORD,
    },
  );
}

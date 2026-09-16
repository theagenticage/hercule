/**
 * The end-to-end harness: a real controller process, driven by the real CLI.
 *
 * Nothing here imports Hydra code. The point of these tests is that the thing
 * an operator runs works, so the controller is started the way `hydra serve`
 * starts it and every command goes through `argv`, stdin, stdout and the exit
 * code - the same surface a shell sees.
 *
 * The processes are started with `Bun.spawn` rather than `spawnHydra`, which
 * inherits stdio: a test has to read what the command printed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The repository root, so the tests run from any working directory. */
export const ROOT = dirname(import.meta.dirname);

/** The dispatcher's source entrypoint: the same `main.ts` the binary compiles. */
const ENTRYPOINT = join(ROOT, "packages/hydra/src/main.ts");

/**
 * The release binary if one has been built, and `undefined` - the dispatcher's
 * own source - if not.
 *
 * The suites that are only honest as a release say so themselves and refuse to
 * run without `./hydra`, and do not call this. A suite that exercises the
 * controller's own surface rather than the packaging is the same program either
 * way: it runs the release under `pnpm test:binary`, which is the only command
 * that runs it, and the dispatcher's source when it is run on its own with no
 * build behind it.
 */
export function releaseBinary(): string | undefined {
  const built = join(ROOT, "hydra");
  return existsSync(built) ? built : undefined;
}

/**
 * The Bun that is running this test. Under `pnpm test` that is `bun`, but a
 * vitest started by node would give a node path, which cannot run the
 * dispatcher.
 */
const BUN = process.execPath.endsWith("/bun") ? process.execPath : "bun";

/**
 * The environment a spawned Hydra sees: this process's, minus every `HYDRA_`
 * variable. A developer with `HYDRA_HOME` or `HYDRA_TOKEN` set in their shell
 * must not change what these tests exercise.
 */
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("HYDRA_"),
    ),
  );
}

/**
 * Whether the cases that spend a real model token were asked for (D-18).
 *
 * Set to anything but `0` or the empty string is a yes, so a shell that exports
 * `HYDRA_LIVE_SESSION_TEST` can turn it off again with a `0` rather than having
 * to unset it.
 */
export function liveSessionsAsked(): boolean {
  const asked = process.env["HYDRA_LIVE_SESSION_TEST"];
  return asked !== undefined && asked !== "" && asked !== "0";
}

/** What a finished command left behind. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A port to try. Nothing reserves it: `bind.port` rejects 0, so the kernel
 * cannot hand the controller an ephemeral port, and probing one by binding and
 * closing would only move the race. `startController` treats a bind failure as
 * an ordinary outcome and picks another number instead.
 */
function candidatePort(): number {
  return 20_000 + Math.floor(Math.random() * 40_000);
}

/**
 * A temporary Hydra Home, removed when the suite ends.
 *
 * With a `gitconfig`, the directory is also fit to hand a process as `HOME`:
 * it holds none of the git configuration the developer running the suite has -
 * no `.gitconfig` but the one written here, no `.git-credentials`, no `gh`
 * login.
 *
 * `Library` is linked back to the real home on macOS. The master key lives in
 * the login keychain, which `security` finds under `$HOME/Library/Keychains`,
 * so a home without it is a controller that cannot boot; git reads nothing
 * under `Library`, so the scrub still holds.
 */
export function temporaryHome(gitconfig?: string): { home: string; remove: () => void } {
  const home = mkdtempSync(join(tmpdir(), "hydra-e2e-"));
  if (gitconfig !== undefined) {
    writeFileSync(join(home, ".gitconfig"), gitconfig);
    if (process.platform === "darwin") {
      symlinkSync(join(homedir(), "Library"), join(home, "Library"));
    }
  }
  return {
    home,
    remove: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * The environment a test runs `git` in: the `HOME` it was handed and nothing of
 * the developer's - no system configuration, and no terminal to be prompted on
 * - plus one fixed identity, so a commit made here needs no configuration of
 * its own to succeed.
 */
export function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Hydra E2E",
    GIT_AUTHOR_EMAIL: "e2e@hydra.test",
    GIT_COMMITTER_NAME: "Hydra E2E",
    GIT_COMMITTER_EMAIL: "e2e@hydra.test",
  };
}

/** A controller process that is up and answering. */
export interface Controller {
  readonly url: string;
  /** The port it bound, so a restart can ask for the same one. */
  readonly port: number;
  /** Everything the process has printed on stdout and stderr, in order. */
  output: () => string;
  /** SIGTERM, then the exit code it left with. */
  stop: () => Promise<number>;
}

/**
 * Start `hydra serve` against a home, and resolve once it answers.
 *
 * Readiness is the unauthenticated `setup.read`, not a line of output: the
 * listener is what the tests need, and the log line is printed just before it
 * would be reachable anyway.
 *
 * With no `port`, a number is picked and the start is retried on another if the
 * bind loses to whatever else on the machine took it in the meantime. With a
 * `port` - a restart on the port the first run bound - a bind failure is the
 * test's answer, so it is reported rather than retried.
 */
export async function startController(options: {
  readonly home: string;
  readonly port?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** The compiled binary to run instead of the dispatcher's source. */
  readonly binary?: string | undefined;
  /**
   * What the controller - and the runner it starts for itself - sees beyond the
   * clean environment. A suite that has to say what `HOME` is, because git on
   * that machine must find no configuration of the developer's own, has no
   * other way to say it.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
}): Promise<Controller> {
  const attempts = options.port === undefined ? 20 : 1;
  const command = options.binary === undefined ? [BUN, ENTRYPOINT] : [options.binary];
  let last: Error | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = options.port ?? candidatePort();
    try {
      return await startOn(command, options.home, port, options.timeoutMs, options.env);
    } catch (error) {
      last = error as Error;
      if (!/in use/.test(last.message)) throw last;
    }
  }
  throw last ?? new Error("hydra serve never started");
}

/** One attempt: spawn on this port and wait for it to answer. */
async function startOn(
  command: ReadonlyArray<string>,
  home: string,
  port: number,
  timeoutMs: number | undefined,
  env?: Readonly<Record<string, string>>,
): Promise<Controller> {
  const url = `http://127.0.0.1:${String(port)}`;
  const chunks: Array<string> = [];

  const child = Bun.spawn([...command, "serve", "-c", `bind.port=${String(port)}`], {
    cwd: ROOT,
    env: { ...cleanEnv(), ...env, HYDRA_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });

  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) chunks.push(decoder.decode(chunk));
  };
  void drain(child.stdout);
  void drain(child.stderr);

  const output = (): string => chunks.join("");
  const deadline = Date.now() + (timeoutMs ?? 20_000);
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`hydra serve exited with ${String(child.exitCode)}:\n${output()}`);
    }
    try {
      const response = await fetch(`${url}/api/v1/setup`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`hydra serve never answered:\n${output()}`);
    await Bun.sleep(50);
  }

  return {
    url,
    port,
    output,
    stop: async () => {
      child.kill("SIGTERM");
      await child.exited;
      return child.exitCode ?? -1;
    },
  };
}

/**
 * Run the CLI once, the way a shell would: arguments in `argv`, content on
 * stdin, and nothing shared with the caller but the environment it is given.
 */
export async function cli(
  args: ReadonlyArray<string>,
  options: {
    readonly home: string;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly stdin?: string | undefined;
    /** The compiled binary to run instead of the dispatcher's source. */
    readonly binary?: string | undefined;
  },
): Promise<Ran> {
  const command = options.binary === undefined ? [BUN, ENTRYPOINT] : [options.binary];
  const child = Bun.spawn([...command, ...args], {
    cwd: ROOT,
    env: { ...cleanEnv(), HYDRA_HOME: options.home, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** The user every suite sets up as, and the password it logs in with. */
export const USERNAME = "rogier";
export const PASSWORD = "correct horse battery staple";

/**
 * The API key `hydra login` wrote into a home, for the requests no command
 * expresses. Reading the file is the only way to get one: the key is printed
 * nowhere, by design.
 */
export function apiKeyIn(home: string): string {
  const credentials = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")) as {
    readonly apiKey: string;
  };
  return credentials.apiKey;
}

/**
 * Take a fresh controller through first run, the way an operator does: read the
 * setup URL it wrote into its home, and hand that token back to the CLI. The
 * caller asserts the exit code, because a suite that means to fail here says so
 * itself.
 */
export async function completeSetup(options: {
  readonly home: string;
  readonly url: string;
  readonly binary?: string | undefined;
}): Promise<Ran> {
  const setupUrl = readFileSync(join(options.home, "setup-url"), "utf8").trim();
  const token = new URL(setupUrl).searchParams.get("token");
  if (token === null) throw new Error(`no setup token in ${setupUrl}`);
  return cli(
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
      env: { HYDRA_API_URL: options.url },
      stdin: PASSWORD,
    },
  );
}

/** The CLI's `--json` output, parsed. Fails loudly with the command's own output. */
export function jsonOf(ran: Ran): unknown {
  try {
    return JSON.parse(ran.stdout || ran.stderr);
  } catch {
    throw new Error(`not JSON (exit ${String(ran.code)}):\n${ran.stdout}\n${ran.stderr}`);
  }
}

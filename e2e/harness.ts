/**
 * The end-to-end harness: a real controller process, driven by the real CLI.
 *
 * Nothing here imports Hercule code. The point of these tests is that the thing
 * an operator runs works, so the controller is started the way `hercule serve`
 * starts it and every command goes through `argv`, stdin, stdout and the exit
 * code - the same surface a shell sees.
 *
 * The processes are started with `Bun.spawn` rather than `spawnHercule`, which
 * inherits stdio: a test has to read what the command printed.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The repository root, so the tests run from any working directory. */
export const ROOT = dirname(import.meta.dirname);

/** The dispatcher's source entrypoint: the same `main.ts` the binary compiles. */
const ENTRYPOINT = join(ROOT, "packages/hercule/src/main.ts");

/**
 * The release binary if one has been built, and `undefined` - the dispatcher's
 * own source - if not.
 *
 * The suites that are only honest as a release say so themselves and refuse to
 * run without `./hercule`, and do not call this. A suite that exercises the
 * controller's own surface rather than the packaging is the same program either
 * way: it runs the release under `pnpm test:binary`, which is the only command
 * that runs it, and the dispatcher's source when it is run on its own with no
 * build behind it.
 */
export function releaseBinary(): string | undefined {
  const built = join(ROOT, "hercule");
  return existsSync(built) ? built : undefined;
}

/**
 * The Bun that is running this test. Under `pnpm test` that is `bun`, but a
 * vitest started by node would give a node path, which cannot run the
 * dispatcher.
 */
const BUN = process.execPath.endsWith("/bun") ? process.execPath : "bun";

/**
 * The environment a spawned Hercule sees: this process's, minus every `HERCULE_`
 * variable. A developer with `HERCULE_HOME` or `HERCULE_TOKEN` set in their shell
 * must not change what these tests exercise.
 */
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("HERCULE_"),
    ),
  );
}

/**
 * Whether the cases that spend a real model token were asked for.
 *
 * Set to anything but `0` or the empty string is a yes, so a shell that exports
 * `HERCULE_LIVE_SESSION_TEST` can turn it off again with a `0` rather than having
 * to unset it.
 */
export function liveSessionsAsked(): boolean {
  const asked = process.env["HERCULE_LIVE_SESSION_TEST"];
  return asked !== undefined && asked !== "" && asked !== "0";
}

/**
 * ## The login a live session runs on
 *
 * A session runs against the Provider Instance's own `CLAUDE_CONFIG_DIR` under
 * the runner's storage (spec 06 section 4.2), which in a throwaway Hercule
 * Home is empty, so nothing could start. There are two ways to give it a
 * login, and a case that has neither skips saying so:
 *
 * - `HERCULE_E2E_CLAUDE_CREDENTIALS` names a file holding what the Claude CLI
 *   stores as its credential. `lendCredential` copies it into the throwaway
 *   instance directory as `.credentials.json`, and the caller re-probes the
 *   instance; the whole home, credential included, is deleted when the suite
 *   ends. Reading the developer's own login out of wherever their machine
 *   keeps it is the caller's business, never this file's: a test that reaches
 *   into a personal credential store takes a secret nobody handed it.
 * - `ANTHROPIC_API_KEY` on the environment, which reaches the session through
 *   the runner the controller starts for itself.
 */
export const LENT_CREDENTIALS = process.env["HERCULE_E2E_CLAUDE_CREDENTIALS"];

/** Whether either of the two login routes is open for this run. */
export function loginLent(): boolean {
  return LENT_CREDENTIALS !== undefined || process.env["ANTHROPIC_API_KEY"] !== undefined;
}

/**
 * `<home>/runner/<storage>/providers/<instanceId>`: the instance's private
 * config directory, named by the storage directory this runner's identity
 * owns. The runner writes `runner.json` as it enrols, so nothing may call this
 * before it has.
 */
function buildInstanceDir(home: string, instanceId: string): string {
  const pin = JSON.parse(readFileSync(join(home, "runner", "runner.json"), "utf8")) as {
    readonly storageDirectory: string;
  };
  return join(home, "runner", pin.storageDirectory, "providers", instanceId);
}

/** Lends the credential the caller named to the throwaway instance, for this run. */
export function lendCredential(home: string, instanceId: string): void {
  const dir = buildInstanceDir(home, instanceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, ".credentials.json");
  writeFileSync(path, readFileSync(LENT_CREDENTIALS!, "utf8"), { mode: 0o600 });
  chmodSync(path, 0o600);
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
 * A temporary Hercule Home, removed when the suite ends.
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
  const home = mkdtempSync(join(tmpdir(), "hercule-e2e-"));
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
    GIT_AUTHOR_NAME: "Hercule E2E",
    GIT_AUTHOR_EMAIL: "e2e@hercule.test",
    GIT_COMMITTER_NAME: "Hercule E2E",
    GIT_COMMITTER_EMAIL: "e2e@hercule.test",
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
 * Start `hercule serve` against a home, and resolve once it answers.
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
  throw last ?? new Error("hercule serve never started");
}

/** The longest a stop waits for the output of a process that has exited. */
const OUTPUT_DRAIN_BOUND_MS = 5_000;

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
    env: { ...cleanEnv(), ...env, HERCULE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });

  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) chunks.push(decoder.decode(chunk));
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);

  const output = (): string => chunks.join("");
  const deadline = Date.now() + (timeoutMs ?? 20_000);
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`hercule serve exited with ${String(child.exitCode)}:\n${output()}`);
    }
    try {
      const response = await fetch(`${url}/api/v1/setup`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`hercule serve never answered:\n${output()}`);
    await Bun.sleep(50);
  }

  return {
    url,
    port,
    output,
    stop: async () => {
      child.kill("SIGTERM");
      await child.exited;
      // The process can exit before the last of its output is read off the
      // pipes, and a test reads what the process printed last as it stopped.
      // The pipes end when every process that holds them is gone. The local
      // runner holds the controller's stderr and is killed as the controller
      // exits, so the wait is short. It has a bound all the same, so that a
      // child that outlives the controller cannot hold the stop.
      await Promise.race([drained, Bun.sleep(OUTPUT_DRAIN_BOUND_MS)]);
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
    env: { ...cleanEnv(), HERCULE_HOME: options.home, ...options.env },
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
 * The API key `hercule login` wrote into a home, for the requests no command
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
      env: { HERCULE_API_URL: options.url },
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

/**
 * The CLI's `--json` output of a command that was meant to succeed. A non-zero
 * exit is the command's own output, raised: a test that reports "not JSON"
 * about an error envelope says nothing about what went wrong.
 */
export function jsonOk<A>(ran: Ran): A {
  if (ran.code !== 0) {
    throw new Error(`exit ${String(ran.code)}:\n${ran.stdout}\n${ran.stderr}`);
  }
  return jsonOf(ran) as A;
}

/** One page of a listing, as the CLI prints it with `--json`. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
}

/** Long enough for the runner to enrol and to probe a directory it was just handed. */
export const LOGIN_DEADLINE_MS = 120_000;

/** What a runner reported about one Provider Instance when it last probed it. */
export interface Snapshot {
  readonly auth: { readonly status: string; readonly message?: string };
  readonly models: ReadonlyArray<{ readonly slug: string }>;
}

/** A Provider Instance as `provider.query` answers it. */
export interface Instance {
  readonly id: string;
  readonly providerId: string;
  readonly snapshots: ReadonlyArray<Snapshot>;
}

/**
 * Every Provider Instance, over HTTP rather than through the CLI: the snapshots
 * are what these tests wait on, and waiting is a loop, not a command.
 */
export async function instancesOf(options: {
  readonly url: string;
  readonly apiKey: string;
}): Promise<ReadonlyArray<Instance>> {
  const response = await fetch(`${options.url}/api/v1/providers`, {
    headers: { authorization: `Bearer ${options.apiKey}` },
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(`GET /api/v1/providers answered ${String(response.status)}: ${body}`);
  return JSON.parse(body) as ReadonlyArray<Instance>;
}

/**
 * The controller's own runner, once it has enrolled and dialled in. It writes
 * `runner.json` and its storage directory on the way, which is what the login
 * is lent into, so nothing may read either before this answers.
 */
export async function waitForEnrolledRunner(options: {
  readonly home: string;
  readonly binary: string;
}): Promise<string> {
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  for (;;) {
    const ran = await cli(["runner", "list", "--json"], options);
    const id = ran.code === 0 ? jsonOk<Page<{ readonly id: string }>>(ran).items[0]?.id : undefined;
    if (id !== undefined && existsSync(join(options.home, "runner", "runner.json"))) return id;
    if (Date.now() > deadline) throw new Error(`no runner dialled the controller:\n${ran.stdout}`);
    await Bun.sleep(500);
  }
}

/** The claude-code Provider Instance the controller seeds for itself. */
export async function readClaudeInstance(options: {
  readonly url: string;
  readonly apiKey: string;
}): Promise<Instance> {
  const found = (await instancesOf(options)).find((one) => one.providerId === "claude-code");
  if (found === undefined) throw new Error("no claude-code Provider Instance was seeded");
  return found;
}

/**
 * Probes the instance until a machine says its login works, and answers with
 * that snapshot. Repeated rather than trusted once: a probe of a directory
 * that was empty a moment ago has been seen to answer `unauthenticated`.
 */
export async function probeUntilLoggedIn(options: {
  readonly home: string;
  readonly binary: string;
  readonly runnerId: string;
  readonly instanceId: string;
}): Promise<Snapshot> {
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  let last: string;
  for (;;) {
    const ran = await cli(
      ["runner", "probe", options.runnerId, "--instance", options.instanceId, "--json"],
      options,
    );
    if (ran.code === 0) {
      const snapshot = jsonOk<Snapshot>(ran);
      if (snapshot.auth.status === "ok") return snapshot;
      last = `${snapshot.auth.status}: ${snapshot.auth.message ?? "no message"}`;
    } else {
      last = `${ran.stdout}\n${ran.stderr}`;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the instance never probed ok within ${String(LOGIN_DEADLINE_MS / 1000)}s: ${last}`,
      );
    }
    await Bun.sleep(2_000);
  }
}

/** A runner, a Provider Instance and the login it runs on, all in place. */
export interface LoggedInInstance {
  readonly runnerId: string;
  readonly instance: Instance;
  readonly snapshot: Snapshot;
}

/**
 * Everything a live session needs before it can be spawned: the enrolled
 * runner, the claude-code instance, the lent credential where the caller named
 * one, and a probe that says the login works.
 */
export async function prepareLoggedInInstance(options: {
  readonly home: string;
  readonly binary: string;
  readonly url: string;
  readonly apiKey: string;
}): Promise<LoggedInInstance> {
  const runnerId = await waitForEnrolledRunner(options);
  const instance = await readClaudeInstance(options);
  if (LENT_CREDENTIALS !== undefined) lendCredential(options.home, instance.id);
  const snapshot = await probeUntilLoggedIn({ ...options, runnerId, instanceId: instance.id });
  return { runnerId, instance, snapshot };
}

/** A session as the session operations answer it. */
export interface Session {
  readonly id: string;
  readonly status: string;
  readonly accessMode: string;
  readonly permissionProfileId: string | null;
  readonly nativeSessionId: string | null;
}

/** Where a session got to, read back the way an operator reads it. */
export async function sessionOf(options: {
  readonly home: string;
  readonly binary: string;
  readonly id: string;
}): Promise<Session> {
  return jsonOk<Session>(
    await cli(["session", "read", options.id, "--json"], {
      home: options.home,
      binary: options.binary,
    }),
  );
}

/** One normalized transcript row: its position and the event at it. */
export interface Row {
  readonly position: number;
  readonly event: { readonly _tag: string; readonly [key: string]: unknown };
}

/** A session's whole transcript, in order. */
export async function transcriptOf(options: {
  readonly home: string;
  readonly binary: string;
  readonly id: string;
}): Promise<ReadonlyArray<Row>> {
  return jsonOk<{ items: ReadonlyArray<Row> }>(
    await cli(["transcript", "read", options.id, "--json", "--all"], {
      home: options.home,
      binary: options.binary,
    }),
  ).items;
}

/**
 * Waits until a session's transcript holds `tag`, and says what it held instead
 * - and where the session got to - when it never does.
 */
export async function untilTag(options: {
  readonly home: string;
  readonly binary: string;
  readonly id: string;
  readonly tag: string;
  readonly timeoutMs: number;
}): Promise<ReadonlyArray<Row>> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const rows = await transcriptOf(options);
    if (rows.some((row) => row.event._tag === options.tag)) return rows;
    if (Date.now() > deadline) {
      const session = await sessionOf(options);
      throw new Error(
        `no ${options.tag} within ${String(options.timeoutMs / 1000)}s: the session reads ` +
          `${session.status} and its transcript holds ` +
          `${rows.map((row) => row.event._tag).join(", ") || "nothing"}`,
      );
    }
    await Bun.sleep(500);
  }
}

/** Everything a session said, as one string: the coalesced assistant text. */
export function saidIn(rows: ReadonlyArray<Row>): string {
  return rows
    .flatMap((row) =>
      row.event._tag === "content.delta" && row.event["streamKind"] === "assistant_text"
        ? [String(row.event["delta"])]
        : [],
    )
    .join("");
}

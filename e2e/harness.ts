/**
 * The end-to-end harness: a real controller process, driven by the real CLI.
 *
 * Nothing here imports Hercule code. These tests check that what an operator
 * runs actually works, so the controller is started the way `hercule serve`
 * starts it, and every command goes through `argv`, stdin, stdout and the exit
 * code - the same interface a shell sees. Starting the controller and running
 * the CLI live in `scripts/controller-process.ts`, which the desktop suite and
 * the desktop perf script use too; this file holds what only the binary suite
 * needs on top.
 */
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  completeSetup,
  deleteMasterKeyItem,
  runCli,
  type Ran,
} from "../scripts/controller-process";

/**
 * Returns the path of the release binary if one has been built, or `undefined`
 * to run the dispatcher's own source.
 *
 * Suites that only make sense against a release binary check for `./hercule`
 * themselves and do not run without it; they do not call this. A suite that
 * tests the controller itself rather than the packaging works the same either
 * way: it runs the release binary under `pnpm test:binary`, which is the only
 * command that runs it, and the dispatcher's source when it is run on its own
 * without a build.
 */
export function findReleaseBinary(): string | undefined {
  const built = join(ROOT, "hercule");
  return existsSync(built) ? built : undefined;
}

/**
 * Checks whether the cases that spend real model tokens were requested.
 *
 * Any value other than `0` or the empty string turns them on, so a shell that
 * exports `HERCULE_LIVE_SESSION_TEST` can turn them off again with `0` rather
 * than having to unset it.
 */
export function isLiveSessionTestEnabled(): boolean {
  const asked = process.env["HERCULE_LIVE_SESSION_TEST"];
  return asked !== undefined && asked !== "" && asked !== "0";
}

/**
 * ## The login a live session runs on
 *
 * A session runs against the Provider Instance's own `CLAUDE_CONFIG_DIR` under
 * the runner's storage (spec 06 section 4.2), which in a throwaway Hercule
 * Home is empty, so nothing could start. There are two ways to give it a
 * login, and a case that has neither is skipped with a message:
 *
 * - `HERCULE_E2E_CLAUDE_CREDENTIALS` names a file holding what the Claude CLI
 *   stores as its credential. `lendCredential` copies it into the throwaway
 *   instance directory as `.credentials.json`, and the caller re-probes the
 *   instance; the whole home, credential included, is deleted when the suite
 *   ends. Reading the developer's own login from wherever their machine keeps
 *   it is up to the caller, never this file: a test that reads a personal
 *   credential store takes a secret nobody gave it.
 * - `ANTHROPIC_API_KEY` on the environment, which reaches the session through
 *   the runner the controller starts for itself.
 */
export const LENT_CREDENTIALS = process.env["HERCULE_E2E_CLAUDE_CREDENTIALS"];

/** Checks whether either of the two login routes is available for this run. */
export function isLoginAvailable(): boolean {
  return LENT_CREDENTIALS !== undefined || process.env["ANTHROPIC_API_KEY"] !== undefined;
}

/**
 * Returns `<home>/runner/<storage>`, the storage directory of the runner in
 * `home`. The directory gets a random name when the runner enrols, so it is
 * read from `runner.json`, which the runner writes as it enrols. Nothing may
 * call this before then.
 */
export function readRunnerStorageDir(home: string): string {
  const pin = JSON.parse(readFileSync(join(home, "runner", "runner.json"), "utf8")) as {
    readonly storageDirectory: string;
  };
  return join(home, "runner", pin.storageDirectory);
}

/**
 * Returns `<home>/runner/<storage>/providers/<instanceId>`: the instance's
 * private config directory, inside the storage directory of this runner. The
 * runner writes `runner.json` as it enrols, so nothing may call this before
 * then.
 */
export function buildInstanceDir(home: string, instanceId: string): string {
  return join(readRunnerStorageDir(home), "providers", instanceId);
}

/** Copies the credential the caller named into the throwaway instance, for this run. */
export function lendCredential(home: string, instanceId: string): void {
  const dir = buildInstanceDir(home, instanceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, ".credentials.json");
  writeFileSync(path, readFileSync(LENT_CREDENTIALS!, "utf8"), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** A temporary directory for a test, and the function that removes it. */
export interface TemporaryHome {
  readonly home: string;
  readonly remove: () => void;
}

/**
 * Creates a temporary Hercule Home, and returns it with a function that
 * removes it.
 *
 * Call it in a `beforeAll` or inside a test, never at the top level of a test
 * file. Vitest runs no hooks for a file whose tests are all skipped, so a home
 * created on import would never reach the `afterAll` that removes it.
 *
 * With a `gitconfig`, the directory can also be given to a process as `HOME`:
 * it holds none of the git configuration of the developer running the suite -
 * no `.gitconfig` except the one written here, no `.git-credentials`, no `gh`
 * login.
 *
 * On macOS, `Library` is linked back to the real home. The master key is in
 * the login keychain, which `security` finds under `$HOME/Library/Keychains`,
 * so without it the controller cannot boot; git reads nothing under
 * `Library`, so the isolation still holds.
 */
export function createTemporaryHome(gitconfig?: string): TemporaryHome {
  const home = mkdtempSync(join(tmpdir(), "hercule-e2e-"));
  if (gitconfig !== undefined) {
    writeFileSync(join(home, ".gitconfig"), gitconfig);
    if (process.platform === "darwin") {
      symlinkSync(join(homedir(), "Library"), join(home, "Library"));
    }
  }
  return {
    home,
    // A process can still write into the home for a moment after the
    // controller has stopped. The runner stops the Claude Code CLI it started
    // to check the provider, but does not wait for the CLI to exit, and the
    // CLI writes its config file into the home. When that file lands in a
    // folder Node has just emptied, the delete fails with ENOTEMPTY. Trying
    // again removes the late file too.
    remove: () => {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      deleteMasterKeyItem(home);
    },
  };
}

/**
 * Builds the environment a test runs `git` in: the given `HOME` and nothing of
 * the developer's - no system configuration, and no terminal to prompt on -
 * plus one fixed identity, so a commit made here needs no configuration of its
 * own to succeed.
 */
export function buildGitEnv(home: string): Record<string, string> {
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

/**
 * Returns the API key `hercule login` wrote into a home, for the requests no
 * command covers. Reading the file is the only way to get it: by design, the
 * key is never printed.
 */
export function readApiKey(home: string): string {
  const credentials = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")) as {
    readonly apiKey: string;
  };
  return credentials.apiKey;
}

/** Parses the CLI's `--json` output. Throws with the command's own output when it is not JSON. */
export function parseJsonOutput(ran: Ran): unknown {
  try {
    return JSON.parse(ran.stdout || ran.stderr);
  } catch {
    throw new Error(`not JSON (exit ${String(ran.code)}):\n${ran.stdout}\n${ran.stderr}`);
  }
}

/** Throws with the command's own output unless the command exited with 0. */
export function assertSucceeded(ran: Ran): void {
  if (ran.code !== 0) {
    throw new Error(`exit ${String(ran.code)}:\n${ran.stdout}\n${ran.stderr}`);
  }
}

/**
 * Parses the `--json` output of a command that was meant to succeed. Throws
 * with the command's own output on a non-zero exit: a test that reports "not
 * JSON" about an error envelope says nothing about what went wrong.
 */
export function parseJsonOutputOrFail<A>(ran: Ran): A {
  assertSucceeded(ran);
  return parseJsonOutput(ran) as A;
}

/** One page of a list, as the CLI prints it with `--json`. */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
}

/** Long enough for the runner to enrol and to probe a directory it was just given. */
export const LOGIN_DEADLINE_MS = 120_000;

/** What a runner reported about one Provider Instance when it last probed it. */
export interface Snapshot {
  readonly auth: { readonly status: string; readonly message?: string };
  readonly models: ReadonlyArray<{ readonly slug: string }>;
}

/** A Provider Instance as `provider.query` returns it. */
export interface Instance {
  readonly id: string;
  readonly harnessId: string;
  readonly snapshots: ReadonlyArray<Snapshot>;
}

/**
 * Lists every Provider Instance, over HTTP rather than through the CLI: these
 * tests wait on the snapshots, and waiting is a loop, not a command.
 */
export async function listInstances(options: {
  readonly url: string;
  readonly apiKey: string;
}): Promise<ReadonlyArray<Instance>> {
  const response = await fetch(`${options.url}/api/v1/providers`, {
    headers: { authorization: `Bearer ${options.apiKey}` },
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(`GET /api/v1/providers returned ${String(response.status)}: ${body}`);
  return JSON.parse(body) as ReadonlyArray<Instance>;
}

/**
 * Waits for the controller's own runner to enrol and come online, and returns
 * its id. On the way, the runner writes `runner.json` and its storage
 * directory, which the login is copied into, so nothing may read either before
 * this returns. An enrolled runner is listed before it connects, so the list
 * is filtered to online runners.
 */
export async function waitForEnrolledRunner(options: {
  readonly home: string;
  /** The compiled binary to run instead of the dispatcher's source. */
  readonly binary?: string | undefined;
}): Promise<string> {
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  for (;;) {
    const ran = await runCli(["runner", "list", "--connectivity", "online", "--json"], options);
    const id =
      ran.code === 0
        ? parseJsonOutputOrFail<Page<{ readonly id: string }>>(ran).items[0]?.id
        : undefined;
    if (id !== undefined && existsSync(join(options.home, "runner", "runner.json"))) return id;
    if (Date.now() > deadline)
      throw new Error(`no runner connected to the controller:\n${ran.stdout}`);
    await sleep(500);
  }
}

/** Returns the claude-code Provider Instance the controller creates for itself. */
export async function readClaudeInstance(options: {
  readonly url: string;
  readonly apiKey: string;
}): Promise<Instance> {
  const found = (await listInstances(options)).find((one) => one.harnessId === "claude-code");
  if (found === undefined) throw new Error("no claude-code Provider Instance was seeded");
  return found;
}

/**
 * Probes the instance until a machine reports that its login works, and
 * returns that snapshot. The probe is repeated rather than trusted once: a
 * probe of a directory that was empty a moment ago has been seen to return
 * `unauthenticated`.
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
    const ran = await runCli(
      ["runner", "probe", options.runnerId, "--instance", options.instanceId, "--json"],
      options,
    );
    if (ran.code === 0) {
      const snapshot = parseJsonOutputOrFail<Snapshot>(ran);
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
    await sleep(2_000);
  }
}

/** A runner, a Provider Instance and the login it runs on, all ready. */
export interface LoggedInInstance {
  readonly runnerId: string;
  readonly instance: Instance;
  readonly snapshot: Snapshot;
}

/**
 * Prepares everything a live session needs before it can be spawned: the
 * enrolled runner, the claude-code instance, the copied credential when the
 * caller named one, and a probe that confirms the login works.
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

/** A session as the session operations return it. */
export interface Session {
  readonly id: string;
  readonly status: string;
  readonly accessMode: string;
  readonly permissionProfileId: string | null;
  readonly nativeSessionId: string | null;
}

/** Reads a session's current state, the way an operator reads it. */
export async function readSession(options: {
  readonly home: string;
  readonly binary: string;
  readonly id: string;
}): Promise<Session> {
  return parseJsonOutputOrFail<Session>(
    await runCli(["session", "read", options.id, "--json"], {
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

/** Reads a session's whole transcript, in order. */
export async function readTranscript(options: {
  readonly home: string;
  readonly binary: string;
  readonly id: string;
}): Promise<ReadonlyArray<Row>> {
  return parseJsonOutputOrFail<{ items: ReadonlyArray<Row> }>(
    await runCli(["transcript", "read", options.id, "--json", "--all"], {
      home: options.home,
      binary: options.binary,
    }),
  ).items;
}

/**
 * Waits until a session's transcript contains `tag`. When it never does,
 * throws with what the transcript contained instead, and the session's state.
 */
export async function waitForTranscriptTag(options: {
  readonly home: string;
  readonly binary: string;
  readonly id: string;
  readonly tag: string;
  readonly timeoutMs: number;
}): Promise<ReadonlyArray<Row>> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const rows = await readTranscript(options);
    if (rows.some((row) => row.event._tag === options.tag)) return rows;
    if (Date.now() > deadline) {
      const session = await readSession(options);
      throw new Error(
        `no ${options.tag} within ${String(options.timeoutMs / 1000)}s: the session reads ` +
          `${session.status} and its transcript holds ` +
          `${rows.map((row) => row.event._tag).join(", ") || "nothing"}`,
      );
    }
    await sleep(500);
  }
}

/** Returns everything a session said, as one string: the coalesced assistant text. */
export function collectAssistantText(rows: ReadonlyArray<Row>): string {
  return rows
    .flatMap((row) =>
      row.event._tag === "content.delta" && row.event["streamKind"] === "assistant_text"
        ? [String(row.event["delta"])]
        : [],
    )
    .join("");
}

/**
 * Takes a started controller through first-run setup, logs the CLI in from
 * `home`, and returns the API key that login wrote. `apiKeyName` is the name
 * the key is stored under, so a key left behind says which suite made it.
 */
export async function completeSetupAndLogin(options: {
  readonly home: string;
  readonly url: string;
  readonly binary: string;
  readonly apiKeyName: string;
}): Promise<string> {
  const { home, url, binary } = options;
  assertSucceeded(await completeSetup({ home, url, binary }));
  assertSucceeded(
    await runCli(
      ["login", url, "--username", USERNAME, "--password-stdin", "--name", options.apiKeyName],
      { home, binary, stdin: PASSWORD },
    ),
  );
  return readApiKey(home);
}

/** Stops each session in `ids`, ignoring the ones that cannot be stopped any more. */
export async function stopSessions(options: {
  readonly home: string;
  readonly binary: string;
  readonly ids: ReadonlyArray<string>;
}): Promise<void> {
  for (const id of options.ids) {
    await runCli(["session", "stop", id], options).catch(() => undefined);
  }
}

/** Sends one more input to a session, resuming it when it has exited. */
export async function sendSessionInput(options: {
  readonly home: string;
  readonly binary: string;
  readonly id: string;
  readonly input: string;
}): Promise<void> {
  assertSucceeded(
    await runCli(["session", "input", options.id], {
      home: options.home,
      binary: options.binary,
      stdin: options.input,
    }),
  );
}

/**
 * Waits until a session has completed `count` turns, and returns its
 * transcript. When it never does, throws with what the transcript held.
 */
export async function waitForTurns(options: {
  readonly home: string;
  readonly binary: string;
  readonly id: string;
  readonly count: number;
  readonly timeoutMs: number;
}): Promise<ReadonlyArray<Row>> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const rows = await readTranscript(options);
    if (rows.filter((row) => row.event._tag === "turn.completed").length >= options.count) {
      return rows;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `session ${options.id} did not complete ${String(options.count)} turns: its transcript holds ` +
          rows.map((row) => row.event._tag).join(", "),
      );
    }
    await sleep(500);
  }
}

/** Waits until a session reads `exited`. Throws when it does not within `timeoutMs`. */
export async function waitForExit(options: {
  readonly home: string;
  readonly binary: string;
  readonly id: string;
  readonly timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while ((await readSession(options)).status !== "exited") {
    if (Date.now() > deadline) throw new Error(`session ${options.id} never exited`);
    await sleep(500);
  }
}

/**
 * Returns the folder of a session's current start on a runner,
 * `session-skills/<sessionId>-<uuid>/` in the runner's storage directory. The
 * runner builds it before the process starts and removes it when the process
 * exits, so it can only be read while the session runs. Throws unless exactly
 * one such folder exists.
 */
export function findSessionSkillsFolder(runnerHome: string, sessionId: string): string {
  const dir = join(readRunnerStorageDir(runnerHome), "session-skills");
  const folders = readdirSync(dir).filter((name) => name.startsWith(`${sessionId}-`));
  if (folders.length !== 1) {
    throw new Error(
      `the runner has ${String(folders.length)} session skills folders for session ${sessionId}, not one`,
    );
  }
  return join(dir, folders[0]!);
}

/**
 * Returns a `SKILL.md` whose body tells the model to reply with one word and
 * nothing else. The description does not name the word, so the model learns
 * it only from the body.
 */
function buildSkillMd(name: string, word: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: Replies with a code word.",
    "---",
    `Reply with exactly the single word ${word} and nothing else. Use no tools.`,
    "",
  ].join("\n");
}

/** Writes the skill `name`, which makes the model reply with `word`, into the folder of skills `dir`. */
export function writeSkill(dir: string, name: string, word: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), buildSkillMd(name, word));
}

/**
 * Writes a temporary folder of skills, one for each name in `words` with its
 * word, and returns its path. The caller removes the folder.
 */
export function createSkillsFolder(words: Readonly<Record<string, string>>): string {
  const folder = mkdtempSync(join(tmpdir(), "hercule-e2e-skills-"));
  for (const [name, word] of Object.entries(words)) writeSkill(folder, name, word);
  return folder;
}

/**
 * Imports the folder of skills `fixture` into the Skill Library, then deletes
 * `review` if the library holds it. The live skill tests import `review` in
 * the middle of a case, so each case starts by removing what a case before it
 * may have left.
 */
export async function resetSkillLibrary(options: {
  readonly home: string;
  readonly binary: string;
  readonly fixture: string;
}): Promise<void> {
  const cli = { home: options.home, binary: options.binary };
  assertSucceeded(await runCli(["skill", "import", options.fixture], cli));
  const listed = parseJsonOutputOrFail<Page<{ readonly name: string }>>(
    await runCli(["skill", "list", "--json"], cli),
  ).items;
  if (listed.some((skill) => skill.name === "review")) {
    assertSucceeded(await runCli(["skill", "delete", "review"], cli));
  }
}

/** Where a harness's login is put, and how to reach the controller that stores it. */
export interface LoginTarget {
  /** The Hercule Home of the runner that runs the session. */
  readonly runnerHome: string;
  readonly url: string;
  readonly apiKey: string;
}

/** One harness that the live skill tests drive, and how they drive it. */
export interface LiveHarness {
  readonly harnessId: string;
  readonly label: string;
  /** Returns the input that runs the library skill or the user's skill `name`. */
  readonly invokeSkill: (name: string) => string;
  /** Returns the input that runs the repository skill `name` of the checkout `checkout`. */
  readonly invokeRepositorySkill: (checkout: string, name: string) => string;
  /** Checks whether a model slug is one of the cheap models the live tests prefer. */
  readonly isCheapModel: (slug: string) => boolean;
  /** Returns why this harness cannot run on this machine, or `undefined` when it can. */
  readonly findSkipReason: () => string | undefined;
  /** Gives the instance its login on the runner in `target`. */
  readonly lendLogin: (target: LoginTarget, instanceId: string) => Promise<void>;
}

/** The Codex `auth.json` lent to the Codex instance, when the developer named one. */
const LENT_CODEX_AUTH = process.env["HERCULE_E2E_CODEX_AUTH"];

/** The Z.ai key stored as the pi instance's own, when the environment has one. */
const ZAI_API_KEY = process.env["ZAI_API_KEY"];

/**
 * Returns a reason to skip when `name` is not an executable file in a folder of
 * the `PATH`, or `undefined` when it is. It scans the `PATH` itself instead of
 * calling `Bun.which`, because the desktop suite imports this file and runs on
 * Node.
 */
function findMissingBinary(name: string): string | undefined {
  const folders = (process.env["PATH"] ?? "").split(delimiter).filter((folder) => folder !== "");
  const found = folders.some((folder) => {
    try {
      accessSync(join(folder, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  return found ? undefined : `\`${name}\` is not on the PATH.`;
}

/**
 * The harnesses the live skill tests run, and what each needs:
 *
 * - Claude Code: either of the two routes documented at `LENT_CREDENTIALS`.
 * - Codex: `HERCULE_E2E_CODEX_AUTH` names a Codex `auth.json`, which is copied
 *   into the instance's `CODEX_HOME`. Two live copies of an OAuth login can
 *   rotate each other out, so prefer a file written by `codex login
 *   --with-api-key`, which holds no refresh token. `codex` must be on the
 *   `PATH`.
 * - pi: `ZAI_API_KEY` on the environment, which is stored as the pi
 *   instance's Z.ai key. `pi` must be on the `PATH`.
 */
export const LIVE_HARNESSES: ReadonlyArray<LiveHarness> = [
  {
    harnessId: "claude-code",
    label: "Claude Code",
    invokeSkill: (name) => `/${name}`,
    invokeRepositorySkill: (checkout, name) => `/repo-${checkout}:${name}`,
    isCheapModel: (slug) => slug.includes("haiku"),
    findSkipReason: () =>
      isLoginAvailable()
        ? undefined
        : "no login for the claude-code instance: name a credentials file in " +
          "HERCULE_E2E_CLAUDE_CREDENTIALS, or put ANTHROPIC_API_KEY on the environment.",
    lendLogin: (target, instanceId) => {
      // With ANTHROPIC_API_KEY instead, the key reaches the runner through its
      // environment.
      if (LENT_CREDENTIALS !== undefined) lendCredential(target.runnerHome, instanceId);
      return Promise.resolve();
    },
  },
  {
    harnessId: "codex",
    label: "Codex",
    invokeSkill: (name) => `$${name}`,
    invokeRepositorySkill: (_checkout, name) => `$${name}`,
    isCheapModel: (slug) => slug.includes("mini"),
    findSkipReason: () =>
      LENT_CODEX_AUTH === undefined
        ? "no login for the codex instance: name a Codex auth.json in HERCULE_E2E_CODEX_AUTH."
        : findMissingBinary("codex"),
    lendLogin: (target, instanceId) => {
      // The Codex adapter runs every process with `CODEX_HOME` set to the
      // instance's `codex` folder, where Codex keeps its login.
      const codexHome = join(buildInstanceDir(target.runnerHome, instanceId), "codex");
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      // Written with the mode a login needs, not the mode of the file lent.
      const auth = join(codexHome, "auth.json");
      writeFileSync(auth, readFileSync(LENT_CODEX_AUTH!, "utf8"), { mode: 0o600 });
      chmodSync(auth, 0o600);
      return Promise.resolve();
    },
  },
  {
    harnessId: "pi",
    label: "pi",
    invokeSkill: (name) => `/skill:${name}`,
    invokeRepositorySkill: (_checkout, name) => `/skill:${name}`,
    isCheapModel: (slug) => slug.includes("flash"),
    findSkipReason: () =>
      ZAI_API_KEY === undefined
        ? "no login for the pi instance: put ZAI_API_KEY on the environment."
        : findMissingBinary("pi"),
    lendLogin: async (target, instanceId) => {
      // A provider instance's secret field is stored in the secrets table, not
      // in its config, so it is set through `secret.set`. Over HTTP rather
      // than `hercule secret set`, so the key is never on a command line other
      // processes can read.
      const response = await fetch(
        `${target.url}/api/v1/secrets/provider-instance/${instanceId}/zaiApiKey`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${target.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ value: ZAI_API_KEY }),
        },
      );
      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `PUT the pi instance's secret returned ${String(response.status)}: ${body}`,
        );
      }
    },
  },
];

/** A harness's Provider Instance, logged in on a runner. */
export interface PreparedHarness {
  readonly instanceId: string;
  /** The cheapest model the runner reported, or `undefined` for the instance's default. */
  readonly model: string | undefined;
}

/**
 * Gives the harness's Provider Instance its login on the runner `runnerId`,
 * whose Hercule Home is `runnerHome`, and waits until that runner's probe
 * reports it logged in. Returns the instance with the cheapest model the
 * runner reports. `home` is the Hercule Home the CLI is logged in from.
 */
export async function prepareHarness(
  harness: LiveHarness,
  options: {
    readonly home: string;
    readonly binary: string;
    readonly url: string;
    readonly apiKey: string;
    readonly runnerId: string;
    readonly runnerHome: string;
  },
): Promise<PreparedHarness> {
  const { home, binary, url, apiKey, runnerId, runnerHome } = options;
  const instance = (await listInstances({ url, apiKey })).find(
    (one) => one.harnessId === harness.harnessId,
  );
  if (instance === undefined) throw new Error(`no ${harness.harnessId} instance was seeded`);
  await harness.lendLogin({ runnerHome, url, apiKey }, instance.id);
  const snapshot = await probeUntilLoggedIn({ home, binary, runnerId, instanceId: instance.id });
  const model = snapshot.models.map((one) => one.slug).find(harness.isCheapModel);
  return { instanceId: instance.id, model };
}

/**
 * Starts a Thread on a runner with one input, and returns its session id. With
 * a `workspace` (the JSON the CLI's `--workspace` takes) the Thread runs in
 * it; without one it gets the default.
 */
export async function spawnThread(options: {
  readonly home: string;
  readonly binary: string;
  readonly runnerId: string;
  readonly prepared: PreparedHarness;
  readonly input: string;
  readonly workspace?: unknown;
}): Promise<string> {
  const { prepared, workspace } = options;
  const session = parseJsonOutputOrFail<Session>(
    await runCli(
      [
        "session",
        "spawn",
        "--instance",
        prepared.instanceId,
        "--runner",
        options.runnerId,
        ...(prepared.model === undefined ? [] : ["--model", prepared.model]),
        ...(workspace === undefined ? [] : ["--workspace", JSON.stringify(workspace)]),
        "--json",
      ],
      { home: options.home, binary: options.binary, stdin: options.input },
    ),
  );
  return session.id;
}

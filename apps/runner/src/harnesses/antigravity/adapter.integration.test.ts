/**
 * Checks the Antigravity adapter against a real `agy` binary, with a made-up
 * login and no network. The tests skip when there is no `agy`
 * (`HERCULE_AGY_TEST_BINARY`, or `agy` on the `PATH`).
 *
 * Nothing here reaches Google or uses a real account:
 *
 * - The binary is copied once into a temporary folder and only the copy is
 *   run, because `agy` can replace its own binary. The copy is deleted at the
 *   end, and one test checks that it is unchanged.
 * - Every process gets an environment built from nothing: a temporary `HOME`,
 *   a short `PATH`, and proxies on a port nobody listens on.
 * - The token file in a Harness Home is made up. With an expiry in the future
 *   `agy` accepts it without asking Google. With one in the past it would have
 *   to ask Google, and the closed proxy port makes that fail.
 *
 * The tests cover what a caller sees: the probe's result for each state of the
 * login, that every `agy` worker keeps the account's login in its Harness Home,
 * that `agy` does not update itself, the sign-in command, and the removal of a
 * conversation's files.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { AcpHandlers } from "@hercule/acp";
import type { ProbeResult } from "@hercule/protocol";
import { PROBE_DEADLINE } from "../probe";
import { UUID_PATTERN } from "../session-files";
import { makeLogins } from "../login";
import { runProcess, spawnAgy, spawnLogin } from "../process";
import type { HarnessRunnerContext } from "../index";
import { makeAntigravityAdapter } from "./adapter";
import { findAgyTestBinary } from "./agy-binary.testing";
import { buildLoginCommand, openSignedInAgy, readAgyVersion, type AgySpawn } from "./agy";
import { buildContext } from "./fake-agy.testing";
import { APP_DATA_DIR, deleteSessionFiles } from "./harness-home";
import { makeProbe } from "./probe";

const pinnedBinary = findAgyTestBinary();

const FILE_STORAGE_LINE = "Using file-based token storage because SSH session detected";
const UPDATE_LINE = "Spawned background update process";

/** A closed port, so that no request ever leaves the machine. */
const CLOSED_PROXY = "http://127.0.0.1:9";

const roots: Array<string> = [];

/** Makes every file and folder below `path` writable by the owner. `agy` creates some with narrower modes. */
const makeTreeWritable = (path: string): void => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) makeTreeWritable(join(path, name));
    }
  } catch {
    // What cannot be changed is removed or reported by the `rmSync` that follows.
  }
};

const removeTree = (path: string): void => {
  makeTreeWritable(path);
  rmSync(path, { recursive: true, force: true });
};

const makeTempFolder = (label: string): string => {
  const folder = mkdtempSync(join(tmpdir(), `hercule-agy-${label}-`));
  roots.push(folder);
  return folder;
};

afterEach(() => {
  // The binary's own folder lives until `afterAll`.
  for (const root of roots.splice(0)) {
    if (root !== binaryFolder) removeTree(root);
  }
});

let binaryFolder = "";
let binary = "";

beforeAll(() => {
  if (pinnedBinary === undefined) return;
  binaryFolder = mkdtempSync(join(tmpdir(), "hercule-agy-binary-"));
  binary = join(binaryFolder, "agy");
  copyFileSync(pinnedBinary, binary);
  chmodSync(binary, 0o755);
}, 60_000);

afterAll(() => {
  if (binaryFolder !== "") removeTree(binaryFolder);
});

/** The environment of every process: nothing of the developer's own, and no way to the network. */
const buildTestEnv = (home: string): Record<string, string> => ({
  HOME: home,
  PATH: "/usr/bin:/bin",
  https_proxy: CLOSED_PROXY,
  http_proxy: CLOSED_PROXY,
  HTTPS_PROXY: CLOSED_PROXY,
  HTTP_PROXY: CLOSED_PROXY,
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
});

interface Account {
  /** The `HOME` of the processes. */
  readonly userHome: string;
  readonly ctx: HarnessRunnerContext;
}

/** Makes the folders of one account: a `HOME` and a Harness Home, both empty. */
const makeAccount = (envOverrides: Record<string, string> = {}): Account => {
  const userHome = makeTempFolder("home");
  const harnessHome = makeTempFolder("harness-home");
  return {
    userHome,
    ctx: {
      ...buildContext(harnessHome, binary),
      env: { ...buildTestEnv(userHome), ...envOverrides },
    },
  };
};

const tokenPath = (home: string): string => join(home, APP_DATA_DIR, "antigravity-oauth-token");

/** Writes a token file with an expiry `offsetMs` from now. */
const writeMadeUpToken = (home: string, offsetMs: number): void => {
  mkdirSync(join(home, APP_DATA_DIR), { recursive: true });
  writeFileSync(
    tokenPath(home),
    JSON.stringify({
      token: {
        access_token: "ya29.fake",
        token_type: "Bearer",
        refresh_token: "1//fake",
        expiry: new Date(Date.now() + offsetMs).toISOString(),
      },
      auth_method: "consumer",
      id_token_email: "nobody@example.com",
    }),
    { mode: 0o600 },
  );
};

const YEAR_MS = 365 * 24 * 3600 * 1000;
const writeUnexpiredToken = (home: string): void => writeMadeUpToken(home, 10 * YEAR_MS);
const writeExpiredToken = (home: string): void => writeMadeUpToken(home, -3600 * 1000);

/** Lists every file and folder below `folder`, sorted. Empty when it does not exist. */
const listTree = (folder: string): ReadonlyArray<string> =>
  existsSync(folder) ? readdirSync(folder, { recursive: true, encoding: "utf8" }).sort() : [];

interface SpawnedAgy {
  readonly command: ReadonlyArray<string>;
}

/**
 * Wraps the real spawn so a test sees each command. `modifyEnv` can change the
 * environment of the process, to play an `agy` that ignores a variable.
 */
const buildRecordingSpawn = (
  modifyEnv: (env: Record<string, string | undefined>) => void = () => undefined,
): { readonly spawn: AgySpawn; readonly spawned: Array<SpawnedAgy> } => {
  const spawned: Array<SpawnedAgy> = [];
  const spawn: AgySpawn = (command, env, cwd) => {
    spawned.push({ command });
    const changed = { ...env };
    modifyEnv(changed);
    return spawnAgy(command, changed, cwd);
  };
  return { spawn, spawned };
};

const ignoringHandlers: AcpHandlers = {
  onSessionUpdate: () => undefined,
  onApprovalRequest: () => Effect.succeed({ outcome: "cancelled" }),
  onElicitation: () => Effect.succeed({ action: "cancel" }),
  onUnhandledMessage: () => undefined,
};

/** Returns the id in the probe's conversation file, or undefined when the file is missing. */
const readProbeConversationId = (home: string): string | undefined => {
  const path = join(home, "hercule-probe-conversation");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
};

/** Lists the database files in `conversations/`, without the `-wal` and `-shm` files. */
const listConversationDatabases = (home: string): ReadonlyArray<string> =>
  listTree(join(home, APP_DATA_DIR, "conversations")).filter((name) => name.endsWith(".db"));

/** Returns the text of every log file of an `agy` worker (`agy.log.<pid>`) in `folder`. */
const readWorkerLogs = (folder: string): ReadonlyArray<string> =>
  readdirSync(folder)
    .filter((name) => /^agy\.log\.\d+$/.test(name))
    .map((name) => readFileSync(join(folder, name), "utf8"));

const readLogFolder = (command: ReadonlyArray<string>): string =>
  dirname(command[command.indexOf("--log-file") + 1]!);

const probeAccount = (account: Account): Promise<ProbeResult> =>
  Effect.runPromise(makeProbe({ spawn: spawnAgy, run: runProcess })(account.ctx, binary));

/** Returns the text of every regular file below `folder` that is small enough to be a log. */
const readFilesBelow = (folder: string): ReadonlyArray<string> =>
  listTree(folder).flatMap((name) => {
    const path = join(folder, name);
    const stat = lstatSync(path);
    return stat.isFile() && stat.size < 10 * 1024 * 1024 ? [readFileSync(path, "latin1")] : [];
  });

const hashBinary = (path: string): string =>
  new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(pinnedBinary === undefined)("a real agy with a made-up login", () => {
  it("reports a bare version and writes nothing into HOME", async () => {
    const account = makeAccount();

    const version = await Effect.runPromise(readAgyVersion(runProcess, account.ctx, binary));

    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(listTree(account.userHome)).toEqual([]);
    expect(listTree(account.ctx.home)).toEqual([]);
  }, 30_000);

  it("probes a home with no token file as unauthenticated and starts no session process", async () => {
    const account = makeAccount();
    const { spawn, spawned } = buildRecordingSpawn();

    const probed = await Effect.runPromise(
      makeProbe({ spawn, run: runProcess })(account.ctx, binary),
    );

    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.harnessVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(spawned).toEqual([]);
  }, 30_000);

  it("probes an expired token with no network as an error about the network, not as signed out", async () => {
    const account = makeAccount();
    writeExpiredToken(account.ctx.home);

    const probed = await probeAccount(account);

    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message).toContain("could not reach Google");
    expect(probed.models).toEqual([]);
  }, 30_000);

  it("probes an unexpired token with no network as an error, and the next probe resumes the same conversation", async () => {
    const account = makeAccount();
    writeUnexpiredToken(account.ctx.home);
    const home = account.ctx.home;
    const appData = join(home, APP_DATA_DIR);
    const startedAt = Date.now();

    const first = await probeAccount(account);

    expect(Date.now() - startedAt).toBeLessThan(Duration.toMillis(PROBE_DEADLINE) / 2);
    // Offline, `agy` lists no models and gives no plan.
    expect(first.auth.status).toBe("error");
    expect(first.auth.message).toContain("listed no models");
    expect(first.models).toEqual([]);
    const conversationId = readProbeConversationId(home);
    expect(conversationId).toMatch(UUID_PATTERN);
    const implicitAfterFirst = listTree(join(appData, "implicit"));
    // The files the check compares below exist, so a second conversation would show.
    expect(implicitAfterFirst.length).toBeGreaterThan(0);
    expect(listConversationDatabases(home)).toEqual([`${conversationId}.db`]);

    const second = await probeAccount(account);

    expect(second.auth.status).toBe("error");
    expect(second.auth.message).toContain("listed no models");
    // The second probe resumed the stored conversation: no second one, and
    // nothing new in the files `agy` shares between conversations. The rows
    // of its summary database cannot be counted without a SQLite reader, so
    // the conversation files and `implicit/` stand for them.
    expect(readProbeConversationId(home)).toBe(conversationId);
    expect(listConversationDatabases(home)).toEqual([`${conversationId}.db`]);
    expect(readdirSync(join(appData, "brain"))).toEqual([conversationId]);
    expect(listTree(join(appData, "implicit"))).toEqual(implicitAfterFirst);
    // The probe leaves no scratch folder and no log of `agy` in the Harness Home.
    expect(readdirSync(home).filter((name) => name.startsWith("hercule-scratch-"))).toEqual([]);
    expect(existsSync(join(home, "log"))).toBe(false);
    expect(existsSync(join(appData, "log"))).toBe(false);
  }, 60_000);

  it("makes a new conversation and stores its id when the stored one has lost its files", async () => {
    const account = makeAccount();
    writeUnexpiredToken(account.ctx.home);
    const home = account.ctx.home;
    await probeAccount(account);
    const lostId = readProbeConversationId(home)!;
    await Effect.runPromise(deleteSessionFiles(home, lostId));
    expect(listConversationDatabases(home)).toEqual([]);

    const probed = await probeAccount(account);

    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message).toContain("listed no models");
    const newId = readProbeConversationId(home);
    expect(newId).toMatch(UUID_PATTERN);
    expect(newId).not.toBe(lostId);
    expect(listConversationDatabases(home)).toEqual([`${newId}.db`]);
  }, 60_000);

  it("probes a token file that is not JSON as unauthenticated", async () => {
    const account = makeAccount();
    mkdirSync(join(account.ctx.home, APP_DATA_DIR), { recursive: true });
    writeFileSync(tokenPath(account.ctx.home), "this is not json", { mode: 0o600 });

    const probed = await probeAccount(account);

    expect(probed.auth.status).toBe("unauthenticated");
  }, 30_000);

  it("opens a conversation, and every worker keeps the login in the Harness Home", async () => {
    const account = makeAccount();
    writeUnexpiredToken(account.ctx.home);
    const { spawn, spawned } = buildRecordingSpawn();

    const logs = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = makeTempFolder("cwd");
          const { connection } = yield* openSignedInAgy(spawn, account.ctx, binary, {
            cwd,
            handlers: ignoringHandlers,
          });
          yield* connection.newSession({ cwd, mcpServers: [] });
          // The log folder is removed with the scope, so it is read here.
          return readWorkerLogs(readLogFolder(spawned[0]!.command));
        }),
      ),
    );

    expect(spawned).toHaveLength(1);
    // One worker answers `authenticate` and one more is started for `session/new`.
    expect(logs.length).toBeGreaterThanOrEqual(2);
    for (const log of logs) expect(log).toContain(FILE_STORAGE_LINE);
  }, 30_000);

  // Skipped on macOS: without the variable `agy` there reads the machine's
  // real keychain, which this test must never touch.
  it.skipIf(process.platform === "darwin")(
    "refuses an agy that does not honour the variable that keeps the login in the Harness Home",
    async () => {
      const account = makeAccount();
      writeUnexpiredToken(account.ctx.home);
      const { spawn } = buildRecordingSpawn((env) => {
        delete env["SSH_CONNECTION"];
      });

      const error = await Effect.runPromise(
        Effect.flip(
          Effect.scoped(
            openSignedInAgy(spawn, account.ctx, binary, {
              cwd: makeTempFolder("cwd"),
              handlers: ignoringHandlers,
            }),
          ),
        ),
      );

      expect(error.message).toContain("but not with a login of this account.");
    },
    30_000,
  );

  it("does not update itself with the adapter's environment, and does without it", async () => {
    const account = makeAccount();
    const adapterEnv = buildLoginCommand(account.ctx, binary).env;
    const withoutGuard = { ...adapterEnv };
    delete withoutGuard["AGY_CLI_DISABLE_AUTO_UPDATE"];
    const hashBefore = hashBinary(binary);
    const runModels = (env: Record<string, string | undefined>): Promise<unknown> =>
      Effect.runPromise(runProcess([binary, "models"], env));
    const waitForUpdateLine = async (limitMs: number): Promise<boolean> => {
      const until = Date.now() + limitMs;
      while (Date.now() < until) {
        if (readFilesBelow(account.userHome).some((text) => text.includes(UPDATE_LINE)))
          return true;
        await sleep(250);
      }
      return false;
    };

    await runModels(adapterEnv);
    // An update starts a moment after the command, so give it time to show.
    const updatedWithGuard = await waitForUpdateLine(4000);
    const hashAfterGuarded = hashBinary(binary);

    await runModels(withoutGuard);
    // Control: the same command does start the updater when the variable is
    // missing, which shows that the check above can fail.
    const updatedWithoutGuard = await waitForUpdateLine(10_000);
    const hashAfterControl = hashBinary(binary);

    expect(updatedWithGuard).toBe(false);
    expect(updatedWithoutGuard).toBe(true);
    expect(hashAfterGuarded).toBe(hashBefore);
    expect(hashAfterControl).toBe(hashBefore);
  }, 60_000);

  it("starts the sign-in with a link, opens no browser, and reports a refused code", async () => {
    // Stubs of the commands a program uses to open a browser, first on the
    // `PATH`. Each leaves a file behind when it is run.
    const stubs = makeTempFolder("browser-stubs");
    const opened = join(stubs, "opened");
    for (const name of ["xdg-open", "x-www-browser", "sensible-browser", "gio", "gnome-open"]) {
      writeFileSync(join(stubs, name), `#!/bin/sh\necho ${name} >> '${opened}'\n`, {
        mode: 0o755,
      });
    }
    const account = makeAccount({ PATH: `${stubs}:/usr/bin:/bin` });
    const logins = makeLogins(spawnLogin);
    const adapter = makeAntigravityAdapter({ spawn: spawnAgy, run: runProcess });

    try {
      const started = await Effect.runPromise(
        logins.start("request-1", "account-1", adapter, account.ctx, "sign-in"),
      );
      expect(started._tag).toBe("loginUrl");
      expect("url" in started ? started.url : "").toMatch(/^https:\/\//);

      const submitted = await Effect.runPromise(logins.submit("account-1", "not-a-real-code"));

      expect(submitted).toMatchObject({ _tag: "loginResult", ok: false });
      const message = (submitted as { message: string }).message;
      expect(message.startsWith("couldn't log in")).toBe(true);
      expect(message.endsWith("start it again for a new link.")).toBe(true);
      expect(existsSync(opened)).toBe(false);
    } finally {
      await Effect.runPromise(logins.stopAll);
    }
  }, 60_000);

  it("deletes exactly the files of one conversation and leaves another and the shared files", async () => {
    const account = makeAccount();
    writeUnexpiredToken(account.ctx.home);
    const appData = join(account.ctx.home, APP_DATA_DIR);
    const { spawn } = buildRecordingSpawn();
    /** Opens a conversation, closes it, and returns its id once the process has ended. */
    const leaveConversation = (): Promise<string> =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const cwd = makeTempFolder("cwd");
            const { connection } = yield* openSignedInAgy(spawn, account.ctx, binary, {
              cwd,
              handlers: ignoringHandlers,
            });
            const { nativeSessionId } = yield* connection.newSession({ cwd, mcpServers: [] });
            yield* connection.closeSession(nativeSessionId);
            return nativeSessionId;
          }),
        ),
      );

    const second = await leaveConversation();
    const filesWithSecond = listTree(appData);
    const first = await leaveConversation();
    const filesWithBoth = listTree(appData);
    const filesOfFirst = filesWithBoth.filter((name) => name.includes(first));

    await Effect.runPromise(deleteSessionFiles(account.ctx.home, first));

    // Besides these, `agy` leaves a small file in `implicit/` for each new
    // working folder, named with an id that is not the conversation's. Nothing
    // links it to the conversation, so it stays with the shared files.
    // `annotations/<id>.pbtxt` is not covered: `agy` writes it only after a
    // real prompt, which no test without an account can send.
    expect(filesOfFirst).toContain(`conversations/${first}.db`);
    expect(filesOfFirst).toContain(`brain/${first}`);
    expect(filesWithSecond.some((name) => name.includes(second))).toBe(true);
    expect(listTree(appData)).toEqual(filesWithBoth.filter((name) => !name.includes(first)));
  }, 60_000);
});

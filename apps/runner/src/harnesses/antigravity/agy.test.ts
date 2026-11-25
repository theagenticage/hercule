/**
 * Tests how an `agy` process of an account is started and whose login it
 * uses: the command, the working folder and the environment, the sign-in over
 * ACP and how its failures are told apart, the check that the process uses the
 * account's own login, and the cleanup when the scope closes. A fake harness
 * answers over the pipes behind a spawn the test writes, and it writes the
 * worker logs the way `agy` does. The real `agy` is never started.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { AcpError } from "@hercule/acp";
import type { AcpHandlers } from "@hercule/acp";
import {
  answerWith,
  readRecording,
  startFakeHarness,
  type FakeHarness,
  type HarnessScript,
} from "@hercule/acp/testing";
import { AdapterFailed, HarnessLoginMissing, HarnessNotInstalled } from "@hercule/protocol";
import type { AdapterError } from "@hercule/protocol";
import type { HarnessRunnerContext } from "../index";
import type { Run } from "../process";
import { cleanupHomes, createScratchHome, NO_CONTROLLER_UPLOADER, waitUntil } from "../testing";
import {
  buildLoginCommand,
  buildNotSignedIn,
  isSignInRequired,
  openSignedInAgy,
  readAgyVersion,
  type AgySpawn,
} from "./agy";
import { APP_DATA_DIR } from "./harness-home";

afterEach(() => {
  cleanupHomes();
});

const BINARY = "/opt/agy/agy";

/** What a worker of a process that uses the account's own login writes in its log. */
const FILE_STORAGE = 'level=info msg="Using file-based token storage because SSH session detected"';
/** What a worker writes when it kept looking for the login in the keychain. */
const KEYRING = 'level=warn msg="Failed to load stored token from keyring, falling back to file"';
/** What a worker writes when it could not reach Google to check an expired login. */
const NETWORK_ERROR =
  'level=warn msg="token validation failed due to network error (token may still be valid)"';

/** The context of a runner: an environment with variables `agy` must not inherit. */
const buildContext = (
  home: string,
  env: HarnessRunnerContext["env"] = {},
): HarnessRunnerContext => ({
  cwd: null,
  attachmentsDir: null,
  editMarks: null,
  attachmentUploader: NO_CONTROLLER_UPLOADER,
  home,
  binary: BINARY,
  env,
  modelArgument: "{model}",
  credentialVariables: [],
  herculeTool: { orientation: "", skill: "", claudePluginDir: join(home, "claude-plugin") },
});

/** Makes a Harness Home with the token file of a signed-in account. */
const createSignedInHome = (): string => {
  const home = createScratchHome("agy");
  mkdirSync(join(home, APP_DATA_DIR), { recursive: true });
  writeFileSync(join(home, APP_DATA_DIR, "antigravity-oauth-token"), "{}");
  return home;
};

const NO_HANDLERS: AcpHandlers = {
  onSessionUpdate: () => undefined,
  onApprovalRequest: () => Effect.succeed({ outcome: "cancelled" }),
  onElicitation: () => Effect.succeed({ action: "cancel" }),
  onUnhandledMessage: () => undefined,
};

/** A reply of the harness that refuses the call with a JSON-RPC error. */
const refuse =
  (code: number, message: string): HarnessScript =>
  ({ id }) => [{ jsonrpc: "2.0", id, error: { code, message } }];

/** The words `agy` answers `authenticate` with when it has no login it can use. */
const RUN_LOGIN = refuse(
  -32603,
  "No browser is available here (this is a remote (SSH) session). Run `agy acp --login` to sign in.",
);

interface Spawned {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly harness: FakeHarness;
  /** The signals the runner sent, in order. */
  readonly signals: Array<string | undefined>;
  hasExited: boolean;
}

interface FakeAgy {
  readonly spawn: AgySpawn;
  readonly spawns: Array<Spawned>;
}

/**
 * Builds a spawn that starts a fake harness, and writes the logs a real `agy`
 * writes next to the path of `--log-file`: the front process's own log and
 * one log per worker. By default the harness answers from the recording of a
 * signed-in account, and there is one worker that uses file storage.
 */
const buildFakeAgy = (
  options: {
    readonly scripts?: Readonly<Record<string, HarnessScript>>;
    readonly workerLogs?: ReadonlyArray<string>;
    readonly frontLog?: string;
    readonly stderrLines?: ReadonlyArray<string>;
    readonly throws?: unknown;
  } = {},
): FakeAgy => {
  const { scripts = {}, workerLogs = [FILE_STORAGE], frontLog = "", stderrLines = [] } = options;
  const spawns: Array<Spawned> = [];
  const spawn: AgySpawn = (command, env, cwd) => {
    if (options.throws !== undefined) throw options.throws;
    const logFile = command[command.indexOf("--log-file") + 1]!;
    writeFileSync(logFile, frontLog);
    workerLogs.forEach((text, index) => {
      writeFileSync(`${logFile}.${4000 + index}`, text);
    });
    const harness = startFakeHarness({ recording: readRecording("cancel"), scripts });
    const signals: Array<string | undefined> = [];
    const spawned: Spawned = { command, env, cwd, harness, signals, hasExited: false };
    void harness.exited.then(() => {
      spawned.hasExited = true;
    });
    spawns.push(spawned);
    return {
      write: harness.write,
      stdout: harness.stdout,
      stderr: (async function* () {
        yield* stderrLines;
      })(),
      end: harness.end,
      kill: (signal) => {
        signals.push(signal);
        harness.kill();
      },
      exited: harness.exited,
    };
  };
  return { spawn, spawns };
};

/** Runs the effect in a scope that closes when it ends, and returns what it failed with. */
const failureOf = (
  effect: Effect.Effect<unknown, AdapterError, Scope.Scope>,
): Promise<AdapterError> => Effect.runPromise(Effect.scoped(Effect.flip(effect)));

/**
 * Opens `agy` for the account in `home`. The process runs in `options.cwd`,
 * which is a folder that exists unless the test says otherwise.
 */
const open = (
  fake: FakeAgy,
  home: string,
  options: {
    readonly env?: HarnessRunnerContext["env"];
    readonly cwd?: string;
    readonly binary?: string;
  } = {},
) =>
  openSignedInAgy(fake.spawn, buildContext(home, options.env), options.binary ?? BINARY, {
    cwd: options.cwd ?? createScratchHome("agy-work"),
    handlers: NO_HANDLERS,
  });

/** Opens `agy` and returns the plan, closing the scope at the end. */
const openAndReadPlan = (fake: FakeAgy, home: string): Promise<string | undefined> =>
  Effect.runPromise(Effect.scoped(Effect.map(open(fake, home), (signedIn) => signedIn.planLabel)));

/** The folders the runner made in the Harness Home for a process's log. */
const listLogFolders = (home: string): ReadonlyArray<string> =>
  readdirSync(home).filter((name) => name.startsWith("hercule-scratch-"));

describe("a home with no login", () => {
  it("fails as not signed in and spawns nothing", async () => {
    const home = createScratchHome("agy");
    const fake = buildFakeAgy();

    const error = await failureOf(open(fake, home));

    expect(error).toBeInstanceOf(HarnessLoginMissing);
    expect(error.message).toBe("Antigravity is not signed in on this runner.");
    expect(fake.spawns).toHaveLength(0);
    expect(listLogFolders(home)).toEqual([]);
  });
});

describe("how the process is started", () => {
  const RUNNER_ENV = {
    PATH: "/usr/bin",
    HOME: "/home/runner",
    HERCULE_RUNNER: "runner-1",
    GEMINI_API_KEY: "key",
    GOOGLE_APPLICATION_CREDENTIALS: "/etc/google.json",
    GOOGLE_CLOUD_PROJECT: "project",
    AGY_CONFIG: "/etc/agy",
    // The two variables `agy` is given must win over the runner's own.
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    SSH_CONNECTION: "203.0.113.5 5000 203.0.113.9 22",
  };
  const AGY_ENV = {
    PATH: "/usr/bin",
    HOME: "/home/runner",
    HERCULE_RUNNER: "runner-1",
    SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  };

  it("runs the exact command in the working folder, with a log of its own in the Harness Home", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy();
    const cwd = createScratchHome("agy-work");

    await Effect.runPromise(Effect.scoped(open(fake, home, { cwd })));

    const spawned = fake.spawns[0]!;
    expect(fake.spawns).toHaveLength(1);
    expect(spawned.command.slice(0, -1)).toEqual([
      BINARY,
      "acp",
      "--process-per-session",
      "--gemini-dir",
      home,
      "--app-data-dir",
      "antigravity-acp",
      "--log-file",
    ]);
    const logFile = spawned.command.at(-1)!;
    expect(logFile.startsWith(join(home, "hercule-scratch-"))).toBe(true);
    expect(logFile.endsWith("/agy.log")).toBe(true);
    expect(spawned.cwd).toBe(cwd);
  });

  it("keeps the home and the path, drops the runner's own agy settings and credentials, and sets the two variables", async () => {
    const fake = buildFakeAgy();

    await Effect.runPromise(Effect.scoped(open(fake, createSignedInHome(), { env: RUNNER_ENV })));

    expect(fake.spawns[0]!.env).toEqual(AGY_ENV);
  });

  it("gives the login command, the version command and a session the same environment", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy();
    const ctx = buildContext(home, RUNNER_ENV);
    const versionEnvs: Array<Readonly<Record<string, string | undefined>>> = [];
    const run: Run = (_command, env) => {
      versionEnvs.push(env);
      return Effect.succeed({ code: 0, stdout: "1.5.15\n", stderr: "" });
    };

    await Effect.runPromise(
      Effect.scoped(
        openSignedInAgy(fake.spawn, ctx, BINARY, {
          cwd: createScratchHome("agy-work"),
          handlers: NO_HANDLERS,
        }),
      ),
    );
    await Effect.runPromise(readAgyVersion(run, ctx, BINARY));

    expect(buildLoginCommand(ctx, BINARY).env).toEqual(AGY_ENV);
    expect(versionEnvs).toEqual([AGY_ENV]);
    expect(fake.spawns[0]!.env).toEqual(AGY_ENV);
  });
});

describe("the login command", () => {
  it("signs in to the Harness Home with a login that works on plain pipes", () => {
    const command = buildLoginCommand(buildContext("/homes/google-1"), BINARY);

    expect(command.command).toEqual([
      BINARY,
      "acp",
      "--login",
      "--gemini-dir",
      "/homes/google-1",
      "--app-data-dir",
      "antigravity-acp",
    ]);
    expect(command.terminal).toBeUndefined();
  });

  it("recognises the line where agy refuses a code, and no other line", () => {
    const { refusal } = buildLoginCommand(buildContext("/homes/google-1"), BINARY);

    expect(refusal?.test(`couldn't log in: token exchange failed: oauth2: "invalid_grant"`)).toBe(
      true,
    );
    expect(refusal?.test("Logged in as someone@example.com.")).toBe(false);
  });
});

describe("the version", () => {
  const ranWith =
    (code: number, stdout: string): Run =>
    () =>
      Effect.succeed({ code, stdout, stderr: "" });
  const read = (run: Run) =>
    Effect.runPromise(readAgyVersion(run, buildContext("/homes/google-1"), BINARY));

  it("is the bare version agy prints", async () => {
    let command: ReadonlyArray<string> = [];
    const version = await read((given, env) => {
      command = given;
      return ranWith(0, "1.5.15\n")(given, env);
    });

    expect(version).toBe("1.5.15");
    expect(command).toEqual([BINARY, "--version"]);
  });

  it("is null when the command fails or prints nothing", async () => {
    expect(await read(ranWith(1, "1.5.15\n"))).toBeNull();
    expect(await read(ranWith(0, "  \n"))).toBeNull();
  });
});

describe("the plan", () => {
  it("is the tier name in the reply to authenticate", async () => {
    const home = createSignedInHome();

    expect(await openAndReadPlan(buildFakeAgy(), home)).toBe("Antigravity Starter Quota");
  });

  it.each([
    ["no tier", {}],
    ["a tier that is not an object", { _meta: { antigravity: { tier: "free" } } }],
    ["a tier with no name", { _meta: { antigravity: { tier: { id: "free-tier" } } } }],
    ["an empty name", { _meta: { antigravity: { tier: { name: "  " } } } }],
  ])("is undefined for a reply with %s", async (_what, reply) => {
    const fake = buildFakeAgy({ scripts: { authenticate: answerWith(reply) } });

    expect(await openAndReadPlan(fake, createSignedInHome())).toBeUndefined();
  });
});

describe("a refused authenticate", () => {
  it("is not signed in when agy asks for the login and its log has no network error", async () => {
    const fake = buildFakeAgy({
      scripts: { authenticate: RUN_LOGIN },
      workerLogs: [`${FILE_STORAGE}\n`],
    });

    const error = await failureOf(open(fake, createSignedInHome()));

    expect(error).toEqual(buildNotSignedIn());
  });

  it("is a network failure when a worker's log holds the network error", async () => {
    const fake = buildFakeAgy({
      scripts: { authenticate: RUN_LOGIN },
      workerLogs: [`${FILE_STORAGE}\n${NETWORK_ERROR}\n`],
    });

    const error = await failureOf(open(fake, createSignedInHome()));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toBe(
      "Antigravity could not reach Google to check the sign-in of this account. Check the network of this runner.",
    );
  });

  it("does not read the network error from the log of the front process", async () => {
    const fake = buildFakeAgy({
      scripts: { authenticate: RUN_LOGIN },
      workerLogs: [FILE_STORAGE],
      frontLog: NETWORK_ERROR,
    });

    expect(await failureOf(open(fake, createSignedInHome()))).toBeInstanceOf(HarnessLoginMissing);
  });

  it("fails with agy's own words when it is any other refusal", async () => {
    const fake = buildFakeAgy({
      scripts: { authenticate: refuse(-32603, "quota service unavailable") },
    });

    const error = await failureOf(open(fake, createSignedInHome()));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("quota service unavailable");
  });
});

describe("the sign that the process uses the account's own login", () => {
  const NOT_THIS_ACCOUNT = "Antigravity is signed in, but not with a login of this account.";

  it("passes when every worker log has it", async () => {
    const fake = buildFakeAgy({ workerLogs: [FILE_STORAGE, `${FILE_STORAGE}\nmore`] });

    expect(await openAndReadPlan(fake, createSignedInHome())).toBe("Antigravity Starter Quota");
  });

  it.each([
    ["there is no worker log", { workerLogs: [] }],
    ["the only worker log lacks it", { workerLogs: [KEYRING] }],
    ["one of two worker logs lacks it", { workerLogs: [FILE_STORAGE, KEYRING] }],
    ["only the log of the front process has it", { workerLogs: [], frontLog: FILE_STORAGE }],
    [
      "the front process has it and the only worker does not",
      { workerLogs: [KEYRING], frontLog: FILE_STORAGE },
    ],
  ])("fails when %s", async (_what, logs) => {
    const error = await failureOf(open(buildFakeAgy(logs), createSignedInHome()));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toBe(NOT_THIS_ACCOUNT);
  });
});

describe("a process that cannot be started", () => {
  it("is not installed when the binary does not exist", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy({
      throws: Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
    });

    const error = await failureOf(open(fake, home));

    expect(error).toBeInstanceOf(HarnessNotInstalled);
    expect(error.message).toBe("Antigravity is not installed on this runner.");
    expect(listLogFolders(home)).toEqual([]);
  });

  it("is installed but cannot be run for any other reason", async () => {
    const fake = buildFakeAgy({ throws: new Error("permission denied") });

    const error = await failureOf(open(fake, createSignedInHome()));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("installed on this runner but could not be run");
    expect(error.message).toContain("permission denied");
  });

  it("is installed but cannot be run when the working folder is missing too", async () => {
    // With the folder gone, ENOENT may be about the folder, so it does not show the binary is missing.
    const fake = buildFakeAgy({
      throws: Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
    });

    const error = await failureOf(
      open(fake, createSignedInHome(), { cwd: "/nonexistent/work-folder" }),
    );

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("could not be run");
  });

  it("names what the process wrote on stderr when it closes its output during initialize", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy({
      scripts: {
        initialize: (_call, harness) => {
          harness.end();
          return [];
        },
      },
      stderrLines: ["", "panic: could not open the database", "goroutine 1 [running]:"],
    });

    const error = await failureOf(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("Antigravity could not be started on this runner");
    expect(error.message).toContain("panic: could not open the database goroutine 1 [running]:");
    expect(fake.spawns[0]!.hasExited).toBe(true);
    expect(listLogFolders(home)).toEqual([]);
  });
});

describe("closing the scope", () => {
  it("closes the connection, stops the process and waits for its exit, then removes the log folder", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy();
    const scope = Effect.runSync(Scope.make());

    const signedIn = await Effect.runPromise(
      Effect.provideService(open(fake, home), Scope.Scope, scope),
    );

    const spawned = fake.spawns[0]!;
    expect(spawned.signals).toEqual([]);
    expect(spawned.hasExited).toBe(false);
    expect(listLogFolders(home)).toHaveLength(1);

    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(spawned.signals).toEqual(["SIGTERM"]);
    expect(spawned.hasExited).toBe(true);
    expect(listLogFolders(home)).toEqual([]);
    expect(await Effect.runPromise(signedIn.connection.awaitClosed)).toBeInstanceOf(AcpError);
  });

  it("does the same when the start fails", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy({ workerLogs: [] });

    await failureOf(open(fake, home));

    expect(fake.spawns[0]!.signals).toEqual(["SIGTERM"]);
    expect(fake.spawns[0]!.hasExited).toBe(true);
    expect(listLogFolders(home)).toEqual([]);
  });

  it("does the same when the start is interrupted", async () => {
    const home = createSignedInHome();
    // agy never answers authenticate.
    const fake = buildFakeAgy({ scripts: { authenticate: () => [] } });

    const fiber = Effect.runFork(Effect.scoped(open(fake, home)));
    await waitUntil(
      "received authenticate",
      () =>
        fake.spawns[0]?.harness.received.some((message) => message.method === "authenticate") ===
        true,
    );
    expect(listLogFolders(home)).toHaveLength(1);
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(fake.spawns[0]!.signals).toEqual(["SIGTERM"]);
    expect(fake.spawns[0]!.hasExited).toBe(true);
    expect(listLogFolders(home)).toEqual([]);
  });
});

describe("isSignInRequired", () => {
  const refused = (code: number, harnessMessage: string): AcpError =>
    new AcpError({ reason: "refused", message: "The call failed.", code, harnessMessage });

  it("is true for the -32000 that session/new answers when the account is not signed in", () => {
    expect(isSignInRequired(refused(-32000, "Authentication required"))).toBe(true);
  });

  it("is false for another refusal, and for a failure that is not a refusal", () => {
    expect(isSignInRequired(refused(-32602, "Unknown model ID: x"))).toBe(false);
    expect(isSignInRequired(refused(-32000, "Something else broke"))).toBe(false);
    expect(isSignInRequired(refused(-32603, "Authentication required"))).toBe(false);
    expect(
      isSignInRequired(
        new AcpError({ reason: "closed", message: "The harness closed its output." }),
      ),
    ).toBe(false);
  });
});

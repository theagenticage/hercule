/**
 * Tests how an `agy` process of an account is started and whose login it
 * uses: the command, the working folder and the environment, the sign-in over
 * ACP and how its failures are told apart, the check that the process uses the
 * account's own login, and the cleanup when the scope closes. A fake harness
 * (`fake-agy.testing.ts`) answers over the pipes behind a spawn, and it writes
 * the worker logs the way `agy` does. The real `agy` is never started.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { AcpError } from "@hercule/acp";
import { answerWith } from "@hercule/acp/testing";
import { AdapterFailed, HarnessLoginMissing, HarnessNotInstalled } from "@hercule/protocol";
import type { AdapterError, ModelDescriptor } from "@hercule/protocol";
import type { Run } from "../process";
import { cleanupHomes, createScratchHome, settle, waitUntil } from "../testing";
import { buildLoginCommand, checkAccountUsable, openSignedInAgy, readAgyVersion } from "./agy";
import {
  BINARY,
  FILE_STORAGE_LINE,
  KEYRING_LINE,
  NETWORK_ERROR_LINE,
  NO_HANDLERS,
  PLAN_LABEL,
  buildContext,
  buildFakeAgy,
  createSignedInHome,
  refuse,
  type FakeAgy,
  type FakeAgyOptions,
} from "./fake-agy.testing";

afterEach(() => {
  cleanupHomes();
});

/** The words `agy` answers `authenticate` with when it has no login it can use. */
const RUN_LOGIN_TEXT =
  "No browser is available here (this is a remote (SSH) session). Run `agy acp --login` to sign in.";
const RUN_LOGIN = refuse(-32603, RUN_LOGIN_TEXT);

/** A fake `agy` for a new signed-in Harness Home, and the home. */
const setUp = (options: FakeAgyOptions = {}): { readonly home: string; readonly fake: FakeAgy } => {
  const home = createSignedInHome();
  return { home, fake: buildFakeAgy(home, options) };
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
  options: { readonly env?: Record<string, string>; readonly cwd?: string } = {},
) =>
  openSignedInAgy(fake.spawn, buildContext(home, BINARY, options.env), BINARY, {
    cwd: options.cwd ?? createScratchHome("agy-work"),
    handlers: NO_HANDLERS,
  });

/** Opens `agy` and returns the plan, closing the scope at the end. */
const openAndReadPlan = (fake: FakeAgy, home: string): Promise<string | undefined> =>
  Effect.runPromise(Effect.scoped(Effect.map(open(fake, home), (signedIn) => signedIn.planLabel)));

/** The folders the runner made in the Harness Home for a process's log. */
const listLogFolders = (home: string): ReadonlyArray<string> =>
  readdirSync(home).filter((name) => name.startsWith("hercule-log-"));

describe("a home with no login", () => {
  it("fails as not signed in and spawns nothing", async () => {
    const home = createScratchHome("agy");
    const fake = buildFakeAgy(home);

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
    const { home, fake } = setUp();
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
    expect(logFile.startsWith(join(home, "hercule-log-"))).toBe(true);
    expect(logFile.endsWith("/agy.log")).toBe(true);
    expect(spawned.cwd).toBe(cwd);
  });

  it("gives the sign-in, the version command and a session the same environment: the runner's own agy settings and credentials dropped, the two variables set", async () => {
    const { home, fake } = setUp();
    const ctx = buildContext(home, BINARY, RUNNER_ENV);
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
    const login = buildLoginCommand(ctx, BINARY);

    expect(fake.spawns[0]!.env).toEqual(AGY_ENV);
    expect(versionEnvs).toEqual([AGY_ENV]);
    expect(login.env).toEqual(AGY_ENV);
  });
});

describe("the login command", () => {
  it("signs in to the Harness Home on plain pipes, logging to a folder of its own that the login removes", () => {
    const home = createScratchHome("agy");

    const login = buildLoginCommand(buildContext(home), BINARY);

    const folder = login.scratchFolder!;
    expect(dirname(folder)).toBe(home);
    expect(folder.slice(home.length + 1).startsWith("hercule-log-")).toBe(true);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(login.command).toEqual([
      BINARY,
      "acp",
      "--login",
      "--gemini-dir",
      home,
      "--app-data-dir",
      "antigravity-acp",
      "--log-file",
      join(folder, "agy.log"),
    ]);
    expect(login.terminal).toBeUndefined();
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
    const { home, fake } = setUp();

    expect(await openAndReadPlan(fake, home)).toBe(PLAN_LABEL);
  });

  it.each([
    ["no tier", {}],
    ["a tier that is not an object", { _meta: { antigravity: { tier: "free" } } }],
    ["a tier with no name", { _meta: { antigravity: { tier: { id: "free-tier" } } } }],
    ["an empty name", { _meta: { antigravity: { tier: { name: "  " } } } }],
  ])("is undefined for a reply with %s", async (_what, reply) => {
    const { home, fake } = setUp({ scripts: { authenticate: answerWith(reply) } });

    expect(await openAndReadPlan(fake, home)).toBeUndefined();
  });
});

describe("checkAccountUsable", () => {
  const model: ModelDescriptor = {
    slug: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    imageInput: null,
    options: [],
  };
  const failureOf = (plan: string | undefined, models: ReadonlyArray<ModelDescriptor>) =>
    Option.getOrUndefined(Result.getFailure(checkAccountUsable(plan, models)));

  it("returns the plan of an account that has a plan and models", () => {
    expect(checkAccountUsable(PLAN_LABEL, [model])).toEqual(Result.succeed(PLAN_LABEL));
  });

  it("says Google holds an account that lists models but has no plan, and that signing in again does not help", () => {
    const failure = failureOf(undefined, [model]);

    expect(failure).toBeInstanceOf(AdapterFailed);
    expect(failure?.message).toBe(
      'Google is holding this account until it is verified ("Verify your account to continue."), so Antigravity cannot use it. Sign in to this Google account in a browser and follow Google\'s steps; Google explains them at https://support.google.com/accounts?p=al_alert. The sign-in in Hercule is fine and need not be repeated.',
    );
  });

  it("says the runner may be offline when no model is listed, plan or not", () => {
    const message =
      "Antigravity listed no models for this account. The runner may be offline, or Google may have refused the sign-in.";

    expect(failureOf(PLAN_LABEL, [])?.message).toBe(message);
    expect(failureOf(undefined, [])?.message).toBe(message);
  });
});

describe("a refused authenticate", () => {
  it("is not signed in when agy asks for the login and its log has no network error", async () => {
    const { home, fake } = setUp({ scripts: { authenticate: RUN_LOGIN } });

    const error = await failureOf(open(fake, home));

    expect(error).toBeInstanceOf(HarnessLoginMissing);
    expect(error.message).toBe("Antigravity is not signed in on this runner.");
  });

  it("is a network failure when a worker's log holds the network error", async () => {
    const { home, fake } = setUp({
      scripts: { authenticate: RUN_LOGIN },
      workerLogs: [`${FILE_STORAGE_LINE}\n${NETWORK_ERROR_LINE}\n`],
    });

    const error = await failureOf(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toBe(
      "Antigravity could not reach Google to check the sign-in of this account. Check the network of this runner.",
    );
  });

  it("does not read the network error from the log of the front process", async () => {
    const { home, fake } = setUp({
      scripts: { authenticate: RUN_LOGIN },
      frontLog: NETWORK_ERROR_LINE,
    });

    expect(await failureOf(open(fake, home))).toBeInstanceOf(HarnessLoginMissing);
  });

  it("cannot tell why when there is no worker log at all, and does not call it signed out", async () => {
    const { home, fake } = setUp({ scripts: { authenticate: RUN_LOGIN }, workerLogs: [] });

    const error = await failureOf(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toBe(
      "Could not tell why Antigravity refused the sign-in of this account.",
    );
  });

  it.each([
    ["another error code with the same words", refuse(-32000, RUN_LOGIN_TEXT)],
    ["the same code with other words", refuse(-32603, "quota service unavailable")],
  ])("is a start failure with agy's own words for %s", async (_what, script) => {
    const { home, fake } = setUp({ scripts: { authenticate: script } });

    const error = await failureOf(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("Antigravity could not be started on this runner");
  });
});

describe("the sign that the process uses the account's own login", () => {
  const NOT_THIS_ACCOUNT = "Antigravity is signed in, but not with a login of this account.";

  it("passes when every worker log has it", async () => {
    const { home, fake } = setUp({
      workerLogs: [FILE_STORAGE_LINE, `${FILE_STORAGE_LINE}\nmore`],
    });

    expect(await openAndReadPlan(fake, home)).toBe(PLAN_LABEL);
  });

  it.each([
    ["there is no worker log", { workerLogs: [] }],
    ["the only worker log lacks it", { workerLogs: [KEYRING_LINE] }],
    ["one of two worker logs lacks it", { workerLogs: [FILE_STORAGE_LINE, KEYRING_LINE] }],
    ["only the log of the front process has it", { workerLogs: [], frontLog: FILE_STORAGE_LINE }],
    [
      "the front process has it and the only worker does not",
      { workerLogs: [KEYRING_LINE], frontLog: FILE_STORAGE_LINE },
    ],
  ])("fails when %s", async (_what, logs) => {
    const { home, fake } = setUp(logs);

    const error = await failureOf(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toBe(NOT_THIS_ACCOUNT);
  });

  it("can be checked again later, and fails when a worker started since then lacks it", async () => {
    const { home, fake } = setUp();

    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const signedIn = yield* open(fake, home);
          yield* signedIn.confirmOwnLogin;
          // A worker started by session/new that kept looking for the keychain.
          writeFileSync(`${fake.spawns[0]!.command.at(-1)!}.4001`, KEYRING_LINE);
          return yield* Effect.flip(signedIn.confirmOwnLogin);
        }),
      ),
    );

    expect(failure).toBeInstanceOf(AdapterFailed);
    expect(failure.message).toBe(NOT_THIS_ACCOUNT);
  });
});

describe("a process that cannot be started", () => {
  it("is not installed when the binary does not exist", async () => {
    const { home, fake } = setUp({
      throws: Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
    });

    const error = await failureOf(open(fake, home));

    expect(error).toBeInstanceOf(HarnessNotInstalled);
    expect(error.message).toBe("Antigravity is not installed on this runner.");
    expect(listLogFolders(home)).toEqual([]);
  });

  it("is a start failure with the reason for any other error", async () => {
    const { home, fake } = setUp({ throws: new Error("permission denied") });

    const error = await failureOf(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toBe(
      "Antigravity could not be started on this runner: permission denied.",
    );
  });

  it("is not called not installed when the working folder is missing too", async () => {
    // With the folder gone, ENOENT may be about the folder, so it does not show the binary is missing.
    const { home, fake } = setUp({
      throws: Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
    });

    const error = await failureOf(open(fake, home, { cwd: "/nonexistent/work-folder" }));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("could not be started");
  });

  it("names what the process wrote on stderr when it closes its output during initialize", async () => {
    const { home, fake } = setUp({
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

  it("does not wait for good for a stderr that a descendant of the process holds open", async () => {
    const { home, fake } = setUp({
      scripts: {
        initialize: (_call, harness) => {
          harness.end();
          return [];
        },
      },
      stderrLines: ["panic: could not open the database"],
      holdStderrOpen: true,
    });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const opening = yield* Effect.forkChild(Effect.scoped(Effect.flip(open(fake, home))));
        yield* Effect.promise(() => waitUntil("exited", () => fake.spawns[0]?.hasExited === true));
        yield* Effect.promise(settle);
        yield* TestClock.adjust(Duration.seconds(1));
        return yield* Fiber.join(opening);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("panic: could not open the database");
  });
});

describe("closing the scope", () => {
  it("closes the connection, stops the process and waits for its exit, then removes the log folder", async () => {
    const { home, fake } = setUp();
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
    const { home, fake } = setUp({ workerLogs: [] });

    await failureOf(open(fake, home));

    expect(fake.spawns[0]!.signals).toEqual(["SIGTERM"]);
    expect(fake.spawns[0]!.hasExited).toBe(true);
    expect(listLogFolders(home)).toEqual([]);
  });

  it("does the same when the start is interrupted", async () => {
    // agy never answers authenticate.
    const { home, fake } = setUp({ scripts: { authenticate: () => [] } });

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

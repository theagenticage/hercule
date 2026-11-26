/**
 * Tests how an `agy` process of an account is started and whose login it
 * uses: the command, the working folder and the environment, the sign-in over
 * ACP and how its failures are told apart, the check that the process uses the
 * account's own login, and the cleanup when the scope closes. A fake harness
 * (`fake-agy.testing.ts`) answers over the pipes behind a spawn, and it writes
 * the worker logs the way `agy` does. The real `agy` is never started.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import type { NewSessionRequest } from "@hercule/acp";
import { answerWith } from "@hercule/acp/testing";
import { buildAdapterFailed } from "../adapter-error-builders";
import {
  AdapterFailed,
  HarnessLoginMissing,
  HarnessNotInstalled,
  ResumeTranscriptMissing,
} from "@hercule/protocol";
import { ANTIGRAVITY_VERSION } from "@hercule/home/version";
import type { AdapterError, ModelDescriptor } from "@hercule/protocol";
import type { Run } from "../process";
import { cleanupHomes, createScratchHome, settle, waitUntil } from "../testing";
import {
  buildLoginCommand,
  checkAccountUsable,
  openSignedInAgy,
  readAgyVersion,
  type AgyPurpose,
  type SignedInAgy,
} from "./agy";
import {
  BINARY,
  CONVERSATION,
  FILE_STORAGE_LINE,
  HELD_BY_GOOGLE_LINE,
  KEYRING_LINE,
  NETWORK_ERROR_LINE,
  NO_HANDLERS,
  PLAN_LABEL,
  buildContext,
  buildFakeAgy,
  createConversationFiles,
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
const runAndReadFailure = (
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
    readonly env?: Record<string, string>;
    readonly cwd?: string;
    readonly purpose?: AgyPurpose;
  } = {},
) =>
  openSignedInAgy(fake.spawn, buildContext(home, BINARY, options.env), BINARY, {
    cwd: options.cwd ?? createScratchHome("agy-work"),
    handlers: NO_HANDLERS,
    purpose: options.purpose ?? { kind: "probe" },
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

    const error = await runAndReadFailure(open(fake, home));

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

  it("gives the sign-in, the version command and a session the same environment: the runner's own agy settings and credentials dropped, the two variables set, and a TMPDIR of its own only for the process that runs tools", async () => {
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
          purpose: { kind: "probe" },
        }),
      ),
    );
    await Effect.runPromise(readAgyVersion(run, ctx, BINARY));
    const login = buildLoginCommand(ctx, BINARY);

    const { TMPDIR, HERCULE_AGY_HOOK_RULES, ...sessionEnv } = fake.spawns[0]!.env;
    expect(TMPDIR).toContain("hercule-agy-");
    expect(HERCULE_AGY_HOOK_RULES).toBeDefined();
    expect(sessionEnv).toEqual(AGY_ENV);
    expect(versionEnvs).toEqual([AGY_ENV]);
    expect(login.env).toEqual(AGY_ENV);
  });
});

describe("what the process is opened for", () => {
  const SKIP_FLAG = "--dangerously-skip-permissions";
  const REQUEST = { cwd: "/work", mcpServers: [] };
  const GATEWAY_ENTRY = {
    name: "tools",
    url: "http://127.0.0.1:1/mcp",
    headers: [{ name: "Authorization", value: "Bearer token" }],
  };
  const FULL_ACCESS: AgyPurpose = { kind: "session", accessMode: "full-access", request: REQUEST };

  it("adds the skip-permissions flag for a session in full-access only", async () => {
    const modes = ["approval-required", "auto-accept-edits", "full-access"] as const;
    const commands: Array<ReadonlyArray<string>> = [];
    for (const accessMode of modes) {
      const { home, fake } = setUp();
      await Effect.runPromise(
        Effect.scoped(
          open(fake, home, { purpose: { kind: "session", accessMode, request: REQUEST } }),
        ),
      );
      commands.push(fake.spawns[0]!.command);
    }
    const { home, fake } = setUp();
    await Effect.runPromise(Effect.scoped(open(fake, home)));

    expect(commands.map((command) => command.includes(SKIP_FLAG))).toEqual([false, false, true]);
    expect(fake.spawns[0]!.command).not.toContain(SKIP_FLAG);
  });

  it("fails a session start before authenticate when agy does not take an added system prompt", async () => {
    const { home, fake } = setUp({ withoutSystemPromptCapability: true });

    const error = await runAndReadFailure(open(fake, home, { purpose: FULL_ACCESS }));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain(`agy ${ANTIGRAVITY_VERSION}`);
    const methods = fake.spawns[0]!.harness.received.map((message) => message.method);
    expect(methods).toContain("initialize");
    expect(methods).not.toContain("authenticate");
  });

  it("fails a session start whose request has additional directories before authenticate when agy does not take them", async () => {
    const { home, fake } = setUp({ withoutAdditionalDirectoriesCapability: true });

    const error = await runAndReadFailure(
      open(fake, home, {
        purpose: { ...FULL_ACCESS, request: { ...REQUEST, additionalDirectories: ["/skills"] } },
      }),
    );

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("additionalDirectories");
    const methods = fake.spawns[0]!.harness.received.map((message) => message.method);
    expect(methods).toContain("initialize");
    expect(methods).not.toContain("authenticate");
  });

  it("opens a session whose request has no additional directories when agy does not take them", async () => {
    const { home, fake } = setUp({ withoutAdditionalDirectoriesCapability: true });

    await Effect.runPromise(Effect.scoped(open(fake, home, { purpose: FULL_ACCESS })));

    expect(fake.spawns[0]!.harness.received.map((message) => message.method)).toContain(
      "authenticate",
    );
  });

  it("fails a session start that has MCP servers before authenticate when agy takes none over HTTP, and a probe or a session without them does not need it", async () => {
    const withServers: AgyPurpose = {
      ...FULL_ACCESS,
      request: { ...REQUEST, mcpServers: [GATEWAY_ENTRY] },
    };
    const { home, fake } = setUp({ withoutHttpMcpCapability: true });

    const error = await runAndReadFailure(open(fake, home, { purpose: withServers }));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("MCP servers over HTTP");
    const methods = fake.spawns[0]!.harness.received.map((message) => message.method);
    expect(methods).toContain("initialize");
    expect(methods).not.toContain("authenticate");

    const other = setUp({ withoutHttpMcpCapability: true });
    await Effect.runPromise(Effect.scoped(open(other.fake, other.home, { purpose: FULL_ACCESS })));
    expect(await openAndReadPlan(other.fake, other.home)).toBe(PLAN_LABEL);
  });

  it("still reads a signed-out home as not signed in when the capability is there", async () => {
    const { home, fake } = setUp({ scripts: { authenticate: RUN_LOGIN } });

    const error = await runAndReadFailure(open(fake, home, { purpose: FULL_ACCESS }));

    expect(error).toBeInstanceOf(HarnessLoginMissing);
  });

  it("does not need the capability for a probe", async () => {
    const { home, fake } = setUp({ withoutSystemPromptCapability: true });

    expect(await openAndReadPlan(fake, home)).toBe(PLAN_LABEL);
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
    expect(login.endsAtExit).toBe(true);
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
  const readCheckFailure = (
    plan: string | undefined,
    models: ReadonlyArray<ModelDescriptor>,
    isHeldByGoogle = false,
  ) => Option.getOrUndefined(Result.getFailure(checkAccountUsable(plan, models, isHeldByGoogle)));

  it("returns the plan of an account that has a plan and models", () => {
    expect(checkAccountUsable(PLAN_LABEL, [model], false)).toEqual(Result.succeed(PLAN_LABEL));
  });

  it("says Google holds the account when there is no plan and a worker log shows it", () => {
    const failure = readCheckFailure(undefined, [model], true);

    expect(failure).toBeInstanceOf(AdapterFailed);
    expect(failure?.message).toBe(
      'Google is holding this account until it is verified ("Verify your account to continue."), so Antigravity cannot use it. Sign in to this Google account in a browser and follow Google\'s steps; Google explains them at https://support.google.com/accounts?p=al_alert. The sign-in in Hercule is fine and need not be repeated.',
    );
  });

  it("says only what is known when there is no plan and no sign that Google holds the account", () => {
    expect(readCheckFailure(undefined, [model], false)?.message).toBe(
      "Antigravity reported no plan for this account, so it cannot be used. Check this runner's network, then sign in to this Google account in a browser to see whether Google asks for anything.",
    );
  });

  it("says the runner may be offline when no model is listed, whatever else is known", () => {
    const message =
      "Antigravity listed no models for this account. The runner may be offline, or Google may have refused the sign-in.";

    expect(readCheckFailure(PLAN_LABEL, [])?.message).toBe(message);
    expect(readCheckFailure(undefined, [], true)?.message).toBe(message);
  });
});

describe("a refused authenticate", () => {
  it("is not signed in when agy asks for the login and its log has no network error", async () => {
    const { home, fake } = setUp({ scripts: { authenticate: RUN_LOGIN } });

    const error = await runAndReadFailure(open(fake, home));

    expect(error).toBeInstanceOf(HarnessLoginMissing);
    expect(error.message).toBe("Antigravity is not signed in on this runner.");
  });

  it("is a network failure when a worker's log holds the network error", async () => {
    const { home, fake } = setUp({
      scripts: { authenticate: RUN_LOGIN },
      workerLogs: { authenticate: `${FILE_STORAGE_LINE}\n${NETWORK_ERROR_LINE}\n` },
    });

    const error = await runAndReadFailure(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toBe(
      "Antigravity could not reach Google to check the sign-in of this account. Check the network of this runner.",
    );
  });

  it.each([
    ["inside a path", "read /tmp/keyringAuth: token validation failed due to network error/x"],
    [
      "in the middle of a message",
      "retry after keyringAuth: token validation failed due to network error",
    ],
  ])("does not take the network phrase %s for the network error", async (_where, message) => {
    const { home, fake } = setUp({
      scripts: { authenticate: RUN_LOGIN },
      workerLogs: {
        authenticate: `${FILE_STORAGE_LINE}\nW1125 16:54:07.765336     286 files.go:9] ${message}`,
      },
    });

    expect(await runAndReadFailure(open(fake, home))).toBeInstanceOf(HarnessLoginMissing);
  });

  it("does not read the network error from the log of the front process", async () => {
    const { home, fake } = setUp({
      scripts: { authenticate: RUN_LOGIN },
      frontLog: NETWORK_ERROR_LINE,
    });

    expect(await runAndReadFailure(open(fake, home))).toBeInstanceOf(HarnessLoginMissing);
  });

  it("cannot tell why when there is no worker log at all, and does not call it signed out", async () => {
    const { home, fake } = setUp({
      scripts: { authenticate: RUN_LOGIN },
      workerLogs: { authenticate: [] },
    });

    const error = await runAndReadFailure(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toBe(
      "Could not tell why Antigravity refused the sign-in of this account. Sign in again on this runner. If this keeps happening, check the runner's log.",
    );
  });

  it.each([
    ["another error code with the same words", refuse(-32000, RUN_LOGIN_TEXT)],
    ["the same code with other words", refuse(-32603, "quota service unavailable")],
  ])("is a start failure with agy's own words for %s", async (_what, script) => {
    const { home, fake } = setUp({ scripts: { authenticate: script } });

    const error = await runAndReadFailure(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("Antigravity could not be started on this runner");
  });
});

const NOT_THIS_ACCOUNT = `Antigravity did not confirm that it uses this account's own login, so Hercule does not use it. This build was tested with agy ${ANTIGRAVITY_VERSION}: if another version is installed, install the tested one on this runner.`;

describe("the sign that a process uses the account's own login", () => {
  it("passes when every worker log has it", async () => {
    const { home, fake } = setUp({
      workerLogs: { authenticate: [FILE_STORAGE_LINE, `${FILE_STORAGE_LINE}\nmore`] },
    });

    expect(await openAndReadPlan(fake, home)).toBe(PLAN_LABEL);
  });

  it.each([
    ["there is no worker log", { workerLogs: { authenticate: [] } }],
    ["the only worker log lacks it", { workerLogs: { authenticate: KEYRING_LINE } }],
    [
      "one of two worker logs lacks it",
      { workerLogs: { authenticate: [FILE_STORAGE_LINE, KEYRING_LINE] } },
    ],
    [
      "only the log of the front process has it",
      { workerLogs: { authenticate: [] }, frontLog: FILE_STORAGE_LINE },
    ],
    [
      "the phrase is only inside a longer line, such as a path",
      {
        workerLogs: {
          authenticate:
            "I1125 16:54:06.115838      87 files.go:9] opened /tmp/Using file-based token storage because SSH session detected/x",
        },
      },
    ],
    [
      "the phrase is in the middle of a message",
      {
        workerLogs: {
          authenticate:
            "I1125 16:54:06.115838      87 files.go:9] note: Using file-based token storage because SSH session detected",
        },
      },
    ],
    [
      "the line has no log header",
      {
        workerLogs: { authenticate: "Using file-based token storage because SSH session detected" },
      },
    ],
    [
      "the phrase is followed by more text on its line",
      {
        workerLogs: {
          authenticate: `${FILE_STORAGE_LINE} (not really)`,
        },
      },
    ],
    [
      "the front process has it and the only worker does not",
      { workerLogs: { authenticate: KEYRING_LINE }, frontLog: FILE_STORAGE_LINE },
    ],
  ])("fails the sign-in when %s", async (_what, logs) => {
    const { home, fake } = setUp(logs);

    const error = await runAndReadFailure(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toBe(NOT_THIS_ACCOUNT);
  });
});

describe("opening a conversation", () => {
  const keepNothing = () => Effect.void;

  /** Opens `agy`, runs `use` on it, and returns what `use` returned or failed with. */
  const withSignedIn = <A, E>(
    fake: FakeAgy,
    home: string,
    use: (signedIn: SignedInAgy) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* Effect.result(use(yield* open(fake, home)));
        }),
      ),
    );

  it("starts a new conversation and returns its id and settings", async () => {
    const { home, fake } = setUp();

    const result = await withSignedIn(fake, home, (signedIn) =>
      signedIn.newConversation(keepNothing),
    );

    expect(Result.isSuccess(result) && result.success.id).toBe(CONVERSATION);
    expect(Result.isSuccess(result) && result.success.settings.configOptions).not.toEqual([]);
  });

  it("resumes the conversation asked for and returns its id and settings", async () => {
    const { home, fake } = setUp();
    createConversationFiles(home, CONVERSATION);

    const result = await withSignedIn(fake, home, (signedIn) =>
      signedIn.resumeConversation(CONVERSATION),
    );

    expect(Result.isSuccess(result) && result.success.id).toBe(CONVERSATION);
    expect(Result.isSuccess(result) && result.success.settings.configOptions).not.toEqual([]);
  });

  it("sends the request of the session's purpose to session/new, and the same request with the id to session/resume", async () => {
    const { home, fake } = setUp();
    createConversationFiles(home, CONVERSATION);
    const request = {
      cwd: "/work",
      additionalDirectories: ["/skills"],
      mcpServers: [],
      meta: { antigravity: { systemPrompt: { append: "Be brief." } } },
    };
    const purpose: AgyPurpose = { kind: "session", accessMode: "full-access", request };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const signedIn = yield* open(fake, home, { purpose });
          yield* signedIn.newConversation();
          yield* signedIn.resumeConversation(CONVERSATION);
        }),
      ),
    );

    const sent = fake.spawns[0]!.harness.received;
    const params = (method: string) => sent.find((message) => message.method === method)?.params;
    const sentRequest = {
      cwd: "/work",
      mcpServers: [],
      additionalDirectories: ["/skills"],
      _meta: request.meta,
    };
    expect(params("session/new")).toEqual(sentRequest);
    expect(params("session/resume")).toEqual({ ...sentRequest, sessionId: CONVERSATION });
  });

  it("sends only the working folder and no MCP server for a probe", async () => {
    const { home, fake } = setUp();
    const cwd = createScratchHome("agy-probe-work");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const signedIn = yield* open(fake, home, { cwd });
          yield* signedIn.newConversation();
        }),
      ),
    );

    expect(
      fake.spawns[0]!.harness.received.find((message) => message.method === "session/new")?.params,
    ).toEqual({ cwd, mcpServers: [] });
  });

  it("says whether Google holds the account, and does not fail for it", async () => {
    const plain = setUp();
    const held = setUp({
      workerLogs: { "session/new": [`${FILE_STORAGE_LINE}\n${HELD_BY_GOOGLE_LINE}`] },
    });
    const lookalike = setUp({
      workerLogs: {
        "session/new": [`${FILE_STORAGE_LINE}\nread /tmp/"reason": "VALIDATION_REQUIREDX"`],
      },
    });
    const isHeld = async ({ home, fake }: typeof plain) => {
      const result = await withSignedIn(fake, home, (signedIn) =>
        signedIn.newConversation(keepNothing),
      );
      return Result.isSuccess(result) && result.success.isHeldByGoogle;
    };

    expect(await isHeld(plain)).toBe(false);
    expect(await isHeld(held)).toBe(true);
    expect(await isHeld(lookalike)).toBe(false);
  });

  it("resuming a conversation agy has no files for fails as a missing transcript", async () => {
    const { home, fake } = setUp();

    const result = await withSignedIn(fake, home, (signedIn) =>
      signedIn.resumeConversation(CONVERSATION),
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(ResumeTranscriptMissing);
  });

  it("is not signed in when agy says authentication is required", async () => {
    const { home, fake } = setUp({
      scripts: { "session/new": refuse(-32000, "Authentication required") },
    });

    const result = await withSignedIn(fake, home, (signedIn) =>
      signedIn.newConversation(keepNothing),
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(HarnessLoginMissing);
  });

  it("passes any other refusal on as the call's own error", async () => {
    const { home, fake } = setUp({
      scripts: { "session/resume": refuse(-32603, "Internal error") },
    });

    const result = await withSignedIn(fake, home, (signedIn) =>
      signedIn.resumeConversation(CONVERSATION),
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(AcpError);
  });

  it.each([
    ["session/new", "newConversation"],
    ["session/resume", "resumeConversation"],
  ] as const)(
    "fails when the worker that %s started has no log, though the first worker logged its own login",
    async (method, open_) => {
      const { home, fake } = setUp({ workerLogs: { [method]: [] } });
      createConversationFiles(home, CONVERSATION);

      const result = await withSignedIn(fake, home, (signedIn) =>
        open_ === "newConversation"
          ? signedIn.newConversation(keepNothing)
          : signedIn.resumeConversation(CONVERSATION),
      );

      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(AdapterFailed);
      expect(Result.isFailure(result) && result.failure.message).toBe(NOT_THIS_ACCOUNT);
    },
  );

  it("hands the id of a new conversation over before it checks the worker, so a failed check still has it", async () => {
    const { home, fake } = setUp({ workerLogs: { "session/new": KEYRING_LINE } });
    const kept: Array<string> = [];

    const result = await withSignedIn(fake, home, (signedIn) =>
      signedIn.newConversation((id) =>
        Effect.sync(() => {
          kept.push(id);
        }),
      ),
    );

    expect(kept).toEqual([CONVERSATION]);
    expect(Result.isFailure(result) && result.failure.message).toBe(NOT_THIS_ACCOUNT);
  });

  it("hands the id of a resumed conversation over before it checks the worker", async () => {
    const { home, fake } = setUp({ workerLogs: { "session/resume": KEYRING_LINE } });
    createConversationFiles(home, CONVERSATION);
    const kept: Array<string> = [];

    const result = await withSignedIn(fake, home, (signedIn) =>
      signedIn.resumeConversation(CONVERSATION, (id) =>
        Effect.sync(() => {
          kept.push(id);
        }),
      ),
    );

    expect(kept).toEqual([CONVERSATION]);
    expect(Result.isFailure(result) && result.failure.message).toBe(NOT_THIS_ACCOUNT);
  });

  it("fails when the id cannot be kept", async () => {
    const { home, fake } = setUp();

    const result = await withSignedIn(fake, home, (signedIn) =>
      signedIn.newConversation(() => Effect.fail(buildAdapterFailed("No room."))),
    );

    expect(Result.isFailure(result) && result.failure.message).toBe("No room.");
  });

  it("does not take the worker log of a refused resume for the worker of the next call", async () => {
    // A refused resume starts a worker and logs, as the real agy does.
    const { home, fake } = setUp({ workerLogs: { "session/new": [] } });

    const result = await withSignedIn(fake, home, (signedIn) =>
      Effect.gen(function* () {
        yield* Effect.ignore(signedIn.resumeConversation(CONVERSATION));
        return yield* signedIn.newConversation(keepNothing);
      }),
    );

    expect(Result.isFailure(result) && result.failure.message).toBe(NOT_THIS_ACCOUNT);
  });

  it("fails when the worker it started does not use the account's own login", async () => {
    const { home, fake } = setUp({ workerLogs: { "session/new": KEYRING_LINE } });

    const result = await withSignedIn(fake, home, (signedIn) =>
      signedIn.newConversation(keepNothing),
    );

    expect(Result.isFailure(result) && result.failure.message).toBe(NOT_THIS_ACCOUNT);
  });
});

describe("a process that cannot be started", () => {
  it("is not installed when the binary does not exist", async () => {
    const { home, fake } = setUp({
      throws: Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
    });

    const error = await runAndReadFailure(open(fake, home));

    expect(error).toBeInstanceOf(HarnessNotInstalled);
    expect(error.message).toBe("Antigravity is not installed on this runner.");
    expect(listLogFolders(home)).toEqual([]);
  });

  it("is a start failure with the reason for any other error", async () => {
    const { home, fake } = setUp({ throws: new Error("permission denied") });

    const error = await runAndReadFailure(open(fake, home));

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

    const error = await runAndReadFailure(open(fake, home, { cwd: "/nonexistent/work-folder" }));

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

    const error = await runAndReadFailure(open(fake, home));

    expect(error).toBeInstanceOf(AdapterFailed);
    expect(error.message).toContain("Antigravity could not be started on this runner");
    expect(error.message).toContain("panic: could not open the database goroutine 1 [running]:");
    expect(fake.spawns[0]!.hasExited).toBe(true);
    expect(listLogFolders(home)).toEqual([]);
  });

  it("cuts each stderr line it names in the failure", async () => {
    const { home, fake } = setUp({
      scripts: {
        initialize: (_call, harness) => {
          harness.end();
          return [];
        },
      },
      stderrLines: ["x".repeat(5_000)],
    });

    const error = await runAndReadFailure(open(fake, home));

    expect(error.message).toContain("…");
    expect(error.message.length).toBeLessThan(1_000);
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
    const { home, fake } = setUp({ workerLogs: { authenticate: [] } });

    await runAndReadFailure(open(fake, home));

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

describe("the files of the Harness Home that Hercule owns", () => {
  const SESSION: AgyPurpose = {
    kind: "session",
    accessMode: "approval-required",
    request: { cwd: "/work", mcpServers: [] },
  };
  const REMOVED = [
    ["antigravity-acp", "settings.json"],
    ["config", "plugins"],
    ["config", "plugins.json"],
    [".", "skills"],
    ["config", "skills"],
    ["antigravity-acp", "skills"],
    ["config", "skills.json"],
    [".", "GEMINI.md"],
    [".", "AGENTS.md"],
    ["config", "GEMINI.md"],
    ["config", "AGENTS.md"],
    ["config", "rules"],
  ] as const;
  const MCP_CONFIG = (home: string) => join(home, "config", "mcp_config.json");

  it.each(REMOVED)("removes %s/%s before agy starts for a session", async (folder, name) => {
    const { home, fake } = setUp();
    mkdirSync(join(home, folder), { recursive: true });
    writeFileSync(join(home, folder, name), "{}");

    await Effect.runPromise(Effect.scoped(open(fake, home, { purpose: SESSION })));

    expect(existsSync(join(home, folder, name))).toBe(false);
    expect(fake.spawns).toHaveLength(1);
  });

  it.each(REMOVED)("removes %s/%s as a link, and what it points to stays", async (folder, name) => {
    const { home, fake } = setUp();
    const target = join(createScratchHome("agy-target"), name);
    writeFileSync(target, "{}");
    mkdirSync(join(home, folder), { recursive: true });
    symlinkSync(target, join(home, folder, name));

    await Effect.runPromise(Effect.scoped(open(fake, home, { purpose: SESSION })));

    expect(existsSync(join(home, folder, name))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  it.each(REMOVED)("removes %s/%s when it is a whole folder", async (folder, name) => {
    const { home, fake } = setUp();
    mkdirSync(join(home, folder, name, "inner"), { recursive: true });
    writeFileSync(join(home, folder, name, "inner", "file"), "x");

    await Effect.runPromise(Effect.scoped(open(fake, home, { purpose: SESSION })));

    expect(existsSync(join(home, folder, name))).toBe(false);
  });

  it.each(REMOVED)(
    "removes %s/%s as a link to a folder, and the folder stays",
    async (folder, name) => {
      const { home, fake } = setUp();
      const target = createScratchHome("agy-target");
      writeFileSync(join(target, "file"), "x");
      mkdirSync(join(home, folder), { recursive: true });
      symlinkSync(target, join(home, folder, name));

      await Effect.runPromise(Effect.scoped(open(fake, home, { purpose: SESSION })));

      expect(existsSync(join(home, folder, name))).toBe(false);
      expect(readFileSync(join(target, "file"), "utf8")).toBe("x");
    },
  );

  it("empties the MCP servers file, also when it is a link, and leaves the link's target alone", async () => {
    const { home, fake } = setUp();
    mkdirSync(join(home, "config"));
    writeFileSync(MCP_CONFIG(home), '{"mcpServers":{"x":{"url":"http://x"}}}');
    await Effect.runPromise(Effect.scoped(open(fake, home, { purpose: SESSION })));
    expect(readFileSync(MCP_CONFIG(home), "utf8")).toBe("");

    const target = join(createScratchHome("agy-target"), "mcp.json");
    writeFileSync(target, "{}");
    rmSync(MCP_CONFIG(home));
    symlinkSync(target, MCP_CONFIG(home));
    await Effect.runPromise(Effect.scoped(open(fake, home, { purpose: SESSION })));
    expect(lstatSync(MCP_CONFIG(home)).isFile()).toBe(true);
    expect(readFileSync(MCP_CONFIG(home), "utf8")).toBe("");
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  it("creates the MCP servers file as an empty file when there is none", async () => {
    const { home, fake } = setUp();

    await Effect.runPromise(Effect.scoped(open(fake, home, { purpose: SESSION })));

    expect(readFileSync(MCP_CONFIG(home), "utf8")).toBe("");
    expect(readdirSync(join(home, "config")).sort()).toEqual(["hooks.json", "mcp_config.json"]);
  });

  it("resets them also when agy is opened for a probe, before it starts", async () => {
    const { home, fake } = setUp();
    mkdirSync(join(home, "config"));
    writeFileSync(join(home, "config", "hooks.json"), "{}");
    writeFileSync(MCP_CONFIG(home), "{}");

    await Effect.runPromise(Effect.scoped(open(fake, home)));

    expect(readFileSync(join(home, "config", "hooks.json"), "utf8")).toContain("PreToolUse");
    expect(readFileSync(MCP_CONFIG(home), "utf8")).toBe("");
  });

  it("fails the start, changes nothing and spawns nothing when config is a link", async () => {
    const { home, fake } = setUp();
    const outside = createScratchHome("agy-outside");
    writeFileSync(join(outside, "mcp_config.json"), "{}");
    symlinkSync(outside, join(home, "config"));

    const failure = await runAndReadFailure(open(fake, home, { purpose: SESSION }));

    expect(failure._tag).toBe("AdapterFailed");
    expect(failure.message).toContain(join(home, "config"));
    expect(failure.message).toContain("link");
    expect(readdirSync(outside)).toEqual(["mcp_config.json"]);
    expect(readFileSync(join(outside, "mcp_config.json"), "utf8")).toBe("{}");
    expect(fake.spawns).toHaveLength(0);
  });

  it("fails the start when the Harness Home itself is a link, for a probe too", async () => {
    const { home, fake } = setUp();
    const link = join(createScratchHome("agy-link"), "home");
    symlinkSync(home, link);

    const failure = await runAndReadFailure(open(fake, link));

    expect(failure.message).toContain(link);
    expect(fake.spawns).toHaveLength(0);
  });

  it("tells the user to remove a folder that stands where Hercule writes a file", async () => {
    const { home, fake } = setUp();
    mkdirSync(join(home, "config", "hooks.json"), { recursive: true });

    const failure = await runAndReadFailure(open(fake, home, { purpose: SESSION }));

    expect(failure.message).toContain(join(home, "config", "hooks.json"));
    expect(failure.message).toContain(
      "is a folder, and Hercule needs a file there. Remove the folder",
    );
    expect(fake.spawns).toHaveLength(0);
  });

  it("fails the start with AdapterFailed naming the path, and spawns nothing, when one cannot be changed", async () => {
    const { home, fake } = setUp();
    mkdirSync(join(MCP_CONFIG(home), "inner"), { recursive: true });

    const failure = await runAndReadFailure(open(fake, home, { purpose: SESSION }));

    expect(failure._tag).toBe("AdapterFailed");
    expect(failure.message).toContain("mcp_config.json");
    expect(readdirSync(join(home, "config")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(fake.spawns).toHaveLength(0);
  });
});

describe("the pre-tool hook of a session", () => {
  const SESSION: AgyPurpose = {
    kind: "session",
    accessMode: "approval-required",
    request: { cwd: "/work", mcpServers: [] },
  };
  interface HooksFile {
    readonly hercule: {
      readonly PreToolUse: ReadonlyArray<{
        readonly matcher: string;
        readonly hooks: ReadonlyArray<{ readonly command: string }>;
      }>;
    };
  }
  const HOOKS_FILE = (home: string) => join(home, "config", "hooks.json");

  /** Starts a session for the account in `home`, and returns what the spawned `agy` was given. */
  const startSession = async (home: string, sessionMarksDir: string | null) => {
    const fake = buildFakeAgy(home);
    const ctx = buildContext(home);
    await Effect.runPromise(
      Effect.scoped(
        openSignedInAgy(
          fake.spawn,
          sessionMarksDir === null
            ? ctx
            : {
                ...ctx,
                editMarks: {
                  sessionMarksDir,
                  recordToolStart: () => undefined,
                  recordProcessStart: () => undefined,
                  recordProcessEnd: () => undefined,
                  recordRequestOnRunningItem: () => undefined,
                },
              },
          BINARY,
          { cwd: createScratchHome("agy-work"), handlers: NO_HANDLERS, purpose: SESSION },
        ),
      ),
    );
    return fake.spawns[0]!;
  };

  it("is the same hooks file for every session, writes it over what is there, and leaves no temporary file", async () => {
    const home = createSignedInHome();
    await startSession(home, null);
    const hooks = readFileSync(HOOKS_FILE(home), "utf8");

    const target = join(createScratchHome("agy-target"), "hooks.json");
    writeFileSync(target, "{}");
    rmSync(HOOKS_FILE(home));
    symlinkSync(target, HOOKS_FILE(home));
    await startSession(home, createScratchHome("agy-marks"));

    expect(readFileSync(HOOKS_FILE(home), "utf8")).toBe(hooks);
    expect(lstatSync(HOOKS_FILE(home)).isFile()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("{}");
    expect(readdirSync(join(home, "config")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((JSON.parse(hooks) as HooksFile).hercule.PreToolUse[0]!.matcher).toBe(
      "run_command|edit_file|write_file|search_web|invoke_subagent|mcp_chrome_devtools_.*",
    );
    expect(hooks).not.toContain("agy-marks");
  });

  it("runs the verb of the binary, quoted so a shell reads it as the same words", async () => {
    const home = createSignedInHome();
    await startSession(home, null);
    const hooks = JSON.parse(readFileSync(HOOKS_FILE(home), "utf8")) as HooksFile;
    const command = hooks.hercule.PreToolUse[0]!.hooks[0]!.command;

    const words = Bun.spawnSync(["/bin/sh", "-c", `for word in ${command}; do echo "$word"; done`])
      .stdout.toString()
      .trimEnd()
      .split("\n");

    expect(words[0]).toBe(process.execPath);
    expect(words.at(-1)).toBe("antigravity-pre-tool-hook");
  });

  it("runs the launcher the caller gives, quoted word by word, in front of the verb", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home);
    await Effect.runPromise(
      Effect.scoped(
        openSignedInAgy(fake.spawn, buildContext(home), BINARY, {
          cwd: createScratchHome("agy-work"),
          handlers: NO_HANDLERS,
          purpose: SESSION,
          hookLauncher: ["/usr/bin/bun", "/a b/main.ts"],
        }),
      ),
    );

    const hooks = JSON.parse(readFileSync(HOOKS_FILE(home), "utf8")) as HooksFile;
    expect(hooks.hercule.PreToolUse[0]!.hooks[0]!.command).toBe(
      "'/usr/bin/bun' '/a b/main.ts' antigravity-pre-tool-hook",
    );
  });

  it("gives the marks directory to the agy process of a session with an edit watch only", async () => {
    const marks = createScratchHome("agy-marks");

    const watched = await startSession(createSignedInHome(), marks);
    const unwatched = await startSession(createSignedInHome(), null);

    expect(watched.env["HERCULE_SESSION_MARKS_DIR"]).toBe(marks);
    expect(unwatched.env).not.toHaveProperty("HERCULE_SESSION_MARKS_DIR");
  });

  it("gives the agy process of every session and probe the rules: the access mode, the read-only folders and the owned paths of the Harness Home", async () => {
    const spawned = async (
      purpose: (request: NewSessionRequest) => AgyPurpose,
      additionalDirectories?: ReadonlyArray<string>,
    ) => {
      const home = createSignedInHome();
      const fake = buildFakeAgy(home);
      await Effect.runPromise(
        Effect.scoped(
          openSignedInAgy(fake.spawn, buildContext(home), BINARY, {
            cwd: createScratchHome("agy-work"),
            handlers: NO_HANDLERS,
            purpose: purpose({
              cwd: "/work",
              mcpServers: [],
              ...(additionalDirectories === undefined ? {} : { additionalDirectories }),
            }),
          }),
        ),
      );
      const rules = JSON.parse(fake.spawns[0]!.env["HERCULE_AGY_HOOK_RULES"]!) as {
        accessMode: string;
        readOnlyFolders: ReadonlyArray<string>;
        harnessHomePaths: ReadonlyArray<string>;
      };
      return { home, rules };
    };
    const inMode =
      (accessMode: "approval-required" | "auto-accept-edits" | "full-access") =>
      (request: NewSessionRequest): AgyPurpose => ({ kind: "session", accessMode, request });

    const approval = await spawned(inMode("approval-required"), [
      "/made/up/skills/../skills",
      "/made/other",
    ]);
    const edits = await spawned(inMode("auto-accept-edits"));
    const full = await spawned(inMode("full-access"));
    const probe = await spawned(() => ({ kind: "probe" }));

    expect(approval.rules.accessMode).toBe("approval-required");
    expect(approval.rules.readOnlyFolders).toEqual(["/made/up/skills", "/made/other"]);
    expect(edits.rules).toMatchObject({ accessMode: "auto-accept-edits", readOnlyFolders: [] });
    expect(full.rules.accessMode).toBe("full-access");
    expect(probe.rules.accessMode).toBe("approval-required");
    for (const { home, rules } of [approval, edits, full, probe]) {
      expect(rules.harnessHomePaths).toEqual(
        expect.arrayContaining([
          join(home, "config", "hooks.json"),
          join(home, "config", "plugins"),
          join(home, "config", "plugins.json"),
          join(home, "config", "mcp_config.json"),
          join(home, "antigravity-acp", "settings.json"),
          join(home, "skills"),
          join(home, "AGENTS.md"),
        ]),
      );
    }
  });
});

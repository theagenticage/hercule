/**
 * Tests the Claude Code adapter's probe, sessions and text generation, with the vendor SDK
 * stubbed. The fixtures were captured from the real CLI, version 2.1.263; they
 * are not invented.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Duration, Effect, Fiber, Logger, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import type {
  Options,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_VERSION } from "@hercule/home/version";
import {
  AdapterFailed,
  AnswerNotDelivered,
  HarnessNotInstalled,
  InputNotDelivered,
  MAX_MESSAGE_LENGTH,
  ModelChangeRefused,
  SessionAlreadyRunning,
  SessionNotRunning,
  SteerRefused,
  type ApprovalDecision,
  type OpenRequest,
  type OutputSchema,
  type ProbeResult,
  type HarnessEvent,
  type QuestionAnswers,
  type SessionSpec,
  type TextGenerationOutcome,
  type TextGenerationSpec,
} from "@hercule/protocol";
import {
  CONTROL_DEADLINE,
  buildClaudePromptParts,
  makeClaudeCodeAdapter,
  type ClaudeSeam,
} from "./claude-code";
import { PROBE_DEADLINE } from "./probe";
import { resolveSkillReferences, type LoadedSkills } from "../skills";
import type { AdapterTurnInput, EditMarks, HarnessAdapter, HarnessRunnerContext } from "./index";
import * as testing from "./testing";
import {
  buildAgentCall,
  buildSubagentText,
  buildTaskNotification,
  buildTaskStarted,
} from "./claude-code.testing";

/** The hercule-as-a-tool files, which the runner prepares once at startup. */
const HERCULE_TOOL = {
  orientation: "",
  skill: "# hercule\n\nCall `hercule --help`.\n",
  claudePluginDir: "/var/hercule/runner/storage/claude-plugin",
};

const CONTEXT: HarnessRunnerContext = {
  cwd: null,
  attachmentsDir: null,
  editMarks: null,
  home: "/var/hercule/runner/providers/0199e0e7-0000-7000-8000-00000000000a",
  binary: "/usr/local/bin/claude",
  env: { PATH: "/usr/local/bin:/usr/bin" },
  modelArgument: "{model}",
  herculeTool: HERCULE_TOOL,
  attachmentUploader: testing.NO_CONTROLLER_UPLOADER,
};

afterAll(testing.cleanupHomes);

const AUTHENTICATED = {
  email: "rogier@example.com",
  organization: "Rogier's Org",
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

const UNAUTHENTICATED = { tokenSource: "none", apiProvider: "firstParty" };

/** Three of the six models the CLI listed, one for each combination of options. */
const MODELS = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Opus 4.8 for up to 50% of usage limits, then Sonnet 4.6",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
  },
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Everyday coding",
    supportsEffort: false,
    supportsFastMode: false,
  },
  {
    value: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    description: "Fastest",
    supportsFastMode: true,
  },
];

const PRINTED = "9.9.9 (Claude Code)";

interface Call {
  readonly params: { readonly options: Record<string, unknown> };
}

const buildStubSeam = (answers: {
  readonly accountInfo?: () => Promise<unknown>;
  readonly supportedModels?: () => Promise<ReadonlyArray<unknown>>;
}): {
  readonly seam: ClaudeSeam;
  readonly calls: Array<Call>;
  readonly closed: () => number;
} => {
  const calls: Array<Call> = [];
  let closes = 0;
  const seam: ClaudeSeam = {
    query: (params) => {
      calls.push({ params });
      return {
        accountInfo: answers.accountInfo ?? (() => Promise.resolve(AUTHENTICATED)),
        supportedModels: answers.supportedModels ?? (() => Promise.resolve(MODELS)),
        close: () => {
          closes += 1;
        },
      };
    },
    stream: () => {
      throw new Error("probing must not start a session");
    },
    run: (command) =>
      Effect.succeed(
        command[1] === "--version"
          ? { code: 0, stdout: PRINTED, stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      ),
  };
  return { seam, calls, closed: () => closes };
};

const probeWith = (
  answers: Parameters<typeof buildStubSeam>[0] = {},
): {
  readonly result: Promise<ProbeResult>;
  readonly calls: Array<Call>;
  readonly closed: () => number;
} => {
  const { seam, calls, closed } = buildStubSeam(answers);
  return {
    result: Effect.runPromise(makeClaudeCodeAdapter(seam).probe(CONTEXT)),
    calls,
    closed,
  };
};

const findModelOption = (
  models: ProbeResult["models"],
  slug: string,
  id: string,
): Record<string, unknown> | undefined =>
  models.find((model) => model.slug === slug)?.options.find((option) => option.id === id);

describe("probing a machine that is logged in", () => {
  it("reports the account, its plan and its backend", async () => {
    const { result } = probeWith({});

    const probed = await result;
    expect(probed.auth).toMatchObject({
      status: "ok",
      identity: "rogier@example.com",
      planLabel: "Claude Max",
      backend: "firstParty",
    });
    expect(probed.harnessVersion).toBe("9.9.9");
  });

  it("maps each model to its slug, its name and only the options it supports", async () => {
    const { result } = probeWith({});

    const probed = await result;
    expect(probed.models.slice(0, 3).map((model) => model.slug)).toEqual([
      "default",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
    expect(probed.models[0]).toMatchObject({ slug: "default", name: "Default (recommended)" });
    expect(probed.models[0]?.isDefault).toBe(true);
    expect(probed.models[1]?.isDefault ?? false).toBe(false);

    expect(findModelOption(probed.models, "default", "effort")).toMatchObject({
      kind: "select",
      choices: [{ value: "low" }, { value: "medium" }, { value: "high" }] as ReadonlyArray<unknown>,
      default: "medium",
    });
    expect(findModelOption(probed.models, "default", "fastMode")).toMatchObject({
      kind: "boolean",
      default: false,
    });

    // The composer must offer only the options the harness accepts for that model.
    expect(probed.models[1]?.options).toEqual([]);
    expect(probed.models[2]?.options.map((option) => option.id)).toEqual(["fastMode"]);
    // The CLI reports adaptive thinking as a fact about the model, not as a
    // choice a user makes, so it is not an option.
    expect(JSON.stringify(probed.models)).not.toContain("thinking");
  });

  it("appends the legacy models the CLI no longer lists, after the ones it does", async () => {
    const { result } = probeWith({});

    const probed = await result;
    const legacy = probed.models.filter((model) => model.isLegacy === true);
    expect(legacy.map((model) => model.slug)).toEqual(["claude-opus-4-8", "claude-fable-5"]);
    expect(legacy.map((model) => model.name)).toEqual(["Opus 4.8", "Fable 5"]);
    expect(probed.models.slice(0, 3).every((model) => model.isLegacy !== true)).toBe(true);
    expect(probed.models).toHaveLength(MODELS.length + legacy.length);
  });

  it("keeps the listed model and drops the legacy entry when the CLI still lists a legacy slug", async () => {
    const { result } = probeWith({
      supportedModels: () =>
        Promise.resolve([
          ...MODELS,
          {
            value: "claude-fable-5",
            displayName: "Fable 5 (probed)",
            description: "Back on the list",
            supportsEffort: false,
            supportsFastMode: false,
          },
        ]),
    });

    const probed = await result;
    const fable = probed.models.filter((model) => model.slug === "claude-fable-5");
    expect(fable).toHaveLength(1);
    expect(fable[0]?.name).toBe("Fable 5 (probed)");
    expect(fable[0]?.isLegacy ?? false).toBe(false);
  });
});

describe("probing a machine that is not logged in", () => {
  it("reports unauthenticated, with no identity", async () => {
    const { result } = probeWith({ accountInfo: () => Promise.resolve(UNAUTHENTICATED) });

    const probed = await result;
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
    // Not an error: an empty config directory is normal, and the version and
    // the model catalog are still reported.
    expect(probed.auth.message).toBeUndefined();
    expect(probed.harnessVersion).toBe("9.9.9");
  });
});

describe("probing a machine with a credential in the environment", () => {
  // These are the two account shapes SDK 0.3.263 really returns when the
  // config directory has no login but the environment has a credential.
  // Neither includes an account, and both work: a probe checks whether there
  // is a usable login, not whose login it is (spec 06 section 3.2).
  it("counts an OAuth token as a login, with no identity", async () => {
    const { result } = probeWith({
      accountInfo: () =>
        Promise.resolve({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("ok");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.auth.backend).toBe("firstParty");
  });

  it("does not count a machine with no token and no API key as a login", async () => {
    const { result } = probeWith({
      accountInfo: () => Promise.resolve({ tokenSource: "none", apiKeySource: "none" }),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("unauthenticated");
  });

  it("counts a third-party backend as a login, because it authenticates outside the harness", async () => {
    const { result } = probeWith({
      accountInfo: () => Promise.resolve({ apiProvider: "bedrock" }),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("ok");
    expect(probed.auth.backend).toBe("bedrock");
  });

  it("counts an API key as a login", async () => {
    const { result } = probeWith({
      accountInfo: () =>
        Promise.resolve({
          tokenSource: "none",
          apiKeySource: "ANTHROPIC_API_KEY",
          apiProvider: "firstParty",
        }),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("ok");
    expect(probed.auth.identity).toBeUndefined();
  });
});

describe("probing when the probe does not finish", () => {
  it("reports the error the SDK threw, so the user sees why instead of a blank row", async () => {
    const { result } = probeWith({
      accountInfo: () => Promise.reject(new Error("spawn /usr/local/bin/claude ENOENT")),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message).toContain("ENOENT");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.models).toEqual([]);
  });

  it("gives the SDK fifteen seconds, then reports an error", async () => {
    expect(Duration.toSeconds(PROBE_DEADLINE)).toBe(15);

    const { seam } = buildStubSeam({ accountInfo: () => new Promise<never>(() => undefined) });
    const probed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(makeClaudeCodeAdapter(seam).probe(CONTEXT));
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(PROBE_DEADLINE);
          return yield* Fiber.join(running);
        }),
        TestClock.layer(),
      ),
    );

    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").not.toBe("");
  });
});

describe("the SDK query a probe runs", () => {
  it("runs a query with no prompt, no settings and no session left behind", async () => {
    const { result, calls } = probeWith({});
    await result;

    expect(calls).toHaveLength(1);
    const params = calls[0]!.params;
    // A prompt that yields a message makes a real API call as soon as the
    // query starts, and a probe must not make any.
    expect("prompt" in params).toBe(false);
    expect(params.options).toMatchObject({
      pathToClaudeCodeExecutable: CONTEXT.binary,
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
    });
  });

  it("ends the query however it went, so no harness child is left running", async () => {
    const answered = probeWith({});
    await answered.result;
    expect(answered.closed()).toBe(1);

    const threw = probeWith({ accountInfo: () => Promise.reject(new Error("gone")) });
    await threw.result;
    expect(threw.closed()).toBe(1);
  });

  it("points the harness at the account's own home and never at the user's", async () => {
    const { result, calls } = probeWith({});
    await result;

    const env = calls[0]!.params.options["env"] as Record<string, string>;
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(CONTEXT.home);
    // Without this, the harness could update itself during a probe and install
    // a version nobody chose, while the probe is reporting which version it has.
    expect(env["DISABLE_AUTOUPDATER"]).toBe("1");
    // `HOME` must never be overridden: the CLI would then read and write the
    // wrong account's credential and report it as this account's.
    expect(Object.keys(env)).not.toContain("HOME");
    expect(env["PATH"]).toBe(CONTEXT.env["PATH"]);
  });
});

describe("the pinned CLI version", () => {
  it("matches the version the installed SDK was built against", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as { readonly claudeCodeVersion: string };

    // The version is fixed at build time rather than read at runtime, because a
    // compiled binary has no package.json on disk to read.
    expect(CLAUDE_CODE_VERSION).toBe(manifest.claudeCodeVersion);
  });
});

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const SPEC: SessionSpec = {
  providerAccountId: "0199e0e7-0000-7000-8000-00000000000a",
  workspaceId: null,
  modelSelection: { model: "claude-haiku-4-5", options: { effort: "high", fastMode: false } },
  accessMode: "auto-accept-edits",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

const WORKING: HarnessRunnerContext = { ...CONTEXT, cwd: "/var/hercule/runner/scratch/one" };

/**
 * The context of a Thread that sees User Material. For Claude the paths are
 * empty: the runner links the material into the Harness Home instead, and
 * the field being present is what marks the session.
 */
const THREAD: HarnessRunnerContext = { ...WORKING, userMaterial: testing.NO_USER_MATERIAL_PATHS };

/** A fake harness for a session. The test sends it messages one at a time. */
interface Driving {
  readonly adapter: HarnessAdapter;
  readonly options: Array<Options>;
  readonly sent: Array<SDKUserMessage>;
  readonly seen: Array<HarnessEvent>;
  readonly say: (message: unknown) => void;
  readonly end: () => void;
  readonly die: (reason: Error) => void;
  readonly models: Array<string>;
  readonly closed: () => number;
  readonly interrupted: () => number;
  /** The agent ids `stopTask` was called with, in order. */
  readonly stoppedTasks: Array<string>;
  /** When true, `setModel` rejects the model. */
  refusesModel: boolean;
  /** When true, `stopTask` rejects, as it does for a subagent the harness no longer runs. */
  refusesStopTask: boolean;
  /** When true, `setModel` waits for `releaseModel`, so a stop can happen in the meantime. */
  holdsModel: boolean;
  readonly releaseModel: () => void;
}

const createDriving = (): Driving => {
  const options: Array<Options> = [];
  const sent: Array<SDKUserMessage> = [];
  const seen: Array<HarnessEvent> = [];
  const queued: Array<unknown> = [];
  const waiting: Array<(result: IteratorResult<unknown>) => void> = [];
  const failing: Array<(reason: Error) => void> = [];
  const done: IteratorResult<unknown> = { done: true, value: undefined };
  const models: Array<string> = [];
  let ended = false;
  let closes = 0;
  let interrupts = 0;
  let releaseModel: (() => void) | undefined;
  const stoppedTasks: Array<string> = [];

  const adapter = makeClaudeCodeAdapter({
    query: () => {
      throw new Error("a session must not probe");
    },
    stream: (params) => {
      options.push(params.options);
      // A real harness reads the adapter's input, and reading it is the only
      // way for the test to see the turns the adapter sent.
      void (async () => {
        for await (const message of params.input) sent.push(message);
      })();
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (queued.length > 0) {
              return Promise.resolve({
                done: false,
                value: queued.shift(),
              } as IteratorResult<never>);
            }
            if (ended) return Promise.resolve(done as IteratorResult<never>);
            return new Promise<IteratorResult<never>>((resolve, reject) => {
              waiting.push(resolve as (result: IteratorResult<unknown>) => void);
              failing.push(reject);
            });
          },
        }),
        interrupt: () => {
          interrupts += 1;
          return Promise.resolve();
        },
        setModel: (model) => {
          if (harness.refusesModel) return Promise.reject(new Error(`no such model: ${model}`));
          models.push(model);
          if (!harness.holdsModel) return Promise.resolve();
          return new Promise<void>((resolve) => {
            releaseModel = resolve;
          });
        },
        stopTask: (taskId) => {
          stoppedTasks.push(taskId);
          if (harness.refusesStopTask) return Promise.reject(new Error(`no task ${taskId}`));
          return Promise.resolve();
        },
        close: () => {
          closes += 1;
          ended = true;
          for (const wake of waiting.splice(0)) wake(done);
        },
      };
    },
    run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
  });

  Effect.runFork(
    Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
  );

  const harness: Driving = {
    adapter,
    options,
    sent,
    seen,
    models,
    refusesModel: false,
    refusesStopTask: false,
    holdsModel: false,
    releaseModel: () => releaseModel?.(),
    say: (message) => {
      const wake = waiting.shift();
      if (wake === undefined) queued.push(message);
      else wake({ done: false, value: message });
    },
    end: () => {
      ended = true;
      for (const wake of waiting.splice(0)) wake(done);
    },
    die: (reason) => {
      waiting.splice(0);
      for (const fail of failing.splice(0)) fail(reason);
    },
    closed: () => closes,
    interrupted: () => interrupts,
    stoppedTasks,
  };
  return harness;
};

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "ready",
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 3 },
  modelUsage: {
    "claude-haiku-4-5": {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.01,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
  },
  terminal_reason: "completed",
};

/**
 * How long a test waits for an event from the adapter. The adapter reads the
 * harness asynchronously and publishes what it read, so how many event-loop
 * ticks that takes depends on how busy the machine is. That is why the tests
 * wait for the event itself, not for a fixed number of ticks.
 */
const WAIT_DEADLINE_MS = 10_000;

/**
 * Vitest's test timeout, set from the wait limit instead of the default five
 * seconds. If a wait could outlast the test timeout, the wait would never get
 * to fail, and the failure would name the test instead of the missing event.
 * It allows two waits, because the longest test waits for one turn to close
 * and the next one to open.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 5_000 });

/** Waits for `ready` with this file's longer wait limit. */
const waitUntil = (what: string, ready: () => boolean): Promise<void> =>
  testing.waitUntil(what, ready, WAIT_DEADLINE_MS);

/** Waits until the session has ended, whatever ended it. */
const awaitSessionEnd = (seen: ReadonlyArray<HarnessEvent>): Promise<void> =>
  waitUntil("ended the session", () => seen.some((event) => event._tag === "session.exited"));

const listEventTags = (seen: ReadonlyArray<HarnessEvent>): ReadonlyArray<string> =>
  seen.map((event) => event._tag);

/** Returns the item events of one kind, in the order they were published. */
const filterItems = (
  seen: ReadonlyArray<HarnessEvent>,
  kind: string,
): ReadonlyArray<Extract<HarnessEvent, { _tag: "item.started" | "item.completed" }>> =>
  seen.filter(
    (event): event is Extract<HarnessEvent, { _tag: "item.started" | "item.completed" }> =>
      (event._tag === "item.started" || event._tag === "item.completed") && event.kind === kind,
  );

const listOpenedTurns = (seen: ReadonlyArray<HarnessEvent>): ReadonlyArray<string> =>
  seen.flatMap((event) => (event._tag === "turn.started" ? [event.turnId] : []));

describe("a Claude Code session", () => {
  it("creates the native session id itself, returns the binding and emits session.started", async () => {
    const run = createDriving();
    const binding = await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    expect(binding.sessionId).toBe(SESSION);
    expect(binding.providerAccountId).toBe(SPEC.providerAccountId);
    // Hercule creates the native session id instead of waiting for it: in
    // streaming-input mode the CLI sends nothing until the first turn.
    expect(binding.nativeSessionId).not.toBe(SESSION);
    expect(run.options[0]?.sessionId).toBe(binding.nativeSessionId);
    await waitUntil("said it started", () => run.seen.length === 1);
    expect(listEventTags(run.seen)).toEqual(["session.started"]);
    // This event is the only way the controller learns the native id: the
    // report of this runner's sessions is sent only once, at hello.
    expect(run.seen[0]?.harnessRefs).toEqual({ nativeSessionId: binding.nativeSessionId });
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([binding]);
  });

  describe("the log lines for a message nobody decided how to show", () => {
    /** Starts a session whose log lines at the warning level are collected in `warnings`. */
    const startLogging = async () => {
      const run = createDriving();
      const warnings: Array<string> = [];
      const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(String(message));
      });
      await Effect.runPromise(
        Effect.provide(
          run.adapter.startSession(SESSION, SPEC, WORKING),
          Logger.layer([collecting]),
        ),
      );
      return { run, warnings };
    };

    it("writes one line per label to the log of the process that started the session, and never the message", async () => {
      const { run, warnings } = await startLogging();

      const unknown = { type: "system", subtype: "foo_bar", secret: "do-not-log-this" };
      run.say(unknown);
      run.say(unknown);
      await waitUntil("showed both messages", () => filterItems(run.seen, "unknown").length === 4);

      expect(warnings).toEqual([
        "Claude sent a message type this runner has no decision for: claude: system/foo_bar",
      ]);
    });
  });

  it("runs a workspace-less session in its scratch cwd, with the Harness Home and no setting source", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const [options] = run.options;
    expect(options?.cwd).toBe(WORKING.cwd);
    expect(options?.settingSources).toEqual([]);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.includePartialMessages).toBe(true);
    expect(options?.model).toBe(SPEC.modelSelection.model);
    expect(options?.effort).toBe("high");
    // `auto-accept-edits` maps to Claude's `acceptEdits` (spec 06 section 8.1).
    expect(options?.permissionMode).toBe("acceptEdits");
    expect(options?.env?.["CLAUDE_CONFIG_DIR"]).toBe(WORKING.home);
    expect(options?.env?.["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
    expect(Object.keys(options?.env ?? {})).not.toContain("HOME");
  });

  it("loads the workspace's own CLAUDE.md and .claude/ when the session has a workspace", async () => {
    const run = createDriving();
    const spec: SessionSpec = { ...SPEC, workspaceId: "0199e0e7-0000-7000-8000-00000000000b" };
    await Effect.runPromise(
      run.adapter.startSession(SESSION, spec, { ...CONTEXT, cwd: "/home/me/repo" }),
    );

    const [options] = run.options;
    expect(options?.cwd).toBe("/home/me/repo");
    // Only the project source: this session is not a Thread that sees User
    // Material, so it never reads the Harness Home as the user source
    // (spec 06 section 9.1).
    expect(options?.settingSources).toEqual(["project"]);
    expect(options?.env?.["CLAUDE_CONFIG_DIR"]).toBe(CONTEXT.home);
    expect(options?.env?.["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
    expect(options?.strictMcpConfig).toBe(true);
  });

  it("loads hercule-as-a-tool as a local plugin, and none of the machine's settings", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const [options] = run.options;
    // Hercule's own plugin, loaded from the directory the runner wrote it to,
    // so nothing is copied per session and it never clashes with a Thread's own
    // `.claude/` directory (spec 06 section 9.3).
    expect(options?.plugins).toEqual([{ type: "local", path: HERCULE_TOOL.claudePluginDir }]);
    // Checked together with the plugin: a workspace-less session that sees no
    // User Material loads no setting source at all, so the skill can only
    // come from Hercule's plugin and not from whatever files happen to be on
    // this runner (spec 06 section 10.1).
    expect(options?.settingSources).toEqual([]);
    expect(options?.allowedTools).toBeUndefined();
  });

  it("loads the session skills folder as a second local plugin when the start named skills", async () => {
    const run = createDriving();
    const sessionSkillsFolder = "/runner/session-skills/0199e0e7";
    await Effect.runPromise(
      run.adapter.startSession(SESSION, SPEC, {
        ...WORKING,
        librarySkillsFolder: sessionSkillsFolder,
        sessionSkillsFolder,
      }),
    );

    const [options] = run.options;
    expect(options?.plugins).toEqual([
      { type: "local", path: HERCULE_TOOL.claudePluginDir },
      { type: "local", path: sessionSkillsFolder },
    ]);
    // The agent may read the skills' other files without asking, and only read them.
    expect(options?.allowedTools).toEqual(["Read(//runner/session-skills/0199e0e7/**)"]);
  });

  it("lets the agent read the session skills folder when the session has repository skills only", async () => {
    const run = createDriving();
    const sessionSkillsFolder = "/runner/session-skills/0199e0e7";
    const repositorySkillsFolders = [`${sessionSkillsFolder}/repositories/web`];
    await Effect.runPromise(
      run.adapter.startSession(SESSION, SPEC, {
        ...WORKING,
        sessionSkillsFolder,
        repositorySkillsFolders,
      }),
    );

    const [options] = run.options;
    // No library skills: the folder is not a `skills` plugin, only the
    // repository folder below it is a plugin.
    expect(options?.plugins).toEqual([
      { type: "local", path: HERCULE_TOOL.claudePluginDir },
      { type: "local", path: repositorySkillsFolders[0] },
    ]);
    // A repository skill may tell the agent to read the files of its folder,
    // which are reached through this same folder.
    expect(options?.allowedTools).toEqual(["Read(//runner/session-skills/0199e0e7/**)"]);
  });

  it("loads each repository skills folder as a local plugin after the session skills folder", async () => {
    const run = createDriving();
    const librarySkillsFolder = "/runner/session-skills/0199e0e7";
    const repositorySkillsFolders = [
      "/runner/repo-skills/0199e0e7/a",
      "/runner/repo-skills/0199e0e7/b",
    ];
    await Effect.runPromise(
      run.adapter.startSession(SESSION, SPEC, {
        ...WORKING,
        librarySkillsFolder,
        repositorySkillsFolders,
      }),
    );

    const [options] = run.options;
    expect(options?.plugins).toEqual([
      { type: "local", path: HERCULE_TOOL.claudePluginDir },
      { type: "local", path: librarySkillsFolder },
      { type: "local", path: repositorySkillsFolders[0] },
      { type: "local", path: repositorySkillsFolders[1] },
    ]);
  });

  /** The workspace spec the native-skill tests use: a session whose project source is loaded. */
  const WORKSPACE_SPEC: SessionSpec = {
    ...SPEC,
    workspaceId: "0199e0e7-0000-7000-8000-00000000000b",
  };

  /** Makes `<directory>/.claude/skills/<name>` for each name. */
  const layOutNativeSkills = (directory: string, names: ReadonlyArray<string>): void => {
    for (const name of names) {
      mkdirSync(join(directory, ".claude", "skills", name), { recursive: true });
    }
  };

  /** Starts a session and returns the options Claude got, with the file named by `settings` read. */
  /** The settings file a session start writes, as far as these tests read it. */
  interface StoredSettings {
    readonly crossSessionInbound: string;
    readonly skillOverrides: Record<string, string>;
  }

  const startAndReadSettings = async (spec: SessionSpec, ctx: HarnessRunnerContext) => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, spec, ctx));
    const [options] = run.options;
    const settings = options?.settings;
    return {
      options,
      settings,
      stored: (typeof settings === "string"
        ? JSON.parse(readFileSync(settings, "utf8"))
        : settings) as StoredSettings,
    };
  };

  it("turns off every skill in the working directory's .claude/skills, so a repository skill is listed once", async () => {
    const root = mkdtempSync(join(tmpdir(), "hercule-claude-native-skills-"));
    try {
      const cwd = join(root, "cwd");
      const sessionSkillsFolder = join(root, "session-skills");
      layOutNativeSkills(cwd, ["release"]);
      // A name the runner skips when it stages the skills still loads natively.
      layOutNativeSkills(cwd, ["My_Skill"]);
      // A stray file is not a skill and gets no override.
      writeFileSync(join(cwd, ".claude", "skills", ".DS_Store"), "");

      const { options, settings, stored } = await startAndReadSettings(WORKSPACE_SPEC, {
        ...WORKING,
        cwd,
        sessionSkillsFolder,
      });

      // The overrides can be long, so they travel in a file, not as an argument.
      expect(settings).toBe(join(sessionSkillsFolder, "claude-settings.json"));
      expect(stored).toEqual({
        disableAgentView: true,
        disableRemoteControl: true,
        crossSessionInbound: "refuse",
        skillOverrides: { release: "off", My_Skill: "off" },
      });
      // CLAUDE.md files load through the project source, so it stays.
      expect(options?.settingSources).toEqual(["project"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("turns off the skills of every checkout too, because Claude loads them when the session reads there", async () => {
    const root = mkdtempSync(join(tmpdir(), "hercule-claude-native-skills-"));
    try {
      // A workspace with two checkouts: the working directory is above them.
      const cwd = join(root, "workspace");
      const web = join(cwd, "web");
      const api = join(cwd, "api");
      layOutNativeSkills(web, ["from-web", "shared"]);
      layOutNativeSkills(api, ["from-api", "shared"]);
      layOutNativeSkills(cwd, ["from-root"]);

      const { stored } = await startAndReadSettings(WORKSPACE_SPEC, {
        ...WORKING,
        cwd,
        checkoutPaths: [web, api],
        sessionSkillsFolder: join(root, "session-skills"),
      });

      // One entry per folder name, a name two checkouts share only once.
      expect(stored.skillOverrides).toEqual({
        "from-root": "off",
        "from-web": "off",
        shared: "off",
        "from-api": "off",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("turns off the skills a checkout links to, by the names of the link's folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "hercule-claude-native-skills-"));
    try {
      // A committed link from the checkout to a folder outside it: Claude
      // would load whatever is in the folder, under the folder's names.
      const outside = join(root, "elsewhere", "skills");
      mkdirSync(join(outside, "private-skill"), { recursive: true });
      const web = join(root, "workspace", "web");
      mkdirSync(join(web, ".claude"), { recursive: true });
      symlinkSync(outside, join(web, ".claude", "skills"));

      const { stored } = await startAndReadSettings(WORKSPACE_SPEC, {
        ...WORKING,
        cwd: join(root, "workspace"),
        checkoutPaths: [web],
        sessionSkillsFolder: join(root, "session-skills"),
      });

      expect(stored.skillOverrides).toEqual({ "private-skill": "off" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps every override when the skills are too many for a command-line argument", async () => {
    const root = mkdtempSync(join(tmpdir(), "hercule-claude-native-skills-"));
    try {
      // Linux refuses one argument over 128 KiB. These names alone are over 300 KiB.
      const cwd = join(root, "cwd");
      const names = Array.from(
        { length: 5000 },
        (_, at) => `skill-${String(at).padStart(5, "0")}-${"x".repeat(50)}`,
      );
      layOutNativeSkills(cwd, names);

      const { settings, stored } = await startAndReadSettings(WORKSPACE_SPEC, {
        ...WORKING,
        cwd,
        sessionSkillsFolder: join(root, "session-skills"),
      });

      expect(typeof settings).toBe("string");
      expect(Object.keys(stored.skillOverrides).sort()).toEqual([...names].sort());
      expect(stored.crossSessionInbound).toBe("refuse");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses the start, with the reason, when the .claude/skills folders hold more entries than the runner reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "hercule-claude-native-skills-"));
    try {
      // Plain files count as entries too, and are cheaper to make than folders.
      const skills = join(root, "cwd", ".claude", "skills");
      mkdirSync(skills, { recursive: true });
      for (let at = 0; at <= 10_000; at += 1) writeFileSync(join(skills, `file-${String(at)}`), "");
      const run = createDriving();

      const reason = await Effect.runPromise(
        Effect.flip(
          run.adapter.startSession(SESSION, WORKSPACE_SPEC, {
            ...WORKING,
            cwd: join(root, "cwd"),
            sessionSkillsFolder: join(root, "session-skills"),
          }),
        ),
      );

      // A session that started with only the names read so far would load the others natively.
      expect(reason).toBeInstanceOf(AdapterFailed);
      expect(reason.message).toBe(
        "The runner could not turn off the skills Claude Code would load natively from `.claude/skills`: the workspace's `.claude/skills` folders hold more than 10000 entries in all, plain files included. Keep them to 10000 entries or fewer. The Thread did not start.",
      );
      expect(run.options).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the settings inline when there is no skill to turn off", async () => {
    const root = mkdtempSync(join(tmpdir(), "hercule-claude-native-skills-"));
    try {
      const sessionSkillsFolder = join(root, "session-skills");
      const { settings } = await startAndReadSettings(WORKSPACE_SPEC, {
        ...WORKING,
        cwd: join(root, "cwd"),
        sessionSkillsFolder,
      });

      expect(settings).toEqual({
        disableAgentView: true,
        disableRemoteControl: true,
        crossSessionInbound: "refuse",
      });
      // Nothing was written, so the folder was not made for it.
      expect(existsSync(sessionSkillsFolder)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("turns off no native skill for a session that loads no project source", async () => {
    const root = mkdtempSync(join(tmpdir(), "hercule-claude-native-skills-"));
    try {
      const cwd = join(root, "cwd");
      layOutNativeSkills(cwd, ["release"]);

      const { settings } = await startAndReadSettings(SPEC, { ...WORKING, cwd });

      expect(settings).toEqual({
        disableAgentView: true,
        disableRemoteControl: true,
        crossSessionInbound: "refuse",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads the user source for a Thread that sees User Material, so it reads the links in the Harness Home", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, THREAD));

    const [options] = run.options;
    expect(options?.cwd).toBe(THREAD.cwd);
    expect(options?.settingSources).toEqual(["user"]);
    // The user source is the config directory, which stays the account's
    // home: the runner linked the user's material there (spec 06 section 9.1).
    expect(options?.env?.["CLAUDE_CONFIG_DIR"]).toBe(THREAD.home);
    // User Material is skills and instructions only. MCP servers and auto
    // memory stay off for a Thread, as for every other session.
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.env?.["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
    expect(options?.plugins).toEqual([{ type: "local", path: HERCULE_TOOL.claudePluginDir }]);
  });

  it("loads the user and project sources for a Thread with a workspace that sees User Material", async () => {
    const run = createDriving();
    const spec: SessionSpec = { ...SPEC, workspaceId: "0199e0e7-0000-7000-8000-00000000000b" };
    await Effect.runPromise(
      run.adapter.startSession(SESSION, spec, { ...THREAD, cwd: "/home/me/repo" }),
    );

    const [options] = run.options;
    expect(options?.cwd).toBe("/home/me/repo");
    expect(options?.settingSources).toEqual(["user", "project"]);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.env?.["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
  });

  // The Claude permission mode for each access mode (spec 06 section 8.1). The
  // full-access row matters most: it is the one mode that turns off every
  // approval, and it needs `allowDangerouslySkipPermissions` as well.
  const MODES: ReadonlyArray<readonly [SessionSpec["accessMode"], string, boolean | undefined]> = [
    ["approval-required", "default", undefined],
    ["auto-accept-edits", "acceptEdits", undefined],
    ["auto", "auto", undefined],
    ["full-access", "bypassPermissions", true],
  ];

  for (const [accessMode, permissionMode, dangerous] of MODES) {
    it(`runs ${accessMode} as the harness's ${permissionMode}`, async () => {
      const run = createDriving();
      await Effect.runPromise(run.adapter.startSession(SESSION, { ...SPEC, accessMode }, WORKING));

      expect(run.options[0]?.permissionMode).toBe(permissionMode);
      expect(run.options[0]?.allowDangerouslySkipPermissions).toBe(dangerous);
      // The callback is passed in every mode, full-access included: without
      // it the harness leaves out `AskUserQuestion`.
      expect(typeof run.options[0]?.canUseTool).toBe("function");
    });
  }

  it("opens a turn on an idle session, and reports the delivery as opened", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    // The adapter reports the delivery itself; the controller does not infer
    // it from the order the events arrive in (ADR 0007).
    expect(sent.delivery).toBe("opened");
    await waitUntil(
      "published the user's own message",
      () => filterItems(run.seen, "user_message").length === 2,
    );
    // The returned turn id is the id of the turn that was opened.
    expect(listOpenedTurns(run.seen)).toEqual([sent.turnId]);
    const [started, completed] = filterItems(run.seen, "user_message");
    expect(started?._tag).toBe("item.started");
    expect(completed?._tag).toBe("item.completed");
    // No `steered` key at all: an input that opened a turn did not steer one,
    // and `steered: false` would be a third state that the spec does not define.
    expect(started?.detail).toEqual({ text: "hello" });
    expect(completed?.detail).toEqual({ text: "hello" });
    expect(started?.turnId).toBe(sent.turnId);
    expect(run.sent.map((message) => message.message.content)).toEqual(["hello"]);
  });

  it("sends attached images as base64 blocks after the text, and lets the harness read their directory", async () => {
    const run = createDriving();
    const image = testing.writeTestImage();
    const attachmentsDir = dirname(image.path);
    await Effect.runPromise(
      run.adapter.startSession(SESSION, SPEC, { ...WORKING, attachmentsDir }),
    );

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "what is this?", attachments: [image] }),
    );

    // Without the directory, a session that asks before reading outside its
    // workspace would ask the user before it reads its own image.
    expect(run.options[0]?.additionalDirectories).toEqual([attachmentsDir]);
    await waitUntil("sent the turn", () => run.sent.length === 1);
    expect(run.sent[0]?.message.content).toEqual([
      {
        type: "text",
        text: `what is this?\n\n[Attached image "screenshot.png" is saved at: ${image.path}]`,
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: testing.PNG_BYTES.toString("base64"),
        },
      },
    ]);
    // The transcript keeps the user's own text and lists the image by its
    // reference: never its path on this machine or its checksum.
    await waitUntil(
      "published the user's own message",
      () => filterItems(run.seen, "user_message").length === 2,
    );
    expect(filterItems(run.seen, "user_message")[1]?.detail).toEqual({
      text: "what is this?",
      attachments: [
        { id: image.id, name: image.name, mimeType: image.mimeType, sizeBytes: image.sizeBytes },
      ],
    });
  });

  it("tells the agent which session sent a message, and reports the sender beside the original text", async () => {
    const run = createDriving();
    const sender = "0199e0e7-0000-7000-8000-0000000000e1";
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "rebase on main", senderSessionId: sender }),
    );

    await waitUntil("sent the turn", () => run.sent.length === 1);
    expect(run.sent[0]?.message.content).toBe(
      `[Message from session ${sender}, another agent. To reply: hercule session input ${sender}]\n\nrebase on main`,
    );
    await waitUntil(
      "published the user's own message",
      () => filterItems(run.seen, "user_message").length === 2,
    );
    expect(filterItems(run.seen, "user_message")[1]?.detail).toEqual({
      text: "rebase on main",
      senderSessionId: sender,
    });
  });

  it("steers input on a busy session into the turn already running", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const first = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    const second = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "and this" }));

    expect(second).toEqual({ turnId: first.turnId, delivery: "steered" });
    await waitUntil(
      "published both user messages",
      () => filterItems(run.seen, "user_message").length === 4 && run.sent.length === 2,
    );
    // Only one turn was opened: the steered input joined the running turn.
    expect(listOpenedTurns(run.seen)).toEqual([first.turnId]);
    const [, , started, completed] = filterItems(run.seen, "user_message");
    expect(started?.detail).toEqual({ text: "and this", steered: true });
    expect(completed?.detail).toEqual({ text: "and this", steered: true });
    expect(run.sent.map((message) => message.message.content)).toEqual(["hello", "and this"]);
  });

  it("refuses an input with a skill while a turn is open, before it changes anything", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    await waitUntil("sent the first turn", () => run.sent.length === 1);
    const seenBefore = run.seen.length;

    const refusal = await Effect.runPromise(
      Effect.flip(run.adapter.sendInput(SESSION, buildSkillInput("please $review this"))),
    );

    expect(refusal).toBeInstanceOf(SteerRefused);
    expect(refusal).toMatchObject({
      message:
        "Not steered: Claude Code can't start a skill in the middle of a turn. The input stays queued and runs when this turn ends.",
    });
    // Nothing reached the harness and nothing was published.
    expect(run.sent).toHaveLength(1);
    expect(run.seen).toHaveLength(seenBefore);
  });

  it("steers an input without a skill while a turn is open", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    const sent = await Effect.runPromise(
      run.adapter.sendInput(SESSION, buildSkillInput("a price of $20 and $nothing")),
    );

    expect(sent.delivery).toBe("steered");
  });

  it("opens a turn for an input with a skill when the session is idle", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const sent = await Effect.runPromise(
      run.adapter.sendInput(SESSION, buildSkillInput("$review the diff")),
    );

    expect(sent.delivery).toBe("opened");
    await waitUntil("sent the turn", () => run.sent.length === 1);
    expect(run.sent[0]?.message.content).toBe("/skills:review the diff");
  });

  it("sends the images before the skill command, which stays the last block", async () => {
    const run = createDriving();
    const image = testing.writeTestImage();
    await Effect.runPromise(
      run.adapter.startSession(SESSION, SPEC, {
        ...WORKING,
        attachmentsDir: dirname(image.path),
      }),
    );

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        ...buildSkillInput("look at this, $review it"),
        attachments: [image],
      }),
    );

    await waitUntil("sent the turn", () => run.sent.length === 1);
    expect(run.sent[0]?.message.content).toEqual([
      {
        type: "text",
        text: `look at this,\n\n[Attached image "screenshot.png" is saved at: ${image.path}]`,
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: testing.PNG_BYTES.toString("base64"),
        },
      },
      { type: "text", text: "/skills:review it" },
    ]);
  });

  it("does not report the user's message twice when the harness repeats the input back", async () => {
    const run = createDriving();
    const binding = await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    await waitUntil(
      "published the user's own message",
      () => filterItems(run.seen, "user_message").length === 2,
    );

    // The CLI sends back a copy of the input it was given.
    run.say({
      type: "user",
      session_id: binding.nativeSessionId,
      parent_tool_use_id: null,
      message: { role: "user", content: "hello" },
    });
    // Waiting for the result proves the repeated input was processed, because it
    // arrives after it.
    run.say(RESULT);
    await waitUntil("closed the turn", () =>
      run.seen.some((event) => event._tag === "turn.completed"),
    );

    expect(filterItems(run.seen, "user_message")).toHaveLength(2);
  });

  it("opens a second turn after the result closed the first", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    run.say(RESULT);
    await waitUntil("closed the first turn", () =>
      run.seen.some((event) => event._tag === "turn.completed"),
    );

    const again = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "again" }));
    await waitUntil("opened the second turn", () => listOpenedTurns(run.seen).length === 2);
    expect(again.delivery).toBe("opened");
    expect(
      listEventTags(run.seen).filter((tag) => tag.startsWith("turn.") || tag === "session.started"),
    ).toEqual(["session.started", "turn.started", "turn.completed", "turn.started"]);
    expect(listOpenedTurns(run.seen)[1]).toBe(again.turnId);
  });

  it("interrupts the running turn, and sends nothing to the harness when no turn is running", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    // Idle: nothing is sent to the harness, because a control request waits
    // for a reply and the connection handles a session's frames one at a time.
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(run.interrupted()).toBe(0);

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(run.interrupted()).toBe(1);

    await Effect.runPromise(run.adapter.interrupt("0199e0e7-0000-7000-8000-0000000000aa"));
    expect(run.interrupted()).toBe(1);
  });

  it("leaves the session's own turn running on an interrupt that names a subagent", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    // The user asked to stop one subagent, not the session's own turn. The
    // harness runs no such subagent, so there is nothing to stop, and the
    // user is told so.
    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-1"));
    expect(run.interrupted()).toBe(0);
    expect(run.stoppedTasks).toEqual([]);
    const warning = run.seen.find((event) => event._tag === "runtime.warning");
    expect(warning?._tag === "runtime.warning" ? warning.message : undefined).toBe(
      "subagent agent-1 is not known to this process, so nothing was stopped",
    );

    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(run.interrupted()).toBe(1);
  });

  it("interrupts while the session's own agent is idle and only a subagent works", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await openSubagentTurn(run, "agent-b");

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    // The harness's own interrupt stops every subagent (spec 06 section 13.4).
    expect(run.interrupted()).toBe(1);
    expect(run.stoppedTasks).toEqual([]);
  });

  it("asks the harness for every subagent's text, and keeps interrupt stopping background subagents", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    expect(run.options[0]?.forwardSubagentText).toBe(true);
    // Unset, an interrupt also stops every background subagent, which Stop
    // relies on (spec 06 section 13.4).
    expect(run.options[0]?.perTaskStopAffordance).toBeUndefined();
  });

  it("resumes the given native session under its existing id", async () => {
    const run = createDriving();
    const carried = {
      nativeSessionId: "0199e0e7-0000-7000-8000-0000000000ab",
      mode: "resume",
    } as const;
    const binding = await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, continue: carried }, WORKING),
    );

    // A resume continues that native session, so no new id is needed.
    expect(binding.nativeSessionId).toBe(carried.nativeSessionId);
    expect(run.options[0]?.resume).toBe(carried.nativeSessionId);
    expect(run.options[0]?.forkSession).toBeUndefined();
    expect(run.options[0]?.sessionId).toBeUndefined();
  });

  it("forks the given native session under a new id", async () => {
    const run = createDriving();
    const carried = {
      nativeSessionId: "0199e0e7-0000-7000-8000-0000000000ab",
      mode: "fork",
    } as const;
    const binding = await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, continue: carried }, WORKING),
    );

    expect(binding.nativeSessionId).not.toBe(carried.nativeSessionId);
    expect(run.options[0]?.resume).toBe(carried.nativeSessionId);
    expect(run.options[0]?.forkSession).toBe(true);
    // The adapter creates the fork's id for the same reason as for a new
    // session: the CLI sends nothing until the first turn, so the binding
    // cannot wait for the CLI's id.
    expect(run.options[0]?.sessionId).toBe(binding.nativeSessionId);
  });

  it("fails the input when the session was stopped while the model was changing", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    run.holdsModel = true;

    const sending = Effect.runPromise(
      Effect.flip(
        run.adapter.sendInput(SESSION, {
          text: "hello",
          modelSelection: { model: "claude-opus-4-8", options: {} },
        }),
      ),
    );
    await waitUntil("asked the harness for the model", () => run.models.length === 1);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    run.releaseModel();

    // The session is gone. Reporting the input as delivered would make the
    // user believe a message was sent when it was not.
    expect(await sending).toMatchObject({ _tag: "SessionNotRunning" });
    expect(run.sent).toEqual([]);
  });

  it.each([false, true])(
    "refuses delayed input after Stop while the model is changing, with a working subagent: %s",
    async (subagentWorking) => {
      const run = createDriving();
      await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
      if (subagentWorking) await openSubagentTurn(run, "agent-b");
      run.holdsModel = true;
      const sending = Effect.runPromise(
        Effect.flip(
          run.adapter.sendInput(SESSION, {
            text: "do not resurrect this input",
            modelSelection: { model: "claude-opus-4-8", options: {} },
          }),
        ),
      );
      await waitUntil("asked the harness for the model", () => run.models.length === 1);
      await Effect.runPromise(run.adapter.interrupt(SESSION));
      run.releaseModel();
      const refusal = await sending;
      expect(refusal).toBeInstanceOf(InputNotDelivered);
      expect(refusal.message).toContain("stopped");
      expect(run.sent).toEqual([]);
      expect(run.interrupted()).toBe(subagentWorking ? 1 : 0);
      expect(
        run.seen.filter((event) => event._tag === "turn.started" && event.subagentId === undefined),
      ).toEqual([]);
      run.holdsModel = false;
      await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "new input" }));
      await waitUntil("received the new input", () => run.sent.length === 1);
      expect(run.sent[0]!.message.content).toEqual("new input");
    },
  );

  it("keeps pending root input when Stop names a subagent", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await openSubagentTurn(run, "agent-b");
    run.holdsModel = true;
    const sending = Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "continue the root's work",
        modelSelection: { model: "claude-opus-4-8", options: {} },
      }),
    );
    await waitUntil("asked the harness for the model", () => run.models.length === 1);

    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-b"));
    run.releaseModel();

    expect(await sending).toMatchObject({ delivery: "opened" });
    await waitUntil("received the root input", () => run.sent.length === 1);
    expect(run.sent[0]!.message.content).toEqual("continue the root's work");
    expect(run.interrupted()).toBe(0);
    expect(run.stoppedTasks).toEqual(["agent-b"]);
  });

  it("exits as stopped when stopped, and removes the session", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    await awaitSessionEnd(run.seen);

    expect(run.closed()).toBe(1);
    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("stopped");
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });

  it("keeps the first reason when a second stop asks for a different one", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "inactivity_timeout"));
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    await awaitSessionEnd(run.seen);

    expect(run.closed()).toBe(1);
    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe(
      "inactivity_timeout",
    );
  });

  it("exits as a process exit when the harness stops on its own", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    run.end();
    await awaitSessionEnd(run.seen);

    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("process_exit");
  });

  it("reports a crash and its error message when the harness's stream throws", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    run.die(new Error("the harness went away"));
    await awaitSessionEnd(run.seen);

    const failure = run.seen.find((event) => event._tag === "runtime.error");
    expect(failure?._tag === "runtime.error" ? failure.message : undefined).toBe(
      "the harness went away",
    );
    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("crash");
  });

  it("does not report an ordinary stop as a runtime error", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    run.die(new Error("Query closed before response received"));
    await awaitSessionEnd(run.seen);

    expect(listEventTags(run.seen)).toEqual(["session.started", "session.exited"]);
  });

  it("fails input for a session it is not hosting", async () => {
    const run = createDriving();
    const said = await Effect.runPromise(
      Effect.flip(run.adapter.sendInput(SESSION, { text: "hello" })),
    );
    expect(said).toBeInstanceOf(SessionNotRunning);
    expect(said.message).toContain("not running");
  });

  it("fails input as soon as a stop was requested, instead of dropping it", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    const said = await Effect.runPromise(
      Effect.flip(run.adapter.sendInput(SESSION, { text: "hello" })),
    );

    expect(said).toBeInstanceOf(SessionNotRunning);
  });

  it("fails to start a second harness under a session id it already hosts", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const said = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, SPEC, WORKING)),
    );

    expect(said).toBeInstanceOf(SessionAlreadyRunning);
    expect(said.message).toContain("already running");
    // The session that was already running is untouched: one harness, one stream.
    expect(run.options.length).toBe(1);
    expect(run.closed()).toBe(0);
  });

  it("fails to start when the harness is not installed on this machine", async () => {
    const run = createDriving();
    const said = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, SPEC, { ...WORKING, binary: undefined })),
    );
    expect(said).toBeInstanceOf(HarnessNotInstalled);
    expect(said.message).toContain("not installed");
  });

  it("fails to start with AdapterFailed when launching the harness throws anything else", async () => {
    const adapter = makeClaudeCodeAdapter({
      query: () => {
        throw new Error("a session must not probe");
      },
      stream: () => {
        throw new Error("the options were refused");
      },
      run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    });
    const said = await Effect.runPromise(Effect.flip(adapter.startSession(SESSION, SPEC, WORKING)));
    expect(said).toBeInstanceOf(AdapterFailed);
    expect(said.message).toContain("the options were refused");
  });

  it("fails the input with AdapterFailed, naming the image, when a cached image cannot be read", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    const image = testing.writeTestImage();
    const said = await Effect.runPromise(
      Effect.flip(
        run.adapter.sendInput(SESSION, {
          text: "what is this?",
          attachments: [{ ...image, name: "gone.png", path: `${image.path}.missing` }],
        }),
      ),
    );
    expect(said).toBeInstanceOf(AdapterFailed);
    expect(said.message).toContain("gone.png");
    expect(run.sent).toEqual([]);
  });
});

/**
 * `sendInput` calls `setModel` only when an input that opens a turn asks for a
 * different model from the one last applied to the harness. That starts as the
 * session spec's model from `startSession`.
 */
describe("changing the model", () => {
  it("calls setModel before the input is pushed, and reports the delivery as opened", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    run.holdsModel = true;

    const sending = Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "hello",
        modelSelection: { model: "claude-opus-4-8", options: {} },
      }),
    );
    await waitUntil("asked the harness for the model", () => run.models.length === 1);
    // The input has not been sent yet, because the harness has not yet
    // accepted the model.
    expect(run.sent).toEqual([]);
    run.releaseModel();

    const result = await sending;
    expect(result.delivery).toBe("opened");
    expect(run.sent.map((message) => message.message.content)).toEqual(["hello"]);
  });

  it("does not call setModel again for the same model on a later opening input", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    const selection = { model: "claude-opus-4-8", options: {} };

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "hello", modelSelection: selection }),
    );
    expect(run.models).toEqual(["claude-opus-4-8"]);

    // Close the turn, so the next input opens a new turn instead of joining
    // the running one.
    run.say(RESULT);
    await waitUntil("closed the first turn", () =>
      run.seen.some((event) => event._tag === "turn.completed"),
    );

    const second = await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "again", modelSelection: selection }),
    );

    // The model is the one last applied, so setModel is not called again.
    expect(run.models).toEqual(["claude-opus-4-8"]);
    expect(second.delivery).toBe("opened");
  });

  it("does not call setModel when the first input asks for the model the session started with", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    // The harness already runs this model, so there is nothing to change.
    const result = await Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "hello",
        modelSelection: { model: SPEC.modelSelection.model, options: {} },
      }),
    );

    expect(run.models).toEqual([]);
    expect(result.delivery).toBe("opened");
  });

  it("does not call setModel during a turn, whatever model the input asks for, and steers", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const first = await Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "hello",
        modelSelection: { model: "claude-opus-4-8", options: {} },
      }),
    );
    expect(run.models).toEqual(["claude-opus-4-8"]);

    // The running turn already uses the first model, so input that asks for
    // another model during the turn joins the running turn, and nothing is
    // sent to the harness.
    const second = await Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "and this",
        modelSelection: { model: "claude-haiku-4-5", options: {} },
      }),
    );

    expect(run.models).toEqual(["claude-opus-4-8"]);
    expect(second).toEqual({ turnId: first.turnId, delivery: "steered" });
  });

  it("fails the input with the model in the error when setModel rejects, and does not send it", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    run.refusesModel = true;

    const said = await Effect.runPromise(
      Effect.flip(
        run.adapter.sendInput(SESSION, {
          text: "hello",
          modelSelection: { model: "claude-opus-4-8", options: {} },
        }),
      ),
    );

    expect(said).toBeInstanceOf(ModelChangeRefused);
    expect(said.message).toContain("claude-opus-4-8");
    expect(said.message).toContain("input was not sent");
    expect(run.sent).toEqual([]);
    // Sending it under the old model would run a turn nobody asked for, and
    // the caller would never learn that the model change failed.
    expect(listEventTags(run.seen)).toEqual(["session.started"]);

    // The failed change applied nothing, so the next input tries again instead
    // of treating the rejected model as applied.
    run.refusesModel = false;
    const retried = await Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "hello",
        modelSelection: { model: "claude-opus-4-8", options: {} },
      }),
    );
    expect(run.models).toEqual(["claude-opus-4-8"]);
    expect(retried.delivery).toBe("opened");
  });

  it("fails the input as a lost conversation, not a refusal, when the harness never answers the model change", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    run.holdsModel = true;

    const said = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sending = yield* Effect.forkChild(
            Effect.flip(
              run.adapter.sendInput(SESSION, {
                text: "hello",
                modelSelection: { model: "claude-opus-4-8", options: {} },
              }),
            ),
          );
          while (run.models.length === 0) yield* Effect.yieldNow;
          yield* TestClock.adjust(CONTROL_DEADLINE);
          return yield* Fiber.join(sending);
        }),
        TestClock.layer(),
      ),
    );

    // The model may have changed, so "the session keeps its current model" would be a guess.
    expect(said._tag).toBe("HarnessProtocolError");
    expect(said.message).toContain("did not answer");
    expect(run.sent).toEqual([]);
  });
});

/**
 * Tests for the park. The harness asks for approval through
 * `options.canUseTool`, so a test does what the CLI does: it calls the
 * callback the adapter passed, and checks the events the session emits.
 */
const TOOL_USE = "toolu_0199e0e70000700080000000000001";

/** The rules the CLI suggests saving for "allow always", in the SDK's format. */
const SUGGESTIONS: ReadonlyArray<PermissionUpdate> = [
  {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
    behavior: "allow",
    destination: "session",
  },
];

/** A tool call the harness asked about, and how the request ended. */
interface Park {
  /** Returns what the callback resolved to, or `undefined` while the park is open. */
  readonly settled: () => PermissionResult | null | undefined;
  /** Withdraws the request the way the CLI does, by aborting the signal. */
  readonly abort: () => void;
}

const parkToolCall = (
  run: Driving,
  toolName: string,
  input: Record<string, unknown>,
  extra: {
    readonly suggestions?: ReadonlyArray<PermissionUpdate>;
    readonly toolUseID?: string;
    /** The subagent that asks. Absent when the session's own agent asks. */
    readonly agentID?: string;
  } = {},
): Park => {
  const callback = run.options[0]?.canUseTool;
  expect(typeof callback, "the adapter supplied no canUseTool to park on").toBe("function");
  const aborting = new AbortController();
  let settled: PermissionResult | null | undefined;
  void callback?.(toolName, input, {
    signal: aborting.signal,
    toolUseID: extra.toolUseID ?? TOOL_USE,
    requestId: "cr-1",
    ...(extra.agentID === undefined ? {} : { agentID: extra.agentID }),
    ...(extra.suggestions === undefined ? {} : { suggestions: [...extra.suggestions] }),
  }).then((answer) => {
    settled = answer;
  });
  return { settled: () => settled, abort: () => aborting.abort() };
};

/** Sends the user's decision on a request to the adapter. */
const respond = (run: Driving, requestId: string, decision: ApprovalDecision): Promise<void> =>
  Effect.runPromise(run.adapter.respondToApprovalRequest(SESSION, requestId, decision));

const listOpenedRequests = (seen: ReadonlyArray<HarnessEvent>): ReadonlyArray<OpenRequest> =>
  seen.flatMap((event) => (event._tag === "request.opened" ? [event.request] : []));

/**
 * Returns who asked each request that opened, or each that resolved, as `tag`
 * picks: the subagent id, or `undefined` for the session's own agent.
 */
const listRequestAskers = (
  seen: ReadonlyArray<HarnessEvent>,
  tag: "request.opened" | "request.resolved",
): ReadonlyArray<{ readonly requestId: string; readonly subagentId: string | undefined }> =>
  seen.flatMap((event) => {
    if (event._tag !== tag) return [];
    const requestId = event._tag === "request.opened" ? event.request.requestId : event.requestId;
    return event._tag === "request.opened" || event._tag === "request.resolved"
      ? [{ requestId, subagentId: event.subagentId }]
      : [];
  });

/** Returns how each request was resolved: its decision or its answers. */
const listResolutions = (seen: ReadonlyArray<HarnessEvent>): ReadonlyArray<unknown> =>
  seen.flatMap((event): ReadonlyArray<unknown> =>
    event._tag !== "request.resolved"
      ? []
      : "decision" in event
        ? [{ requestId: event.requestId, decision: event.decision }]
        : [{ requestId: event.requestId, answers: event.answers }],
  );

/** Returns the rules an allow saved, or an empty list for any other result. */
const readPersisted = (settled: PermissionResult | null | undefined): ReadonlyArray<unknown> =>
  settled !== null && settled !== undefined && settled.behavior === "allow"
    ? (settled.updatedPermissions ?? [])
    : [];

/**
 * Returns a deny's message and whether it ended the turn. Any other result
 * returns an empty message with `interrupt: true`, so an assertion on either
 * field fails for it.
 */
const readDenial = (
  settled: PermissionResult | null | undefined,
): { readonly message: string; readonly interrupt: boolean } =>
  settled !== null && settled !== undefined && settled.behavior === "deny"
    ? { message: settled.message, interrupt: settled.interrupt ?? false }
    : { message: "", interrupt: true };

/**
 * Starts a session in `accessMode` with a turn open, ready for a tool call to
 * be asked about.
 */
const startSessionWithTurn = async (accessMode: SessionSpec["accessMode"]): Promise<Driving> => {
  const run = createDriving();
  await Effect.runPromise(run.adapter.startSession(SESSION, { ...SPEC, accessMode }, WORKING));
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "list the files" }));
  return run;
};

/** Starts a session in `approval-required` with a turn open. */
const startApprovalSession = (): Promise<Driving> => startSessionWithTurn("approval-required");

/** Parks on one tool call and returns the park and the request the adapter emitted. */
const parkAndAwaitRequest = async (
  run: Driving,
  toolName: string,
  input: Record<string, unknown>,
  extra: Parameters<typeof parkToolCall>[3] = {},
): Promise<{ readonly park: Park; readonly request: OpenRequest }> => {
  const before = listOpenedRequests(run.seen).length;
  const park = parkToolCall(run, toolName, input, extra);
  await waitUntil("opened the request", () => listOpenedRequests(run.seen).length === before + 1);
  return { park, request: listOpenedRequests(run.seen)[before]! };
};

/**
 * A test subagent's agent call, the `Agent` tool_use that started it, is its
 * id with a prefix. The frames it sends come from `claude-code.testing.ts`.
 */
const buildAgentCallId = (subagentId: string): string => `toolu_agent_${subagentId}`;

/** Builds the `Agent` call with which one subagent starts another. */
const buildChildAgentCall = (parentId: string, subagentId: string) =>
  buildAgentCall(buildAgentCallId(parentId), buildAgentCallId(subagentId));

/** Builds the `task_started` that links a subagent to its agent call. */
const buildSubagentStarted = (subagentId: string) =>
  buildTaskStarted(subagentId, buildAgentCallId(subagentId));

/** Builds a subagent's assistant message, which opens its turn when none is open. */
const buildSubagentWords = (subagentId: string) =>
  buildSubagentText(buildAgentCallId(subagentId), `msg-text-${subagentId}`, "looking");

/** Builds the `task_notification` that reports a subagent finished. */
const buildSubagentFinished = (subagentId: string) =>
  buildTaskNotification(subagentId, buildAgentCallId(subagentId));

/** Returns where the first event with this tag and this subagent is in `seen`, or -1. */
const findSubagentEvent = (
  seen: ReadonlyArray<HarnessEvent>,
  tag: HarnessEvent["_tag"],
  subagentId: string,
): number =>
  seen.findIndex(
    (event) => event._tag === tag && "subagentId" in event && event.subagentId === subagentId,
  );

/**
 * Sends the frames that start a subagent, started by `parentId` when given,
 * and open its turn, then waits for that turn to open.
 */
const openSubagentTurn = async (run: Driving, subagentId: string, parentId?: string) => {
  if (parentId !== undefined) run.say(buildChildAgentCall(parentId, subagentId));
  run.say(buildSubagentStarted(subagentId));
  run.say(buildSubagentWords(subagentId));
  await waitUntil(
    `opened the turn of ${subagentId}`,
    () => findSubagentEvent(run.seen, "turn.started", subagentId) !== -1,
  );
};

/**
 * Sends one more frame of a subagent no task_started has linked than the
 * adapter holds, so it drops them all, then waits for the warning that
 * counts them.
 */
const dropHeldFrames = async (run: Driving, subagentId: string) => {
  for (let frame = 0; frame <= 1000; frame += 1) run.say(buildSubagentWords(subagentId));
  await waitUntil("dropped the held frames", () =>
    run.seen.some(
      (event) => event._tag === "runtime.warning" && event.message.startsWith("dropped 1001"),
    ),
  );
};

/**
 * Calls the `SendMessage` hook the adapter gave the SDK, the way the CLI calls
 * it before the tool runs, and returns the hook's answer.
 */
const callSendMessageHook = async (
  run: Driving,
  to: string,
  senderId?: string,
): Promise<unknown> => {
  const matchers = run.options[0]?.hooks?.PreToolUse ?? [];
  const hook = matchers.find((matcher) => matcher.matcher === "SendMessage")?.hooks[0];
  expect(hook, "the adapter supplied no SendMessage hook").toBeDefined();
  return hook!(
    {
      hook_event_name: "PreToolUse",
      tool_name: "SendMessage",
      tool_input: { to, message: "ping" },
      tool_use_id: "toolu_send",
      ...(senderId === undefined ? {} : { agent_id: senderId }),
      session_id: "native",
      transcript_path: "",
      cwd: "",
    },
    "toolu_send",
    { signal: new AbortController().signal },
  );
};

describe("marking the start of commands and edits", () => {
  const findGate = (run: Driving) =>
    (run.options[0]?.hooks?.PreToolUse ?? []).find((matcher) =>
      matcher.matcher?.split("|").includes("Bash"),
    );

  it("gives the harness the gate for every tool that can write files, in full-access too", async () => {
    const run = createDriving();
    const editMarks: EditMarks = {
      sessionMarksDir: "/var/hercule/runner/edit-marks/sessions/one",
      recordToolStart: () => {},
      recordProcessStart: () => {},
      recordProcessEnd: () => {},
      recordRequestOnRunningItem: () => {},
    };
    await Effect.runPromise(
      run.adapter.startSession(
        SESSION,
        { ...SPEC, accessMode: "full-access" },
        { ...WORKING, editMarks },
      ),
    );

    expect(findGate(run)?.matcher?.split("|")).toEqual(
      expect.arrayContaining(["Bash", "Edit", "Write"]),
    );
    expect(findGate(run)?.matcher?.split("|")).not.toContain("Read");
  });

  it("gives the harness no gate when the session has no edit watch", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    expect(findGate(run)).toBeUndefined();
  });

  it("tells the edit watch when the shell of a Bash call starts and when it ends", async () => {
    const run = createDriving();
    const calls: Array<string> = [];
    const editMarks: EditMarks = {
      sessionMarksDir: "/var/hercule/runner/edit-marks/sessions/one",
      recordToolStart: () => {},
      recordProcessStart: (itemId) => void calls.push(`start:${itemId}`),
      recordProcessEnd: (itemId) => void calls.push(`end:${itemId}`),
      recordRequestOnRunningItem: () => {},
    };
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, { ...WORKING, editMarks }));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "start the server" }));

    run.say(buildTaskStarted("bshell", "toolu_server", "local_bash"));
    run.say(buildTaskNotification("bshell", "toolu_server"));

    await waitUntil("reported the shell's end", () => calls.length === 2);
    expect(calls).toEqual(["start:toolu_server", "end:toolu_server"]);
  });
});

describe("messaging another Claude session", () => {
  it("runs every session with Claude's messaging between sessions turned off, in full-access too", async () => {
    const run = createDriving();
    await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, accessMode: "full-access" }, THREAD),
    );

    const [options] = run.options;
    expect(options?.settings).toEqual({
      disableAgentView: true,
      disableRemoteControl: true,
      crossSessionInbound: "refuse",
    });
    expect(options?.disallowedTools).toContain("SendFile");
    // ListAgents stays: it only reads, and an agent finds its subagents with it.
    expect(options?.disallowedTools).not.toContain("ListAgents");
    // The subagent tools stay: a subagent is part of its session.
    expect(options?.disallowedTools).not.toContain("Agent");
    expect(options?.disallowedTools).not.toContain("SendMessage");
  });

  it("refuses a message to another Claude session and names the Hercule commands to use instead", async () => {
    const run = await startApprovalSession();

    const answer = await callSendMessageHook(run, "t3-194af77b-53");

    expect(answer).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(JSON.stringify(answer)).toContain("hercule session spawn");
  });

  it("lets a message to one of the session's own subagents through", async () => {
    const run = await startApprovalSession();
    await openSubagentTurn(run, "agent-b");

    expect(await callSendMessageHook(run, "agent-b")).toEqual({});
  });

  it("lets a subagent send a message to the session's own agent before its start frame is read", async () => {
    const run = await startApprovalSession();

    // No frame of agent-b has been read: the harness may call the hook before
    // the adapter reads the subagent's start frame.
    expect(await callSendMessageHook(run, "main", "agent-b")).toEqual({});
  });

  it("refuses a message to main from the session's own agent", async () => {
    const run = await startApprovalSession();

    expect(await callSendMessageHook(run, "main")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });
});

describe("a tool call that needs approval", () => {
  it("parks the call and emits a request for the tool call's item", async () => {
    const run = await startApprovalSession();

    const { park, request } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "ls -la" },
      { suggestions: SUGGESTIONS },
    );

    // Nothing has been decided yet, so the harness is still waiting.
    expect(park.settled()).toBeUndefined();
    expect(request.kind).toBe("command_approval");
    expect(request).toMatchObject({ decisions: ["allow", "allow_always", "deny", "cancel"] });
    expect(request.detail).toEqual({ command: "ls -la" });
    // The tool-use id, so a client can show the request on the item it is about.
    expect(request.itemId).toBe(TOOL_USE);
    expect(request.requestId).not.toBe("");
    expect(listResolutions(run.seen)).toEqual([]);
  });

  it("does not offer allow always when the harness suggested no rules to save", async () => {
    const run = await startApprovalSession();

    // The harness suggests no rules for a request it does not allow to be
    // saved. A button that had to invent a rule could allow more than the
    // user meant.
    const { request } = await parkAndAwaitRequest(run, "Bash", { command: "ls -la" });

    expect(request).toMatchObject({ decisions: ["allow", "deny", "cancel"] });
  });

  it("lets the call run on an allow, and emits request.resolved", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "Bash", { command: "ls -la" });

    await respond(run, request.requestId, "allow");

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "allow" });
    expect(listResolutions(run.seen)).toEqual([
      { requestId: request.requestId, decision: "allow" },
    ]);
  });

  it("saves an allow-always rule to the session, never to the user's settings files", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "ls -la" },
      {
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
            behavior: "allow",
            destination: "userSettings",
          },
        ],
      },
    );

    await respond(run, request.requestId, "allow_always");

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    expect(readPersisted(park.settled())).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });

  it("saves the harness's suggested rule on allow always", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "ls -la" },
      {
        suggestions: SUGGESTIONS,
      },
    );

    await respond(run, request.requestId, "allow_always");

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    const settled = park.settled();
    expect(settled).toMatchObject({ behavior: "allow", decisionClassification: "user_permanent" });
    // A rule is saved, so the harness does not ask about the same command again.
    expect(readPersisted(settled).length).toBeGreaterThan(0);
    expect(listResolutions(run.seen)).toEqual([
      { requestId: request.requestId, decision: "allow_always" },
    ]);
  });

  it("blocks the call on a deny, with a message and the turn left running", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "Bash", { command: "rm -rf /" });

    await respond(run, request.requestId, "deny");

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    const settled = park.settled();
    expect(settled).toMatchObject({ behavior: "deny" });
    // The SDK requires a message, and the harness passes it to the model.
    expect(readDenial(settled).message).not.toBe("");
    expect(readDenial(settled).interrupt).toBe(false);
    expect(listResolutions(run.seen)).toEqual([{ requestId: request.requestId, decision: "deny" }]);
  });

  it("blocks the call and ends the turn on a cancel", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "Bash", { command: "rm -rf /" });

    await respond(run, request.requestId, "cancel");

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny", interrupt: true });
    expect(listResolutions(run.seen)).toEqual([
      { requestId: request.requestId, decision: "cancel" },
    ]);
  });

  /**
   * The CLI withdraws a pending request after the turn is interrupted, by
   * aborting the signal it passed to the callback (spec 06 section 8.2).
   */
  it("answers a withdrawn request with a deny, and reports it as cancelled", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "Bash", { command: "ls -la" });

    park.abort();

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(listResolutions(run.seen)).toEqual([
      { requestId: request.requestId, decision: "cancel" },
    ]);
  });

  it("ignores an answer to an unknown request or to one that has already ended", async () => {
    const run = await startApprovalSession();
    const { request } = await parkAndAwaitRequest(run, "Bash", { command: "ls -la" });

    await respond(run, "r-nobody-asked", "allow");
    expect(listResolutions(run.seen)).toEqual([]);

    await respond(run, request.requestId, "deny");
    await waitUntil("resolved the park", () => listResolutions(run.seen).length === 1);
    // A second answer finds nothing to resolve, and must not report a second
    // outcome for a park that has already ended.
    await respond(run, request.requestId, "allow");
    expect(listResolutions(run.seen)).toEqual([{ requestId: request.requestId, decision: "deny" }]);
  });

  it("ignores a decision the request did not offer", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "AskUserQuestion", {
      questions: [{ question: "Which one?", header: "One", options: [], multiSelect: false }],
    });

    // An allow carries no answer to the question, so it must not reach the
    // harness, however it got this far. A question is answered with answers.
    await respond(run, request.requestId, "allow");

    expect(park.settled()).toBeUndefined();
    expect(listResolutions(run.seen)).toEqual([]);
  });

  it("parks a second request beside the first, and resolves each only by its own answer", async () => {
    const run = await startApprovalSession();
    const { park: first, request: firstRequest } = await parkAndAwaitRequest(run, "Bash", {
      command: "ls -la",
    });

    const { park: second, request: secondRequest } = await parkAndAwaitRequest(
      run,
      "Read",
      { file_path: "/work/one.ts" },
      { toolUseID: "toolu_two" },
    );

    // Both are shown at once, and neither is answered for the user.
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
    expect(first.settled()).toBeUndefined();
    expect(second.settled()).toBeUndefined();

    await respond(run, secondRequest.requestId, "deny");
    await waitUntil("resolved the second park", () => second.settled() !== undefined);
    expect(first.settled()).toBeUndefined();
  });

  it("parks the session's own agent and a subagent at once, answered in reverse order", async () => {
    const run = await startApprovalSession();
    await openSubagentTurn(run, "agent-b");
    const { park: own, request: ownRequest } = await parkAndAwaitRequest(run, "Bash", {
      command: "touch one.txt",
    });
    const { park: subagent, request: subagentRequest } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "touch two.txt" },
      { toolUseID: "toolu_two", agentID: "agent-b" },
    );

    // Only the subagent's request carries a subagent id: the clients show
    // each request on the agent that asked it.
    expect(listRequestAskers(run.seen, "request.opened")).toEqual([
      { requestId: ownRequest.requestId, subagentId: undefined },
      { requestId: subagentRequest.requestId, subagentId: "agent-b" },
    ]);
    expect(
      run.seen.some((event) => event._tag === "request.opened" && !("subagentId" in event)),
    ).toBe(true);

    await respond(run, subagentRequest.requestId, "allow");
    await waitUntil("resolved the subagent's park", () => subagent.settled() !== undefined);
    expect(subagent.settled()).toMatchObject({ behavior: "allow" });
    expect(own.settled()).toBeUndefined();

    await respond(run, ownRequest.requestId, "deny");
    await waitUntil(
      "resolved the park of the session's own agent",
      () => own.settled() !== undefined,
    );
    expect(own.settled()).toMatchObject({ behavior: "deny" });

    expect(listResolutions(run.seen)).toEqual([
      { requestId: subagentRequest.requestId, decision: "allow" },
      { requestId: ownRequest.requestId, decision: "deny" },
    ]);
    expect(listRequestAskers(run.seen, "request.resolved")).toEqual([
      { requestId: subagentRequest.requestId, subagentId: "agent-b" },
      { requestId: ownRequest.requestId, subagentId: undefined },
    ]);
  });

  it("opens no turn of the session's own agent when a subagent asks", async () => {
    const run = createDriving();
    await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, accessMode: "approval-required" }, WORKING),
    );
    await openSubagentTurn(run, "agent-b");

    await parkAndAwaitRequest(run, "Bash", { command: "ls -la" }, { agentID: "agent-b" });

    // A background subagent can ask while the session's own agent is idle,
    // and the session must stay idle.
    expect(
      run.seen.filter((event) => event._tag === "turn.started" && event.subagentId === undefined),
    ).toEqual([]);
  });

  it("ends a subagent's cancelled request with the same interrupting deny as the session's own", async () => {
    const run = await startApprovalSession();
    await openSubagentTurn(run, "agent-b");
    const { park, request } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "rm -rf /" },
      { agentID: "agent-b" },
    );

    await respond(run, request.requestId, "cancel");

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("truncates a long command to the protocol's limit, ending it with an ellipsis", async () => {
    const run = await startApprovalSession();

    const { request } = await parkAndAwaitRequest(run, "Bash", {
      command: `echo ${"x".repeat(9_000)}`,
    });

    const command = request.kind === "command_approval" ? request.detail.command : "";
    expect(command).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(command.endsWith("\u2026")).toBe(true);
  });

  it("opens a turn for the park when the harness asks before a turn is open", async () => {
    const run = createDriving();
    await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, accessMode: "approval-required" }, WORKING),
    );

    const { request } = await parkAndAwaitRequest(run, "Bash", { command: "ls -la" });

    // The SDK can call the callback before the assistant message that starts
    // the turn has been read from its stream. So the park opens its turn,
    // instead of reporting a request that no turn is waiting on.
    expect(listEventTags(run.seen)).toEqual(["session.started", "turn.started", "request.opened"]);
    expect(request.itemId).toBe(TOOL_USE);
  });

  it("creates an item id when the harness gives no tool-use id", async () => {
    const run = await startApprovalSession();

    const { request } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "ls -la" },
      { toolUseID: "" },
    );

    // The protocol rejects an empty id, so the event would be lost while the
    // park stays open.
    expect(request.itemId).not.toBe("");
  });
});

describe("the request kind for each tool", () => {
  const KINDS: ReadonlyArray<
    readonly [string, Record<string, unknown>, OpenRequest["kind"], ReadonlyArray<string>]
  > = [
    ["Bash", { command: "ls -la" }, "command_approval", []],
    [
      "Edit",
      { file_path: "/work/one.ts", old_string: "a", new_string: "b" },
      "file_change_approval",
      ["/work/one.ts"],
    ],
    [
      "MultiEdit",
      { file_path: "/work/multi.ts", edits: [{ old_string: "a", new_string: "b" }] },
      "file_change_approval",
      ["/work/multi.ts"],
    ],
    [
      "Write",
      { file_path: "/work/two.ts", content: "hello" },
      "file_change_approval",
      ["/work/two.ts"],
    ],
    [
      "NotebookEdit",
      { notebook_path: "/work/three.ipynb" },
      "file_change_approval",
      ["/work/three.ipynb"],
    ],
    ["Read", { file_path: "/work/five.ts" }, "file_read_approval", ["/work/five.ts"]],
    ["Glob", { pattern: "**/*.ts", path: "/work" }, "file_read_approval", ["/work"]],
    ["Grep", { pattern: "todo", path: "/work" }, "file_read_approval", ["/work"]],
    ["LS", { path: "/work" }, "file_read_approval", ["/work"]],
    ["WebFetch", { url: "https://example.com" }, "tool_approval", []],
  ];

  for (const [toolName, input, kind, paths] of KINDS) {
    it(`asks about ${toolName} with a ${kind}`, async () => {
      const run = await startApprovalSession();

      const { request } = await parkAndAwaitRequest(run, toolName, input);

      expect(request.kind).toBe(kind);
      if (request.kind === "tool_approval") expect(request.detail.toolName).toBe(toolName);
      if (request.kind === "file_change_approval" || request.kind === "file_read_approval") {
        expect(request.detail.paths).toEqual(paths);
      }
    });
  }

  /**
   * A question is answered with the user's answers, not with an allow, which
   * would give the tool nothing to run with. To turn it down, the user stops
   * the turn.
   */
  it("reports AskUserQuestion as a question, which takes answers and no decision", async () => {
    const run = await startApprovalSession();

    const { request } = await parkAndAwaitRequest(run, "AskUserQuestion", {
      questions: [
        {
          question: "Which database should this use?",
          header: "Database",
          options: [
            { label: "SQLite", description: "the one Hercule ships" },
            { label: "Postgres", description: "somebody else's server" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(request.kind).toBe("question");
    expect(request).not.toHaveProperty("decisions");
    // Structured, not flattened to text: the card shows the header chip, the
    // question and the description of each option.
    expect(request.kind === "question" ? request.detail.questions : []).toEqual([
      {
        question: "Which database should this use?",
        header: "Database",
        options: [
          { label: "SQLite", description: "the one Hercule ships" },
          { label: "Postgres", description: "somebody else's server" },
        ],
        multiSelect: false,
      },
    ]);
  });

  it("includes every question, but drops a malformed question and options without a label", async () => {
    const run = await startApprovalSession();

    const { request } = await parkAndAwaitRequest(run, "AskUserQuestion", {
      questions: [
        // No header: the SDK's own schema requires one, and a header chip
        // cannot be invented, so this question is dropped.
        { question: "Which one?", options: [], multiSelect: false },
        {
          question: "Which features?",
          header: "Features",
          options: [
            { label: "Rules", description: "persisted rules", preview: "dropped" },
            { label: "", description: "no label to show" },
            "not an option",
          ],
          multiSelect: true,
        },
      ],
    });

    expect(request.kind === "question" ? request.detail.questions : []).toEqual([
      {
        question: "Which features?",
        header: "Features",
        // The protocol has no field for the SDK's `preview`, so it is dropped.
        options: [{ label: "Rules", description: "persisted rules" }],
        multiSelect: true,
      },
    ]);
  });

  /**
   * A `question` request with no questions is a frame nobody can decode, which
   * costs the runner its connection. A tool approval the user can deny is the
   * correct fallback.
   */
  it("falls back to a tool approval when no valid question is left", async () => {
    const run = await startApprovalSession();

    const { request } = await parkAndAwaitRequest(run, "AskUserQuestion", {
      questions: "nonsense",
    });

    expect(request.kind).toBe("tool_approval");
    expect(request.kind === "tool_approval" ? request.detail.toolName : "").toBe("AskUserQuestion");
    expect(request).toMatchObject({ decisions: ["deny", "cancel"] });
  });

  /**
   * The plan is its own item, opened by the harness's tool call, and the
   * request points at that item. So the client shows the request on the plan
   * the user is asked to approve, not on a second copy of it.
   */
  it("asks about the plan item the tool call already opened", async () => {
    const run = await startApprovalSession();
    const plan = { plan: "1. read it\n2. write it" };
    run.say({
      type: "assistant",
      message: {
        id: "msg-plan",
        content: [{ type: "tool_use", id: TOOL_USE, name: "ExitPlanMode", input: plan }],
      },
    });
    await waitUntil("published the plan", () => filterItems(run.seen, "plan").length > 0);

    const { request } = await parkAndAwaitRequest(run, "ExitPlanMode", plan);

    // Exactly one: a second plan item would never be closed, because only the
    // harness's `tool_result` closes a plan item, and it closes only its own.
    expect(filterItems(run.seen, "plan")).toHaveLength(1);
    const started = filterItems(run.seen, "plan")[0]!;
    expect(JSON.stringify(started.detail)).toContain("read it");
    expect(request.kind).toBe("tool_approval");
    expect(request.itemId).toBe(started.itemId);
  });
});

/**
 * Tests for answering a question. The harness asks through `canUseTool` with
 * the `AskUserQuestion` tool, and the user's answers come back keyed by each
 * question's header. The SDK wants them keyed by each question's full text,
 * with the labels of a multi-select answer joined by ", ".
 */
const STORAGE_QUESTION = {
  question: "Which storage should drafts use?",
  header: "Storage",
  options: [
    { label: "localStorage", description: "simple, synchronous" },
    { label: "IndexedDB", description: "larger, asynchronous" },
  ],
  multiSelect: false,
};

const FEATURES_QUESTION = {
  question: "Which features should ship first?",
  header: "Features",
  options: [
    { label: "Sync", description: "across devices" },
    { label: "Search", description: "full text" },
    { label: "Export", description: "to Markdown" },
  ],
  multiSelect: true,
};

/** Sends the user's answers to a request to the adapter. */
const respondWithAnswers = (
  run: Driving,
  requestId: string,
  answers: QuestionAnswers,
): Promise<void> =>
  Effect.runPromise(
    run.adapter.respondToQuestion(SESSION, requestId, answers, SPEC.modelSelection),
  );

/** Sends answers the adapter must refuse, and returns its failure. Rejects when the adapter accepts them. */
const refuseAnswers = (
  run: Driving,
  requestId: string,
  answers: QuestionAnswers,
): Promise<AnswerNotDelivered> =>
  Effect.runPromise(
    Effect.flip(run.adapter.respondToQuestion(SESSION, requestId, answers, SPEC.modelSelection)),
  );

/** Returns the input an allow handed back to the harness, or `undefined` for any other result. */
const readUpdatedInput = (settled: PermissionResult | null | undefined): unknown =>
  settled !== null && settled !== undefined && settled.behavior === "allow"
    ? settled.updatedInput
    : undefined;

/** Returns the questions of a `question` request, or an empty list for any other kind. */
const readQuestions = (request: OpenRequest): ReadonlyArray<unknown> =>
  request.kind === "question" ? request.detail.questions : [];

describe("answering a question the harness asks", () => {
  it("allows the call with the answers keyed by question text, joining a list with commas", async () => {
    const run = await startApprovalSession();
    const input = { questions: [STORAGE_QUESTION, FEATURES_QUESTION] };
    const { park, request } = await parkAndAwaitRequest(run, "AskUserQuestion", input);
    const answers: QuestionAnswers = { Storage: "localStorage", Features: ["Sync", "Search"] };

    await respondWithAnswers(run, request.requestId, answers);

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "allow" });
    expect(readUpdatedInput(park.settled())).toEqual({
      ...input,
      answers: {
        "Which storage should drafts use?": "localStorage",
        "Which features should ship first?": "Sync, Search",
      },
    });
    // The stream records what the user said, not an allow standing in for it.
    expect(listResolutions(run.seen)).toEqual([{ requestId: request.requestId, answers }]);
  });

  it("keys the answer by the full question text, even when the request showed it truncated", async () => {
    const run = await startApprovalSession();
    const long = `Which storage should drafts use? ${"x".repeat(MAX_MESSAGE_LENGTH + 100)}`;
    const input = { questions: [{ ...STORAGE_QUESTION, question: long }] };
    const { park, request } = await parkAndAwaitRequest(run, "AskUserQuestion", input);
    const shown = readQuestions(request)[0] as { readonly question: string };
    expect(shown.question).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(shown.question.endsWith("…")).toBe(true);

    await respondWithAnswers(run, request.requestId, { Storage: "IndexedDB" });

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    // The SDK matches an answer to its question by the exact text, so a
    // truncated key would answer nothing.
    expect(readUpdatedInput(park.settled())).toEqual({
      ...input,
      answers: { [long]: "IndexedDB" },
    });
  });

  it("fails to deliver answers to an approval request, and leaves the approval parked", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "Bash", { command: "ls -la" });

    const failure = await refuseAnswers(run, request.requestId, { Storage: "localStorage" });

    expect(failure).toBeInstanceOf(AnswerNotDelivered);
    expect(park.settled()).toBeUndefined();
    expect(listResolutions(run.seen)).toEqual([]);
  });

  it("fails to deliver answers to a request id that is not the open one", async () => {
    const run = await startApprovalSession();
    const { park } = await parkAndAwaitRequest(run, "AskUserQuestion", {
      questions: [STORAGE_QUESTION],
    });

    const failure = await refuseAnswers(run, "r-nobody-asked", { Storage: "localStorage" });

    expect(failure).toBeInstanceOf(AnswerNotDelivered);
    expect(park.settled()).toBeUndefined();
    expect(listResolutions(run.seen)).toEqual([]);
  });

  it("fails to deliver a second answer to a question that was already answered", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "AskUserQuestion", {
      questions: [STORAGE_QUESTION],
    });
    await respondWithAnswers(run, request.requestId, { Storage: "localStorage" });
    await waitUntil("resolved the park", () => park.settled() !== undefined);

    const failure = await refuseAnswers(run, request.requestId, { Storage: "IndexedDB" });

    expect(failure).toBeInstanceOf(AnswerNotDelivered);
    expect(failure.message).toContain("no longer open");
  });

  for (const decision of ["deny", "cancel"] as const) {
    it(`ignores a ${decision}, because a question is turned down by stopping the turn`, async () => {
      const run = await startApprovalSession();
      const { park, request } = await parkAndAwaitRequest(run, "AskUserQuestion", {
        questions: [STORAGE_QUESTION],
      });

      await respond(run, request.requestId, decision);

      expect(park.settled()).toBeUndefined();
      expect(listResolutions(run.seen)).toEqual([]);
    });
  }

  it("blocks the call and ends the turn on an interrupt, and reports it as cancelled", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "AskUserQuestion", {
      questions: [STORAGE_QUESTION],
    });

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(run.interrupted()).toBe(1);
    expect(listResolutions(run.seen)).toEqual([
      { requestId: request.requestId, decision: "cancel" },
    ]);
  });

  it("drops an option whose label repeats an earlier option's label", async () => {
    const run = await startApprovalSession();

    const { request } = await parkAndAwaitRequest(run, "AskUserQuestion", {
      questions: [
        {
          ...STORAGE_QUESTION,
          options: [
            ...STORAGE_QUESTION.options,
            { label: STORAGE_QUESTION.options[0]!.label, description: "the same label again" },
          ],
        },
      ],
    });

    expect(readQuestions(request)).toEqual([STORAGE_QUESTION]);
  });

  /**
   * Answers come back keyed by header, so two questions with one header could
   * not both be answered. Claude checks only that question texts are unique,
   * so the adapter numbers the later header and maps its answer back to its
   * own question text.
   */
  it("numbers a header that repeats an earlier question's, and answers each question", async () => {
    const run = await startApprovalSession();
    const input = { questions: [STORAGE_QUESTION, { ...FEATURES_QUESTION, header: "Storage" }] };
    const { park, request } = await parkAndAwaitRequest(run, "AskUserQuestion", input);
    expect(readQuestions(request)).toEqual([
      STORAGE_QUESTION,
      { ...FEATURES_QUESTION, header: "Storage (2)" },
    ]);

    await respondWithAnswers(run, request.requestId, {
      Storage: "IndexedDB",
      "Storage (2)": ["Export"],
    });

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    expect(readUpdatedInput(park.settled())).toEqual({
      ...input,
      answers: {
        "Which storage should drafts use?": "IndexedDB",
        "Which features should ship first?": "Export",
      },
    });
  });
});

/**
 * In `full-access` the harness still calls `canUseTool` for a question, and
 * for a tool call that always needs the user's approval (for example one an
 * `ask` rule of the settings covers). The question is asked like in any mode;
 * the tool call must not become an approval.
 */
describe("the harness asking in full-access", () => {
  it("refuses a tool call at once, without opening a request", async () => {
    const run = await startSessionWithTurn("full-access");

    const park = parkToolCall(run, "Bash", { command: "echo hi" });

    await waitUntil("refused the call", () => park.settled() !== undefined);
    const denial = readDenial(park.settled());
    expect(denial.message).toContain("full access");
    expect(denial.interrupt).toBe(false);
    expect(listOpenedRequests(run.seen)).toEqual([]);
  });

  it("opens a question request for a question and passes the answer on", async () => {
    const run = await startSessionWithTurn("full-access");
    const input = { questions: [STORAGE_QUESTION] };

    const { park, request } = await parkAndAwaitRequest(run, "AskUserQuestion", input);
    expect(request.kind).toBe("question");
    await respondWithAnswers(run, request.requestId, { Storage: "IndexedDB" });

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    expect(readUpdatedInput(park.settled())).toEqual({
      ...input,
      answers: { "Which storage should drafts use?": "IndexedDB" },
    });
  });
});

describe("a park that is still open when the turn or the session ends", () => {
  it("is cancelled on an interrupt, and the cancellation is reported before the turn completes", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "Bash", { command: "ls -la" });

    await Effect.runPromise(run.adapter.interrupt(SESSION));
    // The CLI responds to an interrupt by ending the turn as aborted.
    run.say({ ...RESULT, terminal_reason: "aborted_by_user" });
    await waitUntil("closed the turn", () =>
      run.seen.some((event) => event._tag === "turn.completed"),
    );

    expect(run.interrupted()).toBe(1);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(listResolutions(run.seen)).toEqual([
      { requestId: request.requestId, decision: "cancel" },
    ]);
    // In this order: if the turn completed while the request was still open,
    // the card would stay on screen for a turn that has ended.
    const closing = listEventTags(run.seen).filter(
      (tag) => tag === "request.resolved" || tag === "turn.completed",
    );
    expect(closing).toEqual(["request.resolved", "turn.completed"]);
    const completed = run.seen.find((event) => event._tag === "turn.completed");
    expect(completed?._tag === "turn.completed" ? completed.state : undefined).toBe("interrupted");
  });

  it("withdraws every open park on an interrupt, the subagents' too", async () => {
    const run = await startApprovalSession();
    await openSubagentTurn(run, "agent-b");
    const { park: own, request: ownRequest } = await parkAndAwaitRequest(run, "Bash", {
      command: "ls -la",
    });
    const { park: subagent, request: subagentRequest } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "ls -la" },
      { toolUseID: "toolu_two", agentID: "agent-b" },
    );

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    await waitUntil(
      "resolved both parks",
      () => own.settled() !== undefined && subagent.settled() !== undefined,
    );
    expect(own.settled()).toMatchObject({ behavior: "deny" });
    expect(subagent.settled()).toMatchObject({ behavior: "deny" });
    expect(listResolutions(run.seen)).toEqual([
      { requestId: ownRequest.requestId, decision: "cancel" },
      { requestId: subagentRequest.requestId, decision: "cancel" },
    ]);
    expect(run.interrupted()).toBe(1);
  });

  it("emits no request events on an interrupt when there is no park", async () => {
    const run = await startApprovalSession();

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    expect(run.interrupted()).toBe(1);
    expect(listResolutions(run.seen)).toEqual([]);
    expect(listOpenedRequests(run.seen)).toEqual([]);
  });

  it("is withdrawn when the session is stopped, and the exit still reports the stop reason", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "Bash", { command: "ls -la" });

    await Effect.runPromise(run.adapter.stopSession(SESSION, "inactivity_timeout"));
    await awaitSessionEnd(run.seen);

    // A park left open is a promise the harness would wait on for ever.
    await waitUntil("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    // A stop ends the turn, so the events are the same as for an interrupt.
    expect(listResolutions(run.seen)).toEqual([
      { requestId: request.requestId, decision: "cancel" },
    ]);
    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe(
      "inactivity_timeout",
    );
  });

  it("is withdrawn once, before the exit, when the harness's stream ends on its own", async () => {
    const run = await startApprovalSession();
    const { park, request } = await parkAndAwaitRequest(run, "Bash", { command: "ls -la" });

    // Nobody stopped the session: the harness's stream simply ended while the
    // request was still open.
    run.end();
    await awaitSessionEnd(run.seen);

    await waitUntil("resolved the park", () => park.settled() !== undefined);
    // The harness gets a plain deny, because there is no turn left to
    // interrupt, and the request is reported as cancelled, not denied.
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(readDenial(park.settled()).interrupt).toBe(false);
    expect(listResolutions(run.seen)).toEqual([
      { requestId: request.requestId, decision: "cancel" },
    ]);
    // Every exit passes through one place, so the park is ended once, before
    // the exit. A request still open on a session that is gone would leave a
    // card nobody can answer.
    const closing = listEventTags(run.seen).filter(
      (tag) => tag === "request.resolved" || tag === "session.exited",
    );
    expect(closing).toEqual(["request.resolved", "session.exited"]);
  });
});

/**
 * The fields an Agent adds to a session spec: its own instructions, disallowed
 * tool families, and a schema every turn's output must match. Spec 06 section 7
 * owns structured output.
 */
const OUTPUT_SCHEMA: OutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["accept", "dismiss"] },
    confidence: { type: "number" },
  },
};

const SYSTEM_PROMPT = "You assess tasks and answer with a verdict.";

const STRUCTURED: SessionSpec = {
  ...SPEC,
  systemPrompt: SYSTEM_PROMPT,
  disallowedTools: ["edit", "shell", "web-fetch"],
  outputSchema: OUTPUT_SCHEMA,
};

const ANSWER = { verdict: "accept", confidence: 0.9 };

/** Runs one turn that `result` closes, and returns its `turn.completed` event. */
const runTurnToCompletion = async (
  spec: SessionSpec,
  result: unknown,
): Promise<Extract<HarnessEvent, { _tag: "turn.completed" }>> => {
  const run = createDriving();
  await Effect.runPromise(run.adapter.startSession(SESSION, spec, WORKING));
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
  run.say(result);
  await waitUntil("closed the turn", () =>
    run.seen.some((event) => event._tag === "turn.completed"),
  );
  const completed = run.seen.find(
    (event): event is Extract<HarnessEvent, { _tag: "turn.completed" }> =>
      event._tag === "turn.completed",
  );
  expect(completed, "no turn was completed").toBeDefined();
  return completed!;
};

describe("a subagent's requests", () => {
  it("reports a request a subagent asks before its turn opens only once the turn has opened", async () => {
    const run = await startApprovalSession();
    const park = parkToolCall(run, "Bash", { command: "ls" }, { agentID: "agent-b" });

    await openSubagentTurn(run, "agent-b");
    await waitUntil("opened the request", () => listOpenedRequests(run.seen).length === 1);

    // A request belongs to an open turn, so it never comes before the turn.
    expect(findSubagentEvent(run.seen, "turn.started", "agent-b")).toBeLessThan(
      findSubagentEvent(run.seen, "request.opened", "agent-b"),
    );
    expect(park.settled()).toBeUndefined();
  });

  it("denies a request withdrawn before its turn opened, and never reports it", async () => {
    const run = await startApprovalSession();
    const park = parkToolCall(run, "Bash", { command: "ls" }, { agentID: "agent-b" });

    park.abort();
    await waitUntil("answered the harness", () => park.settled() !== undefined);
    await openSubagentTurn(run, "agent-b");
    // The text item comes after the deferred events would have been released.
    await waitUntil("reported the subagent's text", () =>
      run.seen.some(
        (event) =>
          event._tag === "item.completed" &&
          event.kind === "assistant_message" &&
          event.subagentId === "agent-b",
      ),
    );

    expect(park.settled()).toMatchObject({ behavior: "deny" });
    // The user never saw it open, so it is not reported closed either.
    expect(listOpenedRequests(run.seen)).toEqual([]);
    expect(listResolutions(run.seen)).toEqual([]);
  });

  it("cancels a subagent's requests before reporting its turn completed, and keeps the others", async () => {
    const run = await startApprovalSession();
    await openSubagentTurn(run, "agent-b");
    const { park: own } = await parkAndAwaitRequest(run, "Bash", { command: "ls" });
    const { park, request } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "ls" },
      { toolUseID: "toolu_two", agentID: "agent-b" },
    );

    run.say(buildSubagentFinished("agent-b"));
    await waitUntil(
      "completed the subagent's turn",
      () => findSubagentEvent(run.seen, "turn.completed", "agent-b") !== -1,
    );

    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(listResolutions(run.seen)).toEqual([
      { requestId: request.requestId, decision: "cancel" },
    ]);
    // In this order, or a card would stay on screen for a turn that is over.
    expect(findSubagentEvent(run.seen, "request.resolved", "agent-b")).toBeLessThan(
      findSubagentEvent(run.seen, "turn.completed", "agent-b"),
    );
    expect(own.settled()).toBeUndefined();
  });

  // The harness can send a subagent's frames before the task_started that
  // links them. Another subagent's task_started in between must not drop
  // them, or the subagent's turn never opens and its request waits for ever.
  it("reports a request of a subagent whose frames waited past another subagent's task_started", async () => {
    const run = await startApprovalSession();
    run.say(buildSubagentWords("agent-b"));
    await openSubagentTurn(run, "agent-a");
    const park = parkToolCall(run, "Bash", { command: "ls" }, { agentID: "agent-b" });

    run.say(buildSubagentStarted("agent-b"));

    await waitUntil("opened the request", () => listOpenedRequests(run.seen).length === 1);
    expect(listRequestAskers(run.seen, "request.opened")).toEqual([
      { requestId: listOpenedRequests(run.seen)[0]!.requestId, subagentId: "agent-b" },
    ]);
    expect(findSubagentEvent(run.seen, "turn.started", "agent-b")).toBeLessThan(
      findSubagentEvent(run.seen, "request.opened", "agent-b"),
    );
    expect(run.seen.some((event) => event._tag === "runtime.warning")).toBe(false);
    expect(park.settled()).toBeUndefined();
  });

  it("denies a request whose subagent was still unknown when the held frames were dropped, and never reports it", async () => {
    const run = await startApprovalSession();
    const park = parkToolCall(run, "Bash", { command: "ls" }, { agentID: "agent-z" });

    await dropHeldFrames(run, "agent-z");

    await waitUntil("answered the harness", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(listOpenedRequests(run.seen)).toEqual([]);
    expect(listResolutions(run.seen)).toEqual([]);
  });

  // The frames that would have opened the subagent's turn were dropped, so
  // its request would wait for ever for a turn to be shown in. Denied, the
  // subagent goes on, and its next frame opens its turn.
  it("denies at once a request from a subagent whose frames were dropped, with no Request", async () => {
    const run = await startApprovalSession();
    await dropHeldFrames(run, "agent-b");
    run.say(buildSubagentStarted("agent-b"));
    await waitUntil(
      "introduced agent-b",
      () => findSubagentEvent(run.seen, "subagent.started", "agent-b") !== -1,
    );

    const park = parkToolCall(run, "Bash", { command: "ls" }, { agentID: "agent-b" });

    await waitUntil("answered the harness", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(listOpenedRequests(run.seen)).toEqual([]);
    expect(listResolutions(run.seen)).toEqual([]);
  });

  it("withdraws a waiting request once a task_started links its subagent to dropped frames", async () => {
    const run = await startApprovalSession();
    await dropHeldFrames(run, "agent-b");
    const park = parkToolCall(run, "Bash", { command: "ls" }, { agentID: "agent-b" });

    run.say(buildSubagentStarted("agent-b"));

    await waitUntil("answered the harness", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(listOpenedRequests(run.seen)).toEqual([]);
    expect(listResolutions(run.seen)).toEqual([]);
  });

  it("reports a subagent's requests again once its turn opens after its frames were dropped", async () => {
    const run = await startApprovalSession();
    await dropHeldFrames(run, "agent-b");
    run.say(buildSubagentStarted("agent-b"));
    run.say(buildSubagentWords("agent-b"));
    await waitUntil(
      "opened agent-b's turn",
      () => findSubagentEvent(run.seen, "turn.started", "agent-b") !== -1,
    );

    const { park, request } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "ls" },
      { agentID: "agent-b" },
    );

    expect(listRequestAskers(run.seen, "request.opened")).toEqual([
      { requestId: request.requestId, subagentId: "agent-b" },
    ]);
    expect(park.settled()).toBeUndefined();
  });
});

describe("stopping a subagent", () => {
  it("stops it and every working subagent below it, and leaves the rest running", async () => {
    const run = await startApprovalSession();
    await openSubagentTurn(run, "agent-a");
    await openSubagentTurn(run, "agent-b", "agent-a");
    await openSubagentTurn(run, "agent-c", "agent-b");
    await openSubagentTurn(run, "agent-x");
    // A child whose turn is about to open, from a task_started alone.
    run.say(buildChildAgentCall("agent-a", "agent-d"));
    run.say(buildSubagentStarted("agent-d"));
    await waitUntil(
      "introduced agent-d",
      () => findSubagentEvent(run.seen, "subagent.started", "agent-d") !== -1,
    );
    const { park: below, request } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "ls" },
      { toolUseID: "toolu_c", agentID: "agent-c" },
    );
    const { park: beside } = await parkAndAwaitRequest(
      run,
      "Bash",
      { command: "ls" },
      { toolUseID: "toolu_x", agentID: "agent-x" },
    );

    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));

    expect([...run.stoppedTasks].sort()).toEqual(["agent-a", "agent-b", "agent-c", "agent-d"]);
    expect(run.interrupted()).toBe(0);
    await waitUntil("withdrew the park below", () => below.settled() !== undefined);
    expect(listResolutions(run.seen)).toEqual([
      { requestId: request.requestId, decision: "cancel" },
    ]);
    expect(beside.settled()).toBeUndefined();
  });

  it("stops an idle subagent below once it works again, and a subagent it starts later", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await openSubagentTurn(run, "agent-a");
    await openSubagentTurn(run, "agent-b", "agent-a");
    run.say(buildSubagentFinished("agent-b"));
    await waitUntil(
      "completed agent-b's turn",
      () => findSubagentEvent(run.seen, "turn.completed", "agent-b") !== -1,
    );

    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));
    expect(run.stoppedTasks).toEqual(["agent-a"]);

    // agent-b wakes by itself and starts a child after the stop.
    run.say(buildChildAgentCall("agent-b", "agent-e"));
    run.say(buildSubagentStarted("agent-e"));
    await waitUntil("stopped the late child", () => run.stoppedTasks.includes("agent-e"));
    expect(run.stoppedTasks).toEqual(["agent-a", "agent-b", "agent-e"]);
  });

  it("stops a late child of a subagent the stop reached while it worked", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await openSubagentTurn(run, "agent-a");

    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));
    // The harness had already sent the call before it read the stop.
    run.say(buildChildAgentCall("agent-a", "agent-b"));
    run.say(buildSubagentStarted("agent-b"));

    await waitUntil("stopped the late child", () => run.stoppedTasks.includes("agent-b"));
    expect(run.stoppedTasks).toEqual(["agent-a", "agent-b"]);
  });

  it("withdraws a late child's request that waits for its turn, and never reports it", async () => {
    const run = await startApprovalSession();
    await openSubagentTurn(run, "agent-a");
    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));
    // The child asks before the pump has read the frames that start it.
    const park = parkToolCall(run, "Bash", { command: "ls" }, { agentID: "agent-b" });
    run.say(buildChildAgentCall("agent-a", "agent-b"));
    run.say(buildSubagentStarted("agent-b"));
    run.say(buildSubagentWords("agent-b"));

    await waitUntil("stopped the late child", () => run.stoppedTasks.includes("agent-b"));
    await waitUntil("answered the harness", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    await waitUntil(
      "opened agent-b's turn",
      () => findSubagentEvent(run.seen, "turn.started", "agent-b") !== -1,
    );
    expect(listOpenedRequests(run.seen)).toEqual([]);
    expect(listResolutions(run.seen)).toEqual([]);
  });

  it("stops a subagent again when it finished before its stop landed and then works again", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await openSubagentTurn(run, "agent-a");

    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));
    // The harness reports the task completed, not stopped: it finished on its
    // own before stopTask reached it, so stopTask stopped nothing.
    run.say(buildSubagentFinished("agent-a"));
    run.say(buildSubagentWords("agent-a"));

    await waitUntil("stopped agent-a again", () => run.stoppedTasks.length === 2);
    expect(run.stoppedTasks).toEqual(["agent-a", "agent-a"]);
  });

  it("denies at once a request from a subagent the harness reported stopped", async () => {
    const run = await startApprovalSession();
    await openSubagentTurn(run, "agent-b");
    run.say(buildTaskNotification("agent-b", buildAgentCallId("agent-b"), "stopped"));
    await waitUntil(
      "completed agent-b's turn",
      () => findSubagentEvent(run.seen, "turn.completed", "agent-b") !== -1,
    );

    const park = parkToolCall(run, "Bash", { command: "ls" }, { agentID: "agent-b" });

    await waitUntil("answered the harness", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(listOpenedRequests(run.seen)).toEqual([]);
    expect(listResolutions(run.seen)).toEqual([]);
  });

  it("does nothing more for a stop the harness refuses after the session stopped", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await openSubagentTurn(run, "agent-a");
    run.refusesStopTask = true;

    const stopping = Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    await stopping;

    expect(run.stoppedTasks).toEqual(["agent-a"]);
    expect(run.seen.some((event) => event._tag === "runtime.warning")).toBe(false);
  });

  it("reports a stop the harness refused as a warning on the subagent, and still succeeds", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await openSubagentTurn(run, "agent-a");
    run.refusesStopTask = true;

    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));

    await waitUntil(
      "warned about the stop",
      () => findSubagentEvent(run.seen, "runtime.warning", "agent-a") !== -1,
    );
    const warning = run.seen[findSubagentEvent(run.seen, "runtime.warning", "agent-a")];
    expect(warning?._tag === "runtime.warning" ? warning.message : "").toContain("no task agent-a");
  });

  it("sends stopTask again on a second interrupt after the harness refused the first", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await openSubagentTurn(run, "agent-a");
    run.refusesStopTask = true;
    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));
    run.refusesStopTask = false;

    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));

    expect(run.stoppedTasks).toEqual(["agent-a", "agent-a"]);
  });

  // Only the user's own Stop sends a refused stop again. Resending it at each
  // message would ask the harness, and fail, for as long as the subagent runs.
  it("does not send again a stop the harness refused when the subagent woke", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await openSubagentTurn(run, "agent-a");
    await openSubagentTurn(run, "agent-b", "agent-a");
    run.say(buildSubagentFinished("agent-b"));
    await waitUntil(
      "completed agent-b's turn",
      () => findSubagentEvent(run.seen, "turn.completed", "agent-b") !== -1,
    );
    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));
    run.refusesStopTask = true;

    run.say(buildSubagentWords("agent-b"));
    await waitUntil(
      "warned about agent-b's stop",
      () => findSubagentEvent(run.seen, "runtime.warning", "agent-b") !== -1,
    );
    run.say(buildSubagentText(buildAgentCallId("agent-b"), "msg-more-agent-b", "still here"));
    await waitUntil("reported agent-b's next words", () =>
      run.seen.some((event) => event._tag === "content.delta" && event.delta === "still here"),
    );

    expect(run.stoppedTasks).toEqual(["agent-a", "agent-b"]);
  });

  it("stops a resumed subagent's resumed children, from the tree the controller sent", async () => {
    const run = createDriving();
    const carried = {
      nativeSessionId: "0199e0e7-0000-7000-8000-0000000000ab",
      mode: "resume",
      subagents: [
        { subagentId: "agent-a", itemId: buildAgentCallId("agent-a") },
        {
          subagentId: "agent-b",
          itemId: buildAgentCallId("agent-b"),
          parentSubagentId: "agent-a",
        },
      ],
    } as const;
    await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, continue: carried }, WORKING),
    );
    // Only the child works in this process. Its frames carry its agent call,
    // which the seeded tree links to it, so no task_started is needed.
    run.say(buildSubagentWords("agent-b"));
    await waitUntil(
      "opened agent-b's turn",
      () => findSubagentEvent(run.seen, "turn.started", "agent-b") !== -1,
    );

    await Effect.runPromise(run.adapter.interrupt(SESSION, "agent-a"));

    expect(run.stoppedTasks).toEqual(["agent-b"]);
  });
});

describe("a session the controller started for an Agent", () => {
  it("appends the agent's instructions to the harness's preset, never replacing it", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, WORKING));

    expect(run.options[0]?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: SYSTEM_PROMPT,
    });
  });

  it("appends the coordination paragraph, then an assistant's memory as the last part", async () => {
    const run = createDriving();
    const coordination = "Other agent sessions may work on the same repositories as you.";
    const memory = "## Memory (core)\nThe user is Rogier.\n\n## Memory topics\n- projects";
    await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...STRUCTURED, coordination, memory }, WORKING),
    );

    expect(run.options[0]?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: `${SYSTEM_PROMPT}\n\n${coordination}\n\n${memory}`,
    });
  });

  it("appends the orientation first, before the agent's instructions and memory", async () => {
    const run = createDriving();
    const orientation = "This session runs inside Hercule.";
    const memory = "## Memory (core)\nThe user is Rogier.";
    const oriented = { ...WORKING, herculeTool: { ...HERCULE_TOOL, orientation } };
    await Effect.runPromise(run.adapter.startSession(SESSION, { ...STRUCTURED, memory }, oriented));

    expect(run.options[0]?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: `${orientation}\n\n${SYSTEM_PROMPT}\n\n${memory}`,
    });
  });

  it("turns off only the CLI's automatic compaction when the spec asks for it", async () => {
    const run = createDriving();
    await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...STRUCTURED, autoCompaction: false }, WORKING),
    );

    const env = run.options[0]?.env ?? {};
    expect(env["DISABLE_AUTO_COMPACT"]).toBe("1");
    // `DISABLE_COMPACT` would also turn off `/compact`, which the user can send.
    expect(Object.keys(env)).not.toContain("DISABLE_COMPACT");
  });

  it("leaves the CLI's automatic compaction on when the spec does not turn it off", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, WORKING));

    const keys = Object.keys(run.options[0]?.env ?? {});
    expect(keys).not.toContain("DISABLE_AUTO_COMPACT");
    expect(keys).not.toContain("DISABLE_COMPACT");
  });

  it("disallows every Claude tool in each disallowed tool family", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, WORKING));

    expect(run.options[0]?.disallowedTools).toEqual([
      "Edit",
      "NotebookEdit",
      "Bash",
      "WebFetch",
      "SendFile",
    ]);
  });

  it("passes the schema to the SDK as the session's output format", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, WORKING));

    expect(run.options[0]?.outputFormat).toEqual({
      type: "json_schema",
      schema: OUTPUT_SCHEMA,
    });
  });

  it("sets neither instructions nor an output format for a Thread, whose spec has neither", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    // Both keys are absent, not empty: a preset with nothing appended would
    // add a setting the spec never asked for.
    expect(run.options[0], "the session was never started").toBeDefined();
    const keys = Object.keys(run.options[0]!);
    expect(keys).not.toContain("systemPrompt");
    expect(keys).not.toContain("outputFormat");
    // Only the tool every session goes without, and no tool family.
    expect(run.options[0]?.disallowedTools).toEqual(["SendFile"]);
  });
});

describe("the structured result of a turn with an output schema", () => {
  it("reports the harness's structured output as the result when it matches the schema", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, {
      ...RESULT,
      structured_output: ANSWER,
    });

    expect(completed.state).toBe("completed");
    expect(completed.structuredResult).toEqual({ outcome: "ok", value: ANSWER });
  });

  it("reports a schema failure that names the field when the output does not match the schema", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, {
      ...RESULT,
      structured_output: { verdict: "maybe", confidence: 0.9 },
    });

    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("verdict") as string,
    });
  });

  it("reports a schema failure that names the subtype when the harness ran out of retries", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, {
      ...RESULT,
      subtype: "error_max_structured_output_retries",
      is_error: true,
      errors: [],
    });

    // The turn keeps the state the harness reported. The structured result is
    // reported separately, and is only about the schema.
    expect(completed.state).toBe("failed");
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("error_max_structured_output_retries") as string,
    });
  });

  it("reports a schema failure when a successful turn has no structured output", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, RESULT);

    expect(completed.state).toBe("completed");
    // The adapter chooses the wording, so the test only checks that there is a
    // reason. A turn with no output must be reported as a failure, not as an
    // empty `ok`.
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringMatching(/\S/) as string,
    });
  });

  it("reports no structured result when the turn failed for another reason", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, {
      ...RESULT,
      is_error: true,
      errors: ["the API refused the request"],
    });

    // The failure is about the turn, not about the schema. A `schema-failure`
    // here would claim that an output was checked and rejected.
    expect(completed.state).toBe("failed");
    expect("structuredResult" in completed).toBe(false);
  });

  it("reports no structured result for a turn the user interrupted", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, {
      ...RESULT,
      terminal_reason: "aborted_tools",
    });

    expect(completed.state).toBe("interrupted");
    expect("structuredResult" in completed).toBe(false);
  });

  it("reports no structured result for an interrupted turn, even when the retries ran out", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, {
      ...RESULT,
      subtype: "error_max_structured_output_retries",
      is_error: true,
      errors: [],
      terminal_reason: "aborted_tools",
    });

    expect(completed.state).toBe("interrupted");
    expect("structuredResult" in completed).toBe(false);
  });

  it("reports no structured result for a session without a schema", async () => {
    const completed = await runTurnToCompletion(SPEC, { ...RESULT, structured_output: ANSWER });

    // The key is absent, not an `ok` with no schema. A Thread replies in free
    // text, and adding the key to every turn of every session would give "ok"
    // a second meaning.
    expect("structuredResult" in completed).toBe(false);
  });
});

/**
 * Messages of a real foreground shell command the user stopped halfway, in the
 * order the CLI sent them. Captured from a live CLI (2.1.283) through
 * `query().interrupt()`, with ids shortened. The CLI announces the command as a
 * task, then after the interrupt reports the task as stopped, rejects the tool
 * call, and ends the turn with `aborted_tools`.
 */
const STOPPED_COMMAND = "toolu_018PeXXcwHTRzcjmrhPb1L3s";
const STOPPED_TURN: ReadonlyArray<unknown> = [
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: STOPPED_COMMAND,
          name: "Bash",
          input: {
            command: "for i in $(seq 1 30); do echo $i; sleep 1; done",
            description: "Count from 1 to 30, one per second",
          },
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: SESSION,
  },
  {
    type: "system",
    subtype: "task_started",
    task_id: "b0hua8a7p",
    tool_use_id: STOPPED_COMMAND,
    description: "Count from 1 to 30, one per second",
    is_backgrounded: false,
    task_type: "local_bash",
    uuid: "0199e0e7-0000-7000-8000-000000000101",
    session_id: SESSION,
  },
  {
    type: "system",
    subtype: "task_notification",
    task_id: "b0hua8a7p",
    tool_use_id: STOPPED_COMMAND,
    status: "stopped",
    output_file: "",
    summary: "Count from 1 to 30, one per second",
    uuid: "0199e0e7-0000-7000-8000-000000000102",
    session_id: SESSION,
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: STOPPED_COMMAND,
          is_error: true,
          content:
            "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: SESSION,
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
    },
    parent_tool_use_id: null,
    session_id: SESSION,
  },
  {
    ...RESULT,
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: "tool_use",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
    terminal_reason: "aborted_tools",
  },
];

/**
 * Messages of a real background shell command that finished after the turn
 * that started it had ended, captured from the same live CLI. The CLI reports
 * the task's end, then the model answers it in a turn of its own.
 */
const FINISHED_TASK: ReadonlyArray<unknown> = [
  {
    type: "system",
    subtype: "background_tasks_changed",
    uuid: "0199e0e7-0000-7000-8000-000000000201",
    session_id: SESSION,
  },
  {
    type: "system",
    subtype: "task_updated",
    task_id: "bf2g0pk9r",
    patch: { status: "completed", end_time: 1790000000000 },
    uuid: "0199e0e7-0000-7000-8000-000000000202",
    session_id: SESSION,
  },
  {
    type: "system",
    subtype: "task_notification",
    task_id: "bf2g0pk9r",
    status: "completed",
    output_file: "/tmp/claude/tasks/bf2g0pk9r.output",
    summary: 'Background command "Count 1 to 20 with one-second pauses" completed (exit code 0)',
    uuid: "0199e0e7-0000-7000-8000-000000000203",
    session_id: SESSION,
  },
];

const FOLLOW_UP = "The background count has finished.";

const FINISHED_TASK_ANSWER: ReadonlyArray<unknown> = [
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: FOLLOW_UP }] },
    parent_tool_use_id: null,
    session_id: SESSION,
  },
  RESULT,
];

describe("a turn the user interrupts", () => {
  it("ends as interrupted, with the stopped command failed and no item for the task messages", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "count to 30" }));
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    for (const message of STOPPED_TURN) run.say(message);
    await waitUntil("closed the turn", () =>
      run.seen.some((event) => event._tag === "turn.completed"),
    );

    const completed = run.seen.find((event) => event._tag === "turn.completed");
    expect(completed).toMatchObject({ state: "interrupted" });
    expect(
      filterItems(run.seen, "command_execution").map((event) =>
        event._tag === "item.completed" ? event.status : "started",
      ),
    ).toEqual(["started", "failed"]);
    expect(filterItems(run.seen, "unknown")).toEqual([]);
    expect(listOpenedTurns(run.seen)).toHaveLength(1);
  });
});

describe("a background task that finishes between turns", () => {
  it("opens no turn for the task messages, and the model's answer is one turn with its text", async () => {
    const run = createDriving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "count in the background" }));
    run.say(RESULT);
    await waitUntil("closed the first turn", () =>
      run.seen.some((event) => event._tag === "turn.completed"),
    );

    for (const message of FINISHED_TASK) run.say(message);
    for (const message of FINISHED_TASK_ANSWER) run.say(message);
    await waitUntil(
      "closed the answer's turn",
      () => run.seen.filter((event) => event._tag === "turn.completed").length === 2,
    );

    // Two turns: the user's, and the one the model's answer opened. The task
    // messages in between open none.
    expect(listOpenedTurns(run.seen)).toHaveLength(2);
    expect(filterItems(run.seen, "unknown")).toEqual([]);
    const answerTurn = listOpenedTurns(run.seen)[1];
    const text = run.seen.flatMap((event) =>
      event._tag === "content.delta" && event.turnId === answerTurn ? [event.delta] : [],
    );
    expect(text.join("")).toBe(FOLLOW_UP);
  });
});

describe("an image a tool returns", () => {
  it("reaches the item's content and raw payload as a reference, never as bytes", async () => {
    const run = createDriving();
    const data = testing.PNG_BYTES.toString("base64");
    const uploaded: Array<{ readonly sessionId: string; readonly bytes: Uint8Array }> = [];
    const stored = {
      id: "0199e0e7-0000-7000-8000-0000000000c1",
      mimeType: "image/png",
      sizeBytes: testing.PNG_BYTES.length,
    } as const;
    await Effect.runPromise(
      run.adapter.startSession(SESSION, SPEC, {
        ...WORKING,
        attachmentUploader: {
          upload: (sessionId, bytes) =>
            Effect.sync(() => {
              uploaded.push({ sessionId, bytes });
              return { type: "image", attachment: stored };
            }),
        },
      }),
    );
    run.say({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/tmp/a.png" } },
        ],
      },
      parent_tool_use_id: null,
      session_id: SESSION,
    });
    run.say({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_read",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
          },
        ],
      },
      tool_use_result: {
        type: "image",
        file: { base64: data, type: "image/png", originalSize: testing.PNG_BYTES.length },
      },
      parent_tool_use_id: null,
      session_id: SESSION,
    });

    await waitUntil("completed the read", () =>
      run.seen.some((event) => event._tag === "item.completed"),
    );
    const completed = run.seen.find((event) => event._tag === "item.completed");
    const reference = { type: "image", attachment: stored };
    expect(completed?.detail).toMatchObject({ content: [reference] });
    expect(completed?.raw?.payload).toMatchObject({
      tool_use_result: { file: { base64: reference } },
    });
    expect(JSON.stringify(completed)).not.toContain(data);
    // The same image in the content and in the structured output is one upload.
    expect(uploaded.map((upload) => ({ ...upload, bytes: Buffer.from(upload.bytes) }))).toEqual([
      { sessionId: SESSION, bytes: testing.PNG_BYTES },
    ]);
  });
});

describe("a text generation", () => {
  const TITLE_SCHEMA: OutputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["title", "needsRefinement"],
    properties: { title: { type: "string" }, needsRefinement: { type: "boolean" } },
  };

  const TITLE = { title: "Fix flaky login test", needsRefinement: false };

  const GENERATION: TextGenerationSpec = {
    model: "haiku",
    instructions: "Write a short title for the user's message.",
    input: "fix the flaky login test",
    outputSchema: TITLE_SCHEMA,
  };

  /** What one fake query did: the options it got, the messages it read, and how often it was closed. */
  interface Query {
    readonly options: Options;
    readonly messages: Array<SDKUserMessage>;
    readonly closes: () => number;
  }

  /**
   * Builds an adapter whose harness answers a text generation with `answer`:
   * the messages it yields, an error it throws instead, or `"hangs"` for a
   * harness that never answers. `closing` is what closing the query returns,
   * for a harness that takes time to shut down.
   */
  const createGenerating = (
    answer: ReadonlyArray<unknown> | Error | "hangs",
    closing?: Promise<void>,
  ): { readonly adapter: HarnessAdapter; readonly queries: Array<Query> } => {
    const queries: Array<Query> = [];
    const seam: ClaudeSeam = {
      query: () => {
        throw new Error("a text generation must not use the probe query");
      },
      stream: ({ options, input }) => {
        let closes = 0;
        const messages: Array<SDKUserMessage> = [];
        queries.push({ options, messages, closes: () => closes });
        return {
          async *[Symbol.asyncIterator]() {
            for await (const message of input) messages.push(message);
            if (answer === "hangs") await new Promise<never>(() => undefined);
            if (answer instanceof Error) throw answer;
            for (const message of answer) yield message as SDKMessage;
          },
          interrupt: () => Promise.resolve(),
          setModel: () => Promise.resolve(),
          stopTask: () => Promise.resolve(),
          close: () => {
            closes += 1;
            return closing;
          },
        };
      },
      run: () => Effect.die("a text generation must not run a process"),
    };
    return { adapter: makeClaudeCodeAdapter(seam), queries };
  };

  const generate = (
    adapter: HarnessAdapter,
    context: HarnessRunnerContext = CONTEXT,
  ): Promise<TextGenerationOutcome> =>
    Effect.runPromise(
      Effect.catch(
        adapter.generateText(testing.buildTextGenerationContext(context), GENERATION),
        (message) => Effect.succeed<TextGenerationOutcome>({ outcome: "failed", message }),
      ),
    );

  it("returns the structured output with the usage when it matches the schema", async () => {
    const { adapter } = createGenerating([{ ...RESULT, structured_output: TITLE }]);

    expect(await generate(adapter)).toEqual({
      outcome: "ok",
      value: TITLE,
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.01,
      },
    });
  });

  it("reports no usage when the harness listed no model", async () => {
    const { adapter } = createGenerating([{ ...RESULT, structured_output: TITLE, modelUsage: {} }]);

    expect(await generate(adapter)).toMatchObject({ outcome: "ok", usage: null });
  });

  it("ignores the messages before the result", async () => {
    const { adapter } = createGenerating([
      { type: "system", subtype: "init" },
      { type: "assistant", message: { role: "assistant", content: [] } },
      { ...RESULT, structured_output: TITLE },
    ]);

    expect(await generate(adapter)).toMatchObject({ outcome: "ok", value: TITLE });
  });

  describe("when the harness answers but not with a matching value", () => {
    it("is invalid output when the answer does not match the schema, and names the field", async () => {
      const { adapter } = createGenerating([
        { ...RESULT, structured_output: { title: 7, needsRefinement: false } },
      ]);

      expect(await generate(adapter)).toEqual({
        outcome: "invalid-output",
        reason: expect.stringContaining("title") as string,
      });
    });

    it("is invalid output when the harness produced no structured output", async () => {
      const { adapter } = createGenerating([RESULT]);

      expect(await generate(adapter)).toEqual({
        outcome: "invalid-output",
        reason: expect.stringMatching(/\S/) as string,
      });
    });

    it.each(["error_max_structured_output_retries", "error_max_turns"])(
      "is invalid output when the harness stopped with %s",
      async (subtype) => {
        const { adapter } = createGenerating([{ ...RESULT, subtype, is_error: true, errors: [] }]);

        expect(await generate(adapter)).toEqual({
          outcome: "invalid-output",
          reason: expect.stringMatching(/\S/) as string,
        });
      },
    );
  });

  describe("when the call does not produce an answer", () => {
    it("fails with the harness's own message when the result is an error", async () => {
      const { adapter } = createGenerating([
        { ...RESULT, is_error: true, result: "Not logged in · Please run /login" },
      ]);

      expect(await generate(adapter)).toEqual({
        outcome: "failed",
        message: "Not logged in · Please run /login",
      });
    });

    it("leaves out the text the model had written when the harness stopped the turn", async () => {
      const { adapter } = createGenerating([
        {
          ...RESULT,
          terminal_reason: "aborted_by_user",
          result: "PRIVATE_CUSTOMER_KEY_73dbfa is what I had so far",
        },
      ]);

      const outcome = await generate(adapter);

      expect(outcome).toEqual({
        outcome: "failed",
        message: expect.stringMatching(/\S/) as string,
      });
      expect(JSON.stringify(outcome)).not.toContain("PRIVATE_CUSTOMER_KEY_73dbfa");
    });

    it("fails with the error's message when the harness cannot run", async () => {
      const { adapter } = createGenerating(new Error("spawn claude ENOENT"));

      expect(await generate(adapter)).toEqual({
        outcome: "failed",
        message: "spawn claude ENOENT",
      });
    });

    it("fails when the harness ends without a result", async () => {
      const { adapter } = createGenerating([{ type: "system", subtype: "init" }]);

      expect(await generate(adapter)).toEqual({
        outcome: "failed",
        message: expect.stringMatching(/\S/) as string,
      });
    });
  });

  describe("the harness it starts", () => {
    it("gets no tools, no saved transcript, no setting source and no MCP server", async () => {
      const { adapter, queries } = createGenerating([{ ...RESULT, structured_output: TITLE }]);
      await generate(adapter);

      const options = queries[0]!.options;
      expect(options.tools).toEqual([]);
      expect(options.persistSession).toBe(false);
      expect(options.settingSources).toEqual([]);
      expect(options.strictMcpConfig).toBe(true);
      expect(options.mcpServers).toBeUndefined();
      expect(options.plugins).toBeUndefined();
    });

    it("gets the schema, the model, the instructions and the cheapest reasoning", async () => {
      const { adapter, queries } = createGenerating([{ ...RESULT, structured_output: TITLE }]);
      await generate(adapter);

      expect(queries[0]!.options).toMatchObject({
        pathToClaudeCodeExecutable: "/usr/local/bin/claude",
        outputFormat: { type: "json_schema", schema: TITLE_SCHEMA },
        model: "haiku",
        systemPrompt: GENERATION.instructions,
        thinking: { type: "disabled" },
        effort: "low",
      });
    });

    it("reads one user message, the input", async () => {
      const { adapter, queries } = createGenerating([{ ...RESULT, structured_output: TITLE }]);
      await generate(adapter);

      expect(queries[0]!.messages.map((message) => message.message)).toEqual([
        { role: "user", content: GENERATION.input },
      ]);
    });

    it("gets the Harness Home and credentials as a session does", async () => {
      const { adapter, queries } = createGenerating([{ ...RESULT, structured_output: TITLE }]);
      await generate(adapter, { ...CONTEXT, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "key" } });

      expect(queries[0]!.options.env).toMatchObject({
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "key",
        CLAUDE_CONFIG_DIR: CONTEXT.home,
      });
    });

    it("runs in the scratch directory the runner made for the call", async () => {
      const { adapter, queries } = createGenerating([{ ...RESULT, structured_output: TITLE }]);
      const ctx = testing.buildTextGenerationContext(CONTEXT);
      await Effect.runPromise(adapter.generateText(ctx, GENERATION));

      expect(queries[0]!.options.cwd).toBe(ctx.cwd);
    });

    it.each([
      ["answers", [{ ...RESULT, structured_output: TITLE }]],
      ["fails", new Error("boom")],
    ])("is closed when it %s", async (_, answer) => {
      const { adapter, queries } = createGenerating(answer);
      await generate(adapter);

      expect(queries[0]!.closes()).toBe(1);
    });

    it("returns only after the harness has finished closing", async () => {
      const closed = Promise.withResolvers<void>();
      const { adapter, queries } = createGenerating(
        [{ ...RESULT, structured_output: TITLE }],
        closed.promise,
      );
      const outcome = generate(adapter);
      await waitUntil("closed the query", () => queries[0]?.closes() === 1);

      let returned = false;
      void outcome.then(() => {
        returned = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(returned).toBe(false);

      closed.resolve();
      expect(await outcome).toMatchObject({ outcome: "ok" });
    });

    it("is closed when the caller gives up on a harness that never answers", async () => {
      const { adapter, queries } = createGenerating("hangs");
      const outcome = await Effect.runPromise(
        adapter
          .generateText(testing.buildTextGenerationContext(CONTEXT), GENERATION)
          .pipe(Effect.timeoutOption("50 millis")),
      );

      expect(Option.isNone(outcome)).toBe(true);
      expect(queries[0]!.closes()).toBe(1);
    });
  });
});

/** The skills the tests below reference: two library skills and one repository skill. */
const LOADED_SKILLS: LoadedSkills = new Map([
  ["review", { source: "library", skillName: "review", folder: "/skills/review" }],
  ["implement", { source: "library", skillName: "implement", folder: "/skills/implement" }],
  [
    "webshop:release",
    {
      source: "repository",
      skillName: "release",
      checkoutName: "webshop",
      folder: "/repos/webshop/.claude/skills/release",
    },
  ],
]);

/** Returns an input whose Skill References are resolved against `LOADED_SKILLS`, as the supervisor does. */
function buildSkillInput(text: string): AdapterTurnInput {
  return { text, skillReferences: resolveSkillReferences(text, LOADED_SKILLS) };
}

describe("the text Claude gets for the Skill References of an input", () => {
  const SENDER = "0199e0e7-0000-7000-8000-0000000000e1";
  const HEADER = `[Message from session ${SENDER}, another agent. To reply: hercule session input ${SENDER}]`;

  it("is the plain prompt, with no command, when the input has no skills", () => {
    expect(buildClaudePromptParts({ text: "no $skills here, only $20" })).toEqual({
      leading: "no $skills here, only $20",
      command: undefined,
    });
  });

  it("is the command alone when the skill starts the text", () => {
    expect(buildClaudePromptParts(buildSkillInput("$review the diff"))).toEqual({
      leading: "",
      command: "/skills:review the diff",
    });
  });

  it("leaves out the space when nothing follows the skill", () => {
    expect(buildClaudePromptParts(buildSkillInput("$review"))).toEqual({
      leading: "",
      command: "/skills:review",
    });
    expect(buildClaudePromptParts(buildSkillInput("$review   \n"))).toEqual({
      leading: "",
      command: "/skills:review",
    });
  });

  it("puts the text before a skill in the leading part and the text after it in the command", () => {
    expect(buildClaudePromptParts(buildSkillInput("please $review the diff"))).toEqual({
      leading: "please",
      command: "/skills:review the diff",
    });
  });

  it("replaces every skill but the last in place, and makes the last one the command", () => {
    expect(
      buildClaudePromptParts(buildSkillInput("please $review the diff, then $implement")),
    ).toEqual({
      leading: "please /skills:review the diff, then",
      command: "/skills:implement",
    });
  });

  it("names a repository skill by its checkout, in the command and in place", () => {
    expect(buildClaudePromptParts(buildSkillInput("$webshop:release now"))).toEqual({
      leading: "",
      command: "/repo-webshop:release now",
    });
    expect(buildClaudePromptParts(buildSkillInput("after $webshop:release do $review"))).toEqual({
      leading: "after /repo-webshop:release do",
      command: "/skills:review",
    });
  });

  it("translates the same skill each time it appears", () => {
    expect(buildClaudePromptParts(buildSkillInput("$review, then $review again"))).toEqual({
      leading: "/skills:review, then",
      command: "/skills:review again",
    });
  });

  it("leaves a token that names no loaded skill as typed", () => {
    expect(buildClaudePromptParts(buildSkillInput("$nothing, then $review"))).toEqual({
      leading: "$nothing, then",
      command: "/skills:review",
    });
  });

  it("keeps a colon after the skill in the command's text", () => {
    expect(buildClaudePromptParts(buildSkillInput("run $review: now"))).toEqual({
      leading: "run",
      command: "/skills:review : now",
    });
  });

  it("keeps the sender header in the leading part, ahead of the text", () => {
    expect(
      buildClaudePromptParts({ ...buildSkillInput("please $review it"), senderSessionId: SENDER }),
    ).toEqual({ leading: `${HEADER}\n\nplease`, command: "/skills:review it" });
    expect(
      buildClaudePromptParts({ ...buildSkillInput("$review it"), senderSessionId: SENDER }),
    ).toEqual({ leading: HEADER, command: "/skills:review it" });
  });
});

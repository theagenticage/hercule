/**
 * The Claude Code adapter's probe, with the vendor SDK stubbed. The fixtures
 * are shapes captured from the real CLI at 2.1.263, not shapes invented here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import type {
  Options,
  PermissionResult,
  PermissionUpdate,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_VERSION } from "@hydra/home/version";
import {
  MAX_MESSAGE_LENGTH,
  type ApprovalDecision,
  type OpenRequest,
  type OutputSchema,
  type ProbeResult,
  type ProviderEvent,
  type SessionSpec,
} from "@hydra/protocol";
import { claudeCodeAdapter, type ClaudeSeam } from "./claude-code";
import { PROBE_DEADLINE } from "./probe";
import type { ProviderAdapter, ProviderRunnerContext } from "./index";

/** What the runner resolved once, at start, for hydra-as-a-tool. */
const HYDRA_TOOL = {
  skill: "# hydra\n\nCall `hydra --help`.\n",
  claudePluginDir: "/var/hydra/runner/storage/claude-plugin",
};

const CONTEXT: ProviderRunnerContext = {
  cwd: null,
  home: "/var/hydra/runner/providers/0199e0e7-0000-7000-8000-00000000000a",
  binary: "/usr/local/bin/claude",
  env: { PATH: "/usr/local/bin:/usr/bin" },
  secrets: {},
  hydraTool: HYDRA_TOOL,
};

const AUTHENTICATED = {
  email: "rogier@example.com",
  organization: "Rogier's Org",
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
};

const UNAUTHENTICATED = { tokenSource: "none", apiProvider: "firstParty" };

/** Three rows of the six the CLI reported, chosen for the three option shapes. */
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

const seamOver = (answers: {
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
  answers: Parameters<typeof seamOver>[0] = {},
): {
  readonly result: Promise<ProbeResult>;
  readonly calls: Array<Call>;
  readonly closed: () => number;
} => {
  const { seam, calls, closed } = seamOver(answers);
  return {
    result: Effect.runPromise(claudeCodeAdapter(seam).probe(CONTEXT, {})),
    calls,
    closed,
  };
};

const optionOf = (
  models: ProbeResult["models"],
  slug: string,
  id: string,
): Record<string, unknown> | undefined =>
  models.find((model) => model.slug === slug)?.options.find((option) => option.id === id);

describe("what the Claude adapter reports about a machine that is logged in", () => {
  it("names the account, its plan and its backend", async () => {
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

    expect(optionOf(probed.models, "default", "effort")).toMatchObject({
      kind: "select",
      choices: [{ value: "low" }, { value: "medium" }, { value: "high" }] as ReadonlyArray<unknown>,
      default: "medium",
    });
    expect(optionOf(probed.models, "default", "fastMode")).toMatchObject({
      kind: "boolean",
      default: false,
    });

    // The composer must offer only what the harness accepts for that model.
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

  it("leaves a slug the CLI still lists out of the overlay, keeping the probed row", async () => {
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

describe("what the Claude adapter reports about a machine that is not logged in", () => {
  it("says so, and names nobody", async () => {
    const { result } = probeWith({ accountInfo: () => Promise.resolve(UNAUTHENTICATED) });

    const probed = await result;
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
    // Not an error: an empty config directory is an ordinary machine, and the
    // version and the catalogue are still facts about it.
    expect(probed.auth.message).toBeUndefined();
    expect(probed.harnessVersion).toBe("9.9.9");
  });
});

describe("what the Claude adapter reports about a credential from the environment", () => {
  // The two shapes the SDK 0.3.263 really answers with when the config
  // directory holds no login but the environment carries a credential. Neither
  // names an account, and both run: spec 06 section 3.2 asks whether there is a
  // usable login, not whether the harness can name whose it is.
  it("counts an OAuth token as a login, with nobody to name", async () => {
    const { result } = probeWith({
      accountInfo: () =>
        Promise.resolve({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("ok");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.auth.backend).toBe("firstParty");
  });

  it("does not count a machine with neither source as a login", async () => {
    const { result } = probeWith({
      accountInfo: () => Promise.resolve({ tokenSource: "none", apiKeySource: "none" }),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("unauthenticated");
  });

  it("counts a third-party backend as a login, authenticated outside the harness", async () => {
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

describe("what the Claude adapter reports when the probe did not finish", () => {
  it("says what the SDK threw, so the user reads why rather than a blank row", async () => {
    const { result } = probeWith({
      accountInfo: () => Promise.reject(new Error("spawn /usr/local/bin/claude ENOENT")),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message).toContain("ENOENT");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.models).toEqual([]);
  });

  it("gives the SDK fifteen seconds and then says it did not answer", async () => {
    expect(Duration.toSeconds(PROBE_DEADLINE)).toBe(15);

    const { seam } = seamOver({ accountInfo: () => new Promise<never>(() => undefined) });
    const probed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(claudeCodeAdapter(seam).probe(CONTEXT, {}));
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

describe("how the Claude adapter asks the SDK", () => {
  it("runs a query with no prompt, no settings and no session left behind", async () => {
    const { result, calls } = probeWith({});
    await result;

    expect(calls).toHaveLength(1);
    const params = calls[0]!.params;
    // A prompt that yields makes a real API call at the same instant as the
    // init message; a probe must make none.
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

  it("points the harness at the instance's own home and never at the user's", async () => {
    const { result, calls } = probeWith({});
    await result;

    const env = calls[0]!.params.options["env"] as Record<string, string>;
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(CONTEXT.home);
    // A probe that let the harness update itself would install a version
    // nobody chose in the middle of answering a question about versions.
    expect(env["DISABLE_AUTOUPDATER"]).toBe("1");
    // The one thing that must never move: with `HOME` overridden the CLI reads
    // and writes the wrong account's credential and reports it as this one's.
    expect(Object.keys(env)).not.toContain("HOME");
    expect(env["PATH"]).toBe(CONTEXT.env["PATH"]);
  });
});

describe("the CLI version this build talks to", () => {
  it("is the one the SDK beside it was built against", () => {
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

    // Baked at build rather than read at runtime: a compiled binary has no
    // manifest on disk to read.
    expect(CLAUDE_CODE_VERSION).toBe(manifest.claudeCodeVersion);
  });
});

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const SPEC: SessionSpec = {
  instanceId: "0199e0e7-0000-7000-8000-00000000000a",
  workspaceId: null,
  modelSelection: { model: "claude-haiku-4-5", options: { effort: "high", fastMode: false } },
  accessMode: "auto-accept-edits",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

const WORKING: ProviderRunnerContext = { ...CONTEXT, cwd: "/var/hydra/runner/scratch/one" };

/** The harness end of a session, driven by the test one message at a time. */
interface Driving {
  readonly adapter: ProviderAdapter;
  readonly options: Array<Options>;
  readonly sent: Array<SDKUserMessage>;
  readonly seen: Array<ProviderEvent>;
  readonly say: (message: unknown) => void;
  readonly end: () => void;
  readonly die: (reason: Error) => void;
  readonly models: Array<string>;
  readonly closed: () => number;
  readonly interrupted: () => number;
  /** A harness that will not take the model it was asked for. */
  refusesModel: boolean;
  /** A harness that takes its time over it, so a stop can land while it does. */
  holdsModel: boolean;
  readonly releaseModel: () => void;
}

const driving = (): Driving => {
  const options: Array<Options> = [];
  const sent: Array<SDKUserMessage> = [];
  const seen: Array<ProviderEvent> = [];
  const queued: Array<unknown> = [];
  const waiting: Array<(result: IteratorResult<unknown>) => void> = [];
  const failing: Array<(reason: Error) => void> = [];
  const done: IteratorResult<unknown> = { done: true, value: undefined };
  const models: Array<string> = [];
  let ended = false;
  let closes = 0;
  let interrupts = 0;
  let releaseModel: (() => void) | undefined;

  const adapter = claudeCodeAdapter({
    query: () => {
      throw new Error("a session must not probe");
    },
    stream: (params) => {
      options.push(params.options);
      // Reading the adapter's input is what a real harness does with it, and
      // it is the only way to see the turns it was handed.
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
 * How long a wait on the adapter's pump is given. The adapter reads the harness
 * off the event loop and publishes what it read, so how many turns of the loop
 * that takes is a property of how busy the machine is - which is why the wait is
 * for the event, and not for a tick.
 */
const WAIT_DEADLINE_MS = 10_000;

/**
 * Vitest's own budget, set from the waits rather than left at its default five
 * seconds: a test whose waits can outlast the timeout never gets to give up,
 * and the failure names the test rather than the event that never came. Two,
 * because the longest case here waits for one turn to close and the next to open.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 5_000 });

const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(ready(), `the adapter never ${what}`).toBe(true);
};

/** Waits until the session has ended, however it ended. */
const ends = (seen: ReadonlyArray<ProviderEvent>): Promise<void> =>
  until("ended the session", () => seen.some((event) => event._tag === "session.exited"));

const tags = (seen: ReadonlyArray<ProviderEvent>): ReadonlyArray<string> =>
  seen.map((event) => event._tag);

/** The item events of one kind, in the order they were published. */
const itemsOf = (
  seen: ReadonlyArray<ProviderEvent>,
  kind: string,
): ReadonlyArray<Extract<ProviderEvent, { _tag: "item.started" | "item.completed" }>> =>
  seen.filter(
    (event): event is Extract<ProviderEvent, { _tag: "item.started" | "item.completed" }> =>
      (event._tag === "item.started" || event._tag === "item.completed") && event.kind === kind,
  );

const opened = (seen: ReadonlyArray<ProviderEvent>): ReadonlyArray<string> =>
  seen.flatMap((event) => (event._tag === "turn.started" ? [event.turnId] : []));

describe("a Claude Code session", () => {
  it("names the native session itself, hands back the binding and says it started", async () => {
    const run = driving();
    const binding = await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    expect(binding.sessionId).toBe(SESSION);
    expect(binding.instanceId).toBe(SPEC.instanceId);
    // Hydra names the native session rather than waiting to be told: in
    // streaming-input mode the CLI says nothing at all until a first turn.
    expect(binding.nativeSessionId).not.toBe(SESSION);
    expect(run.options[0]?.sessionId).toBe(binding.nativeSessionId);
    await until("said it started", () => run.seen.length === 1);
    expect(tags(run.seen)).toEqual(["session.started"]);
    // The only place the controller can learn the native id: the report of what
    // this runner holds is sent once, at hello.
    expect(run.seen[0]?.providerRefs).toEqual({ nativeSessionId: binding.nativeSessionId });
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([binding]);
  });

  it("runs in the session's cwd, with the instance's home and no settings of the machine's", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const [options] = run.options;
    expect(options?.cwd).toBe(WORKING.cwd);
    expect(options?.settingSources).toEqual([]);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.includePartialMessages).toBe(true);
    expect(options?.model).toBe(SPEC.modelSelection.model);
    expect(options?.effort).toBe("high");
    // Spec 06 section 8.1, normative.
    expect(options?.permissionMode).toBe("acceptEdits");
    expect(options?.env?.["CLAUDE_CONFIG_DIR"]).toBe(WORKING.home);
    expect(options?.env?.["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
    expect(Object.keys(options?.env ?? {})).not.toContain("HOME");
  });

  it("loads hydra-as-a-tool as a local plugin, and no settings of the machine's", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const [options] = run.options;
    // The one plugin Hydra owns, loaded from the directory the runner wrote it
    // into, so nothing is copied per session and a Thread's own `.claude/` is
    // never collided with (spec 06 section 9.3).
    expect(options?.plugins).toEqual([{ type: "local", path: HYDRA_TOOL.claudePluginDir }]);
    // Explicitly beside it: the skill has to be discovered with no setting
    // source at all, which is what makes this the Hydra-owned channel rather
    // than whatever files happen to sit on this runner (spec 06 section 10.1).
    expect(options?.settingSources).toEqual([]);
  });

  // Spec 06 section 8.1 is normative, and full-access is the row that matters.
  const MODES: ReadonlyArray<readonly [SessionSpec["accessMode"], string, boolean | undefined]> = [
    ["approval-required", "default", undefined],
    ["auto-accept-edits", "acceptEdits", undefined],
    ["auto", "auto", undefined],
    ["full-access", "bypassPermissions", true],
  ];

  for (const [accessMode, permissionMode, dangerous] of MODES) {
    it(`runs ${accessMode} as the harness's ${permissionMode}`, async () => {
      const run = driving();
      await Effect.runPromise(run.adapter.startSession(SESSION, { ...SPEC, accessMode }, WORKING));

      expect(run.options[0]?.permissionMode).toBe(permissionMode);
      expect(run.options[0]?.allowDangerouslySkipPermissions).toBe(dangerous);
      // In every mode but full-access, not only in `approval-required`: the
      // harness decides whether it asks, and a mode that asks about nothing
      // simply never calls back. With permissions skipped the SDK ignores the
      // callback and warns once per session, so it is not supplied there.
      expect(typeof run.options[0]?.canUseTool).toBe(
        accessMode === "full-access" ? "undefined" : "function",
      );
    });
  }

  it("opens a turn on an idle session, and says so on its own authority", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    // The delivery is the adapter's answer, not something the controller infers
    // from the order events arrive in (ADR 0007).
    expect(sent.delivery).toBe("opened");
    await until(
      "published the user's own message",
      () => itemsOf(run.seen, "user_message").length === 2,
    );
    // The turn it named is the turn it opened.
    expect(opened(run.seen)).toEqual([sent.turnId]);
    const [started, completed] = itemsOf(run.seen, "user_message");
    expect(started?._tag).toBe("item.started");
    expect(completed?._tag).toBe("item.completed");
    // No `steered` key at all: an input that opened a turn did not steer one,
    // and `steered: false` would be a third state nothing in the spec has.
    expect(started?.detail).toEqual({ text: "hello" });
    expect(completed?.detail).toEqual({ text: "hello" });
    expect(started?.turnId).toBe(sent.turnId);
    expect(run.sent.map((message) => message.message.content)).toEqual(["hello"]);
  });

  it("steers a busy one, folding the input into the turn already running", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const first = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    const second = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "and this" }));

    expect(second).toEqual({ turnId: first.turnId, delivery: "steered" });
    await until(
      "published both user messages",
      () => itemsOf(run.seen, "user_message").length === 4 && run.sent.length === 2,
    );
    // One turn, opened once: steering folds into the turn that is running.
    expect(opened(run.seen)).toEqual([first.turnId]);
    const [, , started, completed] = itemsOf(run.seen, "user_message");
    expect(started?.detail).toEqual({ text: "and this", steered: true });
    expect(completed?.detail).toEqual({ text: "and this", steered: true });
    expect(run.sent.map((message) => message.message.content)).toEqual(["hello", "and this"]);
  });

  it("does not say the same thing twice when the harness echoes the input back", async () => {
    const run = driving();
    const binding = await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    await until(
      "published the user's own message",
      () => itemsOf(run.seen, "user_message").length === 2,
    );

    // What the CLI sends back on its own: its echo of the turn it was handed.
    run.say({
      type: "user",
      session_id: binding.nativeSessionId,
      parent_tool_use_id: null,
      message: { role: "user", content: "hello" },
    });
    // The result is the marker: it can only be read after the echo before it was.
    run.say(RESULT);
    await until("closed the turn", () => run.seen.some((event) => event._tag === "turn.completed"));

    expect(itemsOf(run.seen, "user_message")).toHaveLength(2);
  });

  it("opens a second turn once the result closed the first", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    run.say(RESULT);
    await until("closed the first turn", () =>
      run.seen.some((event) => event._tag === "turn.completed"),
    );

    const again = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "again" }));
    await until("opened the second turn", () => opened(run.seen).length === 2);
    expect(again.delivery).toBe("opened");
    expect(
      tags(run.seen).filter((tag) => tag.startsWith("turn.") || tag === "session.started"),
    ).toEqual(["session.started", "turn.started", "turn.completed", "turn.started"]);
    expect(opened(run.seen)[1]).toBe(again.turnId);
  });

  it("ends the running turn when asked, and asks nothing where no turn is running", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    // Idle: the harness is not asked at all, because a control request waits on
    // it and the connection handles session frames one at a time.
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(run.interrupted()).toBe(0);

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    await Effect.runPromise(run.adapter.interrupt(SESSION));
    expect(run.interrupted()).toBe(1);

    await Effect.runPromise(run.adapter.interrupt("0199e0e7-0000-7000-8000-0000000000aa"));
    expect(run.interrupted()).toBe(1);
  });

  it("resumes the native session it was given, naming nothing of its own", async () => {
    const run = driving();
    const carried = {
      nativeSessionId: "0199e0e7-0000-7000-8000-0000000000ab",
      mode: "resume",
    } as const;
    const binding = await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, continue: carried }, WORKING),
    );

    // A resume continues that native session, so there is nothing to name.
    expect(binding.nativeSessionId).toBe(carried.nativeSessionId);
    expect(run.options[0]?.resume).toBe(carried.nativeSessionId);
    expect(run.options[0]?.forkSession).toBeUndefined();
    expect(run.options[0]?.sessionId).toBeUndefined();
  });

  it("forks off the native session it was given, under a name of its own", async () => {
    const run = driving();
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
    // The fork is named for the same reason a fresh session is: the CLI says
    // nothing at all until a first turn, so a binding cannot wait to be told.
    expect(run.options[0]?.sessionId).toBe(binding.nativeSessionId);
  });

  it("refuses the input where the session was stopped while the model was changing", async () => {
    const run = driving();
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
    await until("asked the harness for the model", () => run.models.length === 1);
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    run.releaseModel();

    // The session the input was checked against is gone; saying it was
    // delivered would be a message the user believes was sent and was not.
    expect(await sending).toBe(`session ${SESSION} is not running here`);
    expect(run.sent).toEqual([]);
  });

  it("exits as stopped when it was asked to, and forgets the session", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    await ends(run.seen);

    expect(run.closed()).toBe(1);
    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("stopped");
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });

  it("keeps the first reason when a second stop asks for a different one", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "inactivity_timeout"));
    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    await ends(run.seen);

    expect(run.closed()).toBe(1);
    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe(
      "inactivity_timeout",
    );
  });

  it("exits as a process exit when the harness stops on its own", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    run.end();
    await ends(run.seen);

    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("process_exit");
  });

  it("says the harness crashed, and why, when its stream throws", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    run.die(new Error("the harness went away"));
    await ends(run.seen);

    const failure = run.seen.find((event) => event._tag === "runtime.error");
    expect(failure?._tag === "runtime.error" ? failure.message : undefined).toBe(
      "the harness went away",
    );
    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("crash");
  });

  it("does not report an ordinary stop as a runtime error", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    run.die(new Error("Query closed before response received"));
    await ends(run.seen);

    expect(tags(run.seen)).toEqual(["session.started", "session.exited"]);
  });

  it("refuses input for a session it is not hosting", async () => {
    const run = driving();
    const said = await Effect.runPromise(
      Effect.flip(run.adapter.sendInput(SESSION, { text: "hello" })),
    );
    expect(said).toBe(`session ${SESSION} is not running here`);
  });

  it("refuses input the moment a stop was asked for, rather than dropping it", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    const said = await Effect.runPromise(
      Effect.flip(run.adapter.sendInput(SESSION, { text: "hello" })),
    );

    expect(said).toBe(`session ${SESSION} is not running here`);
  });

  it("will not start a second harness under a session id it already holds", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const said = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, SPEC, WORKING)),
    );

    expect(said).toBe(`session ${SESSION} is already running here`);
    // The one that was already running is untouched: one harness, one stream.
    expect(run.options.length).toBe(1);
    expect(run.closed()).toBe(0);
  });

  it("will not start without a harness on this machine", async () => {
    const run = driving();
    const said = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, SPEC, { ...WORKING, binary: undefined })),
    );
    expect(said).toBe("no claude on this machine");
  });
});

/**
 * `sendInput` calls `setModel` only when the model an opening input asks for
 * differs from the one last applied to the harness, which starts as the
 * spec's own model from `startSession`.
 */
describe("the model the adapter last applied to the harness", () => {
  it("calls setModel before the input is pushed, and answers opened", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    run.holdsModel = true;

    const sending = Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "hello",
        modelSelection: { model: "claude-opus-4-8", options: {} },
      }),
    );
    await until("asked the harness for the model", () => run.models.length === 1);
    // The harness has not been told what to say yet - it is still deciding
    // whether it will even take the model.
    expect(run.sent).toEqual([]);
    run.releaseModel();

    const result = await sending;
    expect(result.delivery).toBe("opened");
    expect(run.sent.map((message) => message.message.content)).toEqual(["hello"]);
  });

  it("does not call setModel again for the same model on a later opening input", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));
    const selection = { model: "claude-opus-4-8", options: {} };

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "hello", modelSelection: selection }),
    );
    expect(run.models).toEqual(["claude-opus-4-8"]);

    // The turn closes, so the next input opens a turn of its own rather than
    // folding into the one already running.
    run.say(RESULT);
    await until("closed the first turn", () =>
      run.seen.some((event) => event._tag === "turn.completed"),
    );

    const second = await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "again", modelSelection: selection }),
    );

    // Still the model last applied, so the harness is not asked a second time.
    expect(run.models).toEqual(["claude-opus-4-8"]);
    expect(second.delivery).toBe("opened");
  });

  it("does not call setModel when the first opening input names the spawn's own model", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    // What the harness was started under, so this asks for no change at all.
    const result = await Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "hello",
        modelSelection: { model: SPEC.modelSelection.model, options: {} },
      }),
    );

    expect(run.models).toEqual([]);
    expect(result.delivery).toBe("opened");
  });

  it("does not call setModel mid-turn, whatever model the input names, and steers", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const first = await Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "hello",
        modelSelection: { model: "claude-opus-4-8", options: {} },
      }),
    );
    expect(run.models).toEqual(["claude-opus-4-8"]);

    // The harness is already answering under the first model, so a second one
    // named mid-turn folds into the turn already running rather than asking
    // the harness for anything.
    const second = await Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "and this",
        modelSelection: { model: "claude-haiku-4-5", options: {} },
      }),
    );

    expect(run.models).toEqual(["claude-opus-4-8"]);
    expect(second).toEqual({ turnId: first.turnId, delivery: "steered" });
  });

  it("fails the input when setModel rejects, naming the model, and never pushes it", async () => {
    const run = driving();
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

    expect(said).toContain("claude-opus-4-8");
    expect(run.sent).toEqual([]);
    // Delivering it under the old model would answer for a turn nobody asked
    // for, and the caller would never hear that the model did not take.
    expect(tags(run.seen)).toEqual(["session.started"]);

    // The refusal left nothing applied, so the very next input asks again
    // rather than treating the rejected model as though it had taken.
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
});

/**
 * The park. `options.canUseTool` is the seam the harness asks through, so a
 * test reaches it the way the CLI does: it calls the callback the adapter
 * supplied and watches what the session's stream says about it.
 */
const TOOL_USE = "toolu_0199e0e70000700080000000000001";

/** What the CLI offers to persist for an "always allow", in its own shape. */
const SUGGESTIONS: ReadonlyArray<PermissionUpdate> = [
  {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
    behavior: "allow",
    destination: "session",
  },
];

/** One tool call the harness is asking about, and what came of the ask. */
interface Park {
  /** What the callback resolved to, or `undefined` while the session is parked. */
  readonly settled: () => PermissionResult | null | undefined;
  /** The CLI withdrawing the question, which it does by aborting the signal. */
  readonly abort: () => void;
}

const parks = (
  run: Driving,
  toolName: string,
  input: Record<string, unknown>,
  extra: {
    readonly suggestions?: ReadonlyArray<PermissionUpdate>;
    readonly toolUseID?: string;
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
    ...(extra.suggestions === undefined ? {} : { suggestions: [...extra.suggestions] }),
  }).then((answer) => {
    settled = answer;
  });
  return { settled: () => settled, abort: () => aborting.abort() };
};

/** The adapter's own answer channel for a park, named through one helper. */
const respond = (run: Driving, requestId: string, decision: ApprovalDecision): Promise<void> =>
  Effect.runPromise(run.adapter.respondToRequest(SESSION, requestId, decision));

const requestsIn = (seen: ReadonlyArray<ProviderEvent>): ReadonlyArray<OpenRequest> =>
  seen.flatMap((event) => (event._tag === "request.opened" ? [event.request] : []));

const resolutionsIn = (
  seen: ReadonlyArray<ProviderEvent>,
): ReadonlyArray<{ readonly requestId: string; readonly decision: ApprovalDecision }> =>
  seen.flatMap((event) =>
    event._tag === "request.resolved"
      ? [{ requestId: event.requestId, decision: event.decision }]
      : [],
  );

/** What an allow persisted; nothing at all is what a non-allow persisted. */
const persistedBy = (settled: PermissionResult | null | undefined): ReadonlyArray<unknown> =>
  settled !== null && settled !== undefined && settled.behavior === "allow"
    ? (settled.updatedPermissions ?? [])
    : [];

/**
 * How a deny was worded and whether it ended the turn. A non-deny reads as an
 * empty message that did end the turn, so either assertion fails on one.
 */
const denialOf = (
  settled: PermissionResult | null | undefined,
): { readonly message: string; readonly interrupt: boolean } =>
  settled !== null && settled !== undefined && settled.behavior === "deny"
    ? { message: settled.message, interrupt: settled.interrupt ?? false }
    : { message: "", interrupt: true };

/** A session in `approval-required` with a turn open, ready to be asked. */
const asking = async (): Promise<Driving> => {
  const run = driving();
  await Effect.runPromise(
    run.adapter.startSession(SESSION, { ...SPEC, accessMode: "approval-required" }, WORKING),
  );
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "list the files" }));
  return run;
};

/** Parks on one tool call and answers with the request the stream carried. */
const parked = async (
  run: Driving,
  toolName: string,
  input: Record<string, unknown>,
  extra: Parameters<typeof parks>[3] = {},
): Promise<{ readonly park: Park; readonly request: OpenRequest }> => {
  const before = requestsIn(run.seen).length;
  const park = parks(run, toolName, input, extra);
  await until("opened the request", () => requestsIn(run.seen).length === before + 1);
  return { park, request: requestsIn(run.seen)[before]! };
};

describe("a tool call the harness has to ask about", () => {
  it("parks the call and says what is being asked, against the item it is about", async () => {
    const run = await asking();

    const { park, request } = await parked(
      run,
      "Bash",
      { command: "ls -la" },
      { suggestions: SUGGESTIONS },
    );

    // Parked: nothing has been decided, so the harness is still waiting.
    expect(park.settled()).toBeUndefined();
    expect(request.kind).toBe("command_approval");
    expect(request.decisions).toEqual(["allow", "allow_always", "deny", "cancel"]);
    expect(request.detail).toEqual({ command: "ls -la" });
    // The tool-use id, so a surface can overlay the item the ask is about.
    expect(request.itemId).toBe(TOOL_USE);
    expect(request.requestId).not.toBe("");
    expect(resolutionsIn(run.seen)).toEqual([]);
  });

  it("leaves allow always off a question no rule may be persisted for", async () => {
    const run = await asking();

    // The harness hands over no rules to persist for an ask it will not let a
    // host make permanent, and a button that had to invent one would grant
    // more than the user clicked.
    const { request } = await parked(run, "Bash", { command: "ls -la" });

    expect(request.decisions).toEqual(["allow", "deny", "cancel"]);
  });

  it("lets the call run on an allow, and says the park is over", async () => {
    const run = await asking();
    const { park, request } = await parked(run, "Bash", { command: "ls -la" });

    await respond(run, request.requestId, "allow");

    await until("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "allow" });
    expect(resolutionsIn(run.seen)).toEqual([{ requestId: request.requestId, decision: "allow" }]);
  });

  it("persists an allow-always rule against the session, never the user's settings files", async () => {
    const run = await asking();
    const { park, request } = await parked(
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

    await until("resolved the park", () => park.settled() !== undefined);
    expect(persistedBy(park.settled())).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });

  it("persists the harness's own rule on an allow always", async () => {
    const run = await asking();
    const { park, request } = await parked(
      run,
      "Bash",
      { command: "ls -la" },
      {
        suggestions: SUGGESTIONS,
      },
    );

    await respond(run, request.requestId, "allow_always");

    await until("resolved the park", () => park.settled() !== undefined);
    const settled = park.settled();
    expect(settled).toMatchObject({ behavior: "allow", decisionClassification: "user_permanent" });
    // Something to persist, so the same command is not asked about again.
    expect(persistedBy(settled).length).toBeGreaterThan(0);
    expect(resolutionsIn(run.seen)).toEqual([
      { requestId: request.requestId, decision: "allow_always" },
    ]);
  });

  it("blocks the call on a deny, with a message and the turn left running", async () => {
    const run = await asking();
    const { park, request } = await parked(run, "Bash", { command: "rm -rf /" });

    await respond(run, request.requestId, "deny");

    await until("resolved the park", () => park.settled() !== undefined);
    const settled = park.settled();
    expect(settled).toMatchObject({ behavior: "deny" });
    // Required by the vendor, and it is what the harness tells the model.
    expect(denialOf(settled).message).not.toBe("");
    expect(denialOf(settled).interrupt).toBe(false);
    expect(resolutionsIn(run.seen)).toEqual([{ requestId: request.requestId, decision: "deny" }]);
  });

  it("blocks the call and ends the turn on a cancel", async () => {
    const run = await asking();
    const { park, request } = await parked(run, "Bash", { command: "rm -rf /" });

    await respond(run, request.requestId, "cancel");

    await until("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny", interrupt: true });
    expect(resolutionsIn(run.seen)).toEqual([{ requestId: request.requestId, decision: "cancel" }]);
  });

  /**
   * Spec 06 section 8.2: the CLI withdraws a pending prompt after the turn was
   * interrupted, and it does so by aborting the signal it handed the callback.
   */
  it("answers a withdrawn ask as a deny, and reports the park cancelled", async () => {
    const run = await asking();
    const { park, request } = await parked(run, "Bash", { command: "ls -la" });

    park.abort();

    await until("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(resolutionsIn(run.seen)).toEqual([{ requestId: request.requestId, decision: "cancel" }]);
  });

  it("does nothing at all for a request it is not holding, or holds no longer", async () => {
    const run = await asking();
    const { request } = await parked(run, "Bash", { command: "ls -la" });

    await respond(run, "r-nobody-asked", "allow");
    expect(resolutionsIn(run.seen)).toEqual([]);

    await respond(run, request.requestId, "deny");
    await until("resolved the park", () => resolutionsIn(run.seen).length === 1);
    // Answered twice: the second answer has nothing left to resolve, and must
    // not report a second outcome for a park that is already over.
    await respond(run, request.requestId, "allow");
    expect(resolutionsIn(run.seen)).toEqual([{ requestId: request.requestId, decision: "deny" }]);
  });

  it("refuses an answer the request never offered", async () => {
    const run = await asking();
    const { park, request } = await parked(run, "AskUserQuestion", {
      questions: [{ question: "Which one?", header: "One", options: [], multiSelect: false }],
    });

    // There is no answer for an allow to carry, so an allow must not reach the
    // harness however it got this far.
    await respond(run, request.requestId, "allow");

    expect(park.settled()).toBeUndefined();
    expect(resolutionsIn(run.seen)).toEqual([]);
  });

  it("holds one question at a time, and tells the harness to ask the rest again", async () => {
    const run = await asking();
    const { park: first } = await parked(run, "Bash", { command: "ls -la" });

    const second = parks(run, "Read", { file_path: "/work/one.ts" }, { toolUseID: "toolu_two" });

    await until("answered the second ask", () => second.settled() !== undefined);
    expect(second.settled()).toMatchObject({ behavior: "deny" });
    // The card the user is looking at stays the one that is open.
    expect(first.settled()).toBeUndefined();
    expect(requestsIn(run.seen)).toHaveLength(1);
  });

  it("cuts a command to what the protocol carries, and says where it cut", async () => {
    const run = await asking();

    const { request } = await parked(run, "Bash", { command: `echo ${"x".repeat(9_000)}` });

    const command = request.kind === "command_approval" ? request.detail.command : "";
    expect(command).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(command.endsWith("\u2026")).toBe(true);
  });

  it("opens the turn the park belongs to where the harness asked before one was open", async () => {
    const run = driving();
    await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, accessMode: "approval-required" }, WORKING),
    );

    const { request } = await parked(run, "Bash", { command: "ls -la" });

    // The SDK can call back before the assistant message that opened the turn
    // has been read off its stream, so the park opens the turn it belongs to
    // rather than reporting a request no turn is waiting on.
    expect(tags(run.seen)).toEqual(["session.started", "turn.started", "request.opened"]);
    expect(request.itemId).toBe(TOOL_USE);
  });

  it("names an item of its own where the harness named no tool-use id", async () => {
    const run = await asking();

    const { request } = await parked(run, "Bash", { command: "ls -la" }, { toolUseID: "" });

    // An empty id is a frame the protocol refuses, and the event would be lost
    // with the park still held.
    expect(request.itemId).not.toBe("");
  });
});

describe("what kind of question each tool is", () => {
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
    ["WebFetch", { url: "https://example.com" }, "tool_approval", []],
  ];

  for (const [toolName, input, kind, paths] of KINDS) {
    it(`asks about ${toolName} as a ${kind}`, async () => {
      const run = await asking();

      const { request } = await parked(run, toolName, input);

      expect(request.kind).toBe(kind);
      if (request.kind === "tool_approval") expect(request.detail.toolName).toBe(toolName);
      if (request.kind === "file_change_approval" || request.kind === "file_read_approval") {
        expect(request.detail.paths).toEqual(paths);
      }
    });
  }

  /**
   * Answering carries a decision and nothing else, so there
   * is no answer an allow could run the tool with.
   */
  it("records an AskUserQuestion as a question it cannot answer, offering deny and cancel", async () => {
    const run = await asking();

    const { request } = await parked(run, "AskUserQuestion", {
      questions: [
        {
          question: "Which database should this use?",
          header: "Database",
          options: [
            { label: "SQLite", description: "the one Hydra ships" },
            { label: "Postgres", description: "somebody else's server" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(request.kind).toBe("question");
    expect(request.decisions).toEqual(["deny", "cancel"]);
    // Structured, not flattened to text: the card shows the chip, the prose and
    // what each answer would have meant.
    expect(request.kind === "question" ? request.detail.questions : []).toEqual([
      {
        question: "Which database should this use?",
        header: "Database",
        options: [
          { label: "SQLite", description: "the one Hydra ships" },
          { label: "Postgres", description: "somebody else's server" },
        ],
        multiSelect: false,
      },
    ]);
  });

  it("asks all the questions an ask carries, dropping a malformed one and its unlabelled options", async () => {
    const run = await asking();

    const { request } = await parked(run, "AskUserQuestion", {
      questions: [
        // No header: the SDK's own schema requires one, and a chip cannot be
        // invented, so this question is dropped rather than guessed at.
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
        // The vendor's `preview` has no field in the protocol, so it is gone.
        options: [{ label: "Rules", description: "persisted rules" }],
        multiSelect: true,
      },
    ]);
  });

  /**
   * A `question` request with no question on it is an undecodable frame, which
   * costs the runner its socket; a tool call the user can refuse is the honest
   * card.
   */
  it("falls back to a tool approval when no question survives the mapping", async () => {
    const run = await asking();

    const { request } = await parked(run, "AskUserQuestion", { questions: "nonsense" });

    expect(request.kind).toBe("tool_approval");
    expect(request.kind === "tool_approval" ? request.detail.toolName : "").toBe("AskUserQuestion");
    expect(request.decisions).toEqual(["deny", "cancel"]);
  });

  /**
   * The plan is an item of its own - the one the harness's own tool call
   * opened - and the ask is against it, so the surface overlays the plan the
   * user is being asked to approve rather than a second copy of it.
   */
  it("asks about the plan item the tool call already opened", async () => {
    const run = await asking();
    const plan = { plan: "1. read it\n2. write it" };
    run.say({
      type: "assistant",
      message: {
        id: "msg-plan",
        content: [{ type: "tool_use", id: TOOL_USE, name: "ExitPlanMode", input: plan }],
      },
    });
    await until("published the plan", () => itemsOf(run.seen, "plan").length > 0);

    const { request } = await parked(run, "ExitPlanMode", plan);

    // Exactly one: a second plan item would leave one of them never closed,
    // since only the harness's own `tool_result` closes the one it opened.
    expect(itemsOf(run.seen, "plan")).toHaveLength(1);
    const started = itemsOf(run.seen, "plan")[0]!;
    expect(JSON.stringify(started.detail)).toContain("read it");
    expect(request.kind).toBe("tool_approval");
    expect(request.itemId).toBe(started.itemId);
  });
});

describe("a park that is still open when the turn or the session ends", () => {
  it("is cancelled first, and the cancellation is reported before the turn closes", async () => {
    const run = await asking();
    const { park, request } = await parked(run, "Bash", { command: "ls -la" });

    await Effect.runPromise(run.adapter.interrupt(SESSION));
    // The CLI's own answer to an interrupt: the turn ends as aborted.
    run.say({ ...RESULT, terminal_reason: "aborted_by_user" });
    await until("closed the turn", () => run.seen.some((event) => event._tag === "turn.completed"));

    expect(run.interrupted()).toBe(1);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(resolutionsIn(run.seen)).toEqual([{ requestId: request.requestId, decision: "cancel" }]);
    // In that order: a turn reported as over while a request still reads as
    // open leaves a card on screen for a turn that has ended.
    const closing = tags(run.seen).filter(
      (tag) => tag === "request.resolved" || tag === "turn.completed",
    );
    expect(closing).toEqual(["request.resolved", "turn.completed"]);
    const completed = run.seen.find((event) => event._tag === "turn.completed");
    expect(completed?._tag === "turn.completed" ? completed.state : undefined).toBe("interrupted");
  });

  it("says nothing about a park where there was none to cancel", async () => {
    const run = await asking();

    await Effect.runPromise(run.adapter.interrupt(SESSION));

    expect(run.interrupted()).toBe(1);
    expect(resolutionsIn(run.seen)).toEqual([]);
    expect(requestsIn(run.seen)).toEqual([]);
  });

  it("is withdrawn when the session is stopped, and the exit still says why it stopped", async () => {
    const run = await asking();
    const { park, request } = await parked(run, "Bash", { command: "ls -la" });

    await Effect.runPromise(run.adapter.stopSession(SESSION, "inactivity_timeout"));
    await ends(run.seen);

    // A park left hanging is a promise the harness waits on for ever.
    await until("resolved the park", () => park.settled() !== undefined);
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    // A stop ends the turn, so the stream reads the same as an interrupt's.
    expect(resolutionsIn(run.seen)).toEqual([{ requestId: request.requestId, decision: "cancel" }]);
    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe(
      "inactivity_timeout",
    );
  });

  it("is withdrawn once when the harness stops talking on its own, before the exit", async () => {
    const run = await asking();
    const { park, request } = await parked(run, "Bash", { command: "ls -la" });

    // Nobody asked: the harness simply reached the end of its stream with the
    // question still open.
    run.end();
    await ends(run.seen);

    await until("resolved the park", () => park.settled() !== undefined);
    // The harness gets a plain deny - there is no turn left to interrupt - and
    // the stream says the question was cancelled rather than refused.
    expect(park.settled()).toMatchObject({ behavior: "deny" });
    expect(denialOf(park.settled()).interrupt).toBe(false);
    expect(resolutionsIn(run.seen)).toEqual([{ requestId: request.requestId, decision: "cancel" }]);
    // Every exit passes through one place, so the park is ended once, and
    // before the exit: a request still reading as open on a session that is
    // gone leaves a card nothing can answer.
    const closing = tags(run.seen).filter(
      (tag) => tag === "request.resolved" || tag === "session.exited",
    );
    expect(closing).toEqual(["request.resolved", "session.exited"]);
  });
});

/**
 * What an Agent puts on a session: instructions of its own, tool families taken
 * away, and a schema every turn has to answer under (spec 06 section 7).
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

/** The `turn.completed` a scripted result closed its turn with. */
const turnCompletedOf = async (
  spec: SessionSpec,
  result: unknown,
): Promise<Extract<ProviderEvent, { _tag: "turn.completed" }>> => {
  const run = driving();
  await Effect.runPromise(run.adapter.startSession(SESSION, spec, WORKING));
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
  run.say(result);
  await until("closed the turn", () => run.seen.some((event) => event._tag === "turn.completed"));
  const completed = run.seen.find(
    (event): event is Extract<ProviderEvent, { _tag: "turn.completed" }> =>
      event._tag === "turn.completed",
  );
  expect(completed, "no turn was completed").toBeDefined();
  return completed!;
};

describe("a session the controller spawned from an Agent", () => {
  it("appends the agent's instructions to the harness's own preset, never replacing it", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, WORKING));

    expect(run.options[0]?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: SYSTEM_PROMPT,
    });
  });

  it("names every Claude tool in each family the spec took away", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, WORKING));

    expect(run.options[0]?.disallowedTools).toEqual(["Edit", "NotebookEdit", "Bash", "WebFetch"]);
  });

  it("hands the schema to the SDK as the one output format the session runs under", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, WORKING));

    expect(run.options[0]?.outputFormat).toEqual({
      type: "json_schema",
      schema: OUTPUT_SCHEMA,
    });
  });

  it("carries none of the three keys for a Thread, which has none of the three fields", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    // Absent, not empty: an empty `disallowedTools` or a bare preset would be
    // this adapter saying something the spec never said.
    expect(run.options[0], "the session was never started").toBeDefined();
    const keys = Object.keys(run.options[0]!);
    expect(keys).not.toContain("systemPrompt");
    expect(keys).not.toContain("disallowedTools");
    expect(keys).not.toContain("outputFormat");
  });
});

describe("what a turn under an output schema answers with", () => {
  it("reports the harness's structured output as the turn's result when it satisfies the schema", async () => {
    const completed = await turnCompletedOf(STRUCTURED, {
      ...RESULT,
      structured_output: ANSWER,
    });

    expect(completed.state).toBe("completed");
    expect(completed.structuredResult).toEqual({ outcome: "ok", value: ANSWER });
  });

  it("reports a schema failure naming the field when the harness's output violates the schema", async () => {
    const completed = await turnCompletedOf(STRUCTURED, {
      ...RESULT,
      structured_output: { verdict: "maybe", confidence: 0.9 },
    });

    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("verdict") as string,
    });
  });

  it("reports a schema failure naming the subtype when the harness ran out of retries", async () => {
    const completed = await turnCompletedOf(STRUCTURED, {
      ...RESULT,
      subtype: "error_max_structured_output_retries",
      is_error: true,
      errors: [],
    });

    // The turn's own state stays whatever the harness reported; the result is
    // the separate answer about the schema.
    expect(completed.state).toBe("failed");
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("error_max_structured_output_retries") as string,
    });
  });

  it("reports a schema failure when a successful turn carried no structured output at all", async () => {
    const completed = await turnCompletedOf(STRUCTURED, RESULT);

    expect(completed.state).toBe("completed");
    // The wording is the adapter's; that there is one is the criterion: a turn
    // that answered nothing has to say so rather than answer an empty `ok`.
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringMatching(/\S/) as string,
    });
  });

  it("says nothing about the schema when the turn failed for a reason of its own", async () => {
    const completed = await turnCompletedOf(STRUCTURED, {
      ...RESULT,
      is_error: true,
      errors: ["the API refused the request"],
    });

    // The failure is about the turn, not about the schema: a `schema-failure`
    // here would read as an answer that was judged and found wanting.
    expect(completed.state).toBe("failed");
    expect("structuredResult" in completed).toBe(false);
  });

  it("says nothing about the schema on a turn the user interrupted", async () => {
    const completed = await turnCompletedOf(STRUCTURED, {
      ...RESULT,
      terminal_reason: "aborted_tools",
    });

    expect(completed.state).toBe("interrupted");
    expect("structuredResult" in completed).toBe(false);
  });

  it("says nothing about the schema when the retries ran out on a turn that was interrupted", async () => {
    const completed = await turnCompletedOf(STRUCTURED, {
      ...RESULT,
      subtype: "error_max_structured_output_retries",
      is_error: true,
      errors: [],
      terminal_reason: "aborted_tools",
    });

    expect(completed.state).toBe("interrupted");
    expect("structuredResult" in completed).toBe(false);
  });

  it("says nothing about a result on a session that was never given a schema", async () => {
    const completed = await turnCompletedOf(SPEC, { ...RESULT, structured_output: ANSWER });

    // Absent rather than an `ok` over no schema: a Thread answers prose, and a
    // key on every turn of every session would be a second meaning for "ok".
    expect("structuredResult" in completed).toBe(false);
  });
});

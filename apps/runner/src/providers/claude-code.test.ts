/**
 * The Claude Code adapter's probe, with the vendor SDK stubbed. The fixtures
 * are shapes captured from the real CLI at 2.1.263, not shapes invented here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_VERSION } from "@hydra/home/version";
import type { ProbeResult, ProviderEvent, SessionSpec } from "@hydra/protocol";
import { PROBE_DEADLINE, claudeCodeAdapter, type ClaudeSeam } from "./claude-code";
import type { ProviderAdapter, ProviderRunnerContext } from "./index";

const CONTEXT: ProviderRunnerContext = {
  cwd: null,
  home: "/var/hydra/runner/providers/0199e0e7-0000-7000-8000-00000000000a",
  binary: "/usr/local/bin/claude",
  env: { PATH: "/usr/local/bin:/usr/bin" },
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
};

const WORKING: ProviderRunnerContext = { ...CONTEXT, cwd: "/var/hydra/runner/scratch/one" };

/** The harness end of a session, driven by the test one message at a time. */
const driving = (): {
  readonly adapter: ProviderAdapter;
  readonly options: Array<Options>;
  readonly sent: Array<SDKUserMessage>;
  readonly seen: Array<ProviderEvent>;
  readonly say: (message: unknown) => void;
  readonly end: () => void;
  readonly die: (reason: Error) => void;
  readonly closed: () => number;
} => {
  const options: Array<Options> = [];
  const sent: Array<SDKUserMessage> = [];
  const seen: Array<ProviderEvent> = [];
  const queued: Array<unknown> = [];
  const waiting: Array<(result: IteratorResult<unknown>) => void> = [];
  const failing: Array<(reason: Error) => void> = [];
  const done: IteratorResult<unknown> = { done: true, value: undefined };
  let ended = false;
  let closes = 0;

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

  return {
    adapter,
    options,
    sent,
    seen,
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
  };
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

/** Lets the pump's promises run; the adapter reads the harness off the loop. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const tags = (seen: ReadonlyArray<ProviderEvent>): ReadonlyArray<string> =>
  seen.map((event) => event._tag);

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
    await settled();
    expect(tags(run.seen)).toEqual(["session.started"]);
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
    });
  }

  it("opens a turn on an idle session and steers a busy one", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const opened = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    expect(opened.delivery).toBe("opened");

    const steered = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "and this" }));
    expect(steered.delivery).toBe("steered");
    expect(steered.turnId).toBe(opened.turnId);

    await settled();
    expect(run.sent.map((message) => message.message.content)).toEqual(["hello", "and this"]);
    // One turn, opened once: steering folds into the turn that is running.
    expect(tags(run.seen)).toEqual(["session.started", "turn.started"]);
  });

  it("opens a second turn once the result closed the first", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    const first = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));
    run.say(RESULT);
    await settled();

    const second = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "again" }));
    expect(second.delivery).toBe("opened");
    expect(second.turnId).not.toBe(first.turnId);
    expect(tags(run.seen)).toEqual([
      "session.started",
      "turn.started",
      "session.usage.updated",
      "turn.completed",
      "turn.started",
    ]);
  });

  it("exits as stopped when it was asked to, and forgets the session", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.stopSession(SESSION));
    await settled();

    expect(run.closed()).toBe(1);
    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("stopped");
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });

  it("exits as a process exit when the harness stops on its own", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    run.end();
    await settled();

    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("process_exit");
  });

  it("says the harness crashed, and why, when its stream throws", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    run.die(new Error("the harness went away"));
    await settled();

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

    await Effect.runPromise(run.adapter.stopSession(SESSION));
    run.die(new Error("Query closed before response received"));
    await settled();

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

    await Effect.runPromise(run.adapter.stopSession(SESSION));
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

/**
 * The Claude Code adapter's probe, with the vendor SDK stubbed. The fixtures
 * are shapes captured from the real CLI at 2.1.263, not shapes invented here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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
    await Effect.runPromise(run.adapter.stopSession(SESSION));
    run.releaseModel();

    // The session the input was checked against is gone; saying it was
    // delivered would be a message the user believes was sent and was not.
    expect(await sending).toBe(`session ${SESSION} is not running here`);
    expect(run.sent).toEqual([]);
  });

  it("exits as stopped when it was asked to, and forgets the session", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, WORKING));

    await Effect.runPromise(run.adapter.stopSession(SESSION));
    await ends(run.seen);

    expect(run.closed()).toBe(1);
    const exited = run.seen.at(-1);
    expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("stopped");
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
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

    await Effect.runPromise(run.adapter.stopSession(SESSION));
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

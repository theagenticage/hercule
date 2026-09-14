/**
 * The Codex adapter's probe, its install and the isolation it spawns an
 * app-server under, over a scripted app-server: nothing vendor-supplied runs.
 * The frames the script answers with are the shapes captured from codex 0.154.0
 * in `docs/plans/P013-codex-adapter/samples/`, not shapes invented here.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { CODEX_VERSION } from "@hydra/home/version";
import type { ProbeResult, ProviderEvent, SessionSpec } from "@hydra/protocol";
import { INSTALL_DEADLINE } from "../claude-code";
import type { ProviderRunnerContext } from "../index";
import { codexAdapter, PROBE_DEADLINE, type CodexSeam } from "./adapter";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));

const homes: Array<string> = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const homing = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hydra-codex-"));
  homes.push(home);
  return home;
};

const contextIn = (home: string, cwd: string | null = null): ProviderRunnerContext => ({
  cwd,
  home,
  binary: "/usr/local/bin/codex",
  env: { PATH: "/usr/local/bin:/usr/bin", HYDRA_RUNNER: "runner-1" },
});

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const THREAD = "0199e0e7-0000-7000-8000-0000000000fe";

const SPEC: SessionSpec = {
  instanceId: "0199e0e7-0000-7000-8000-00000000000a",
  workspaceId: null,
  modelSelection: { model: "gpt-5.5", options: {} },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

/** `samples/probe-initialize.json`. The version lives inside the user agent. */
const INITIALIZE = {
  userAgent: "hydra/0.154.0 (Mac OS 15.7.8; arm64) unknown (hydra; 0.0.0)",
  codexHome: "/private/tmp/ch.XXXX",
  platformFamily: "unix",
  platformOs: "macos",
};

/** Arrives unsolicited right after `initialize`, and is nothing the probe asked for. */
const UNSOLICITED = {
  method: "remoteControl/status/changed",
  params: {
    status: "disabled",
    serverName: "host.local",
    installationId: "u-1",
    environmentId: null,
  },
  emittedAtMs: 1789373122124,
};

/** `samples/probe-account-read.json`: the observed row, then the two type-derived ones. */
const LOGGED_OUT = { account: null, requiresOpenaiAuth: true };
const CHATGPT = {
  account: { type: "chatgpt", email: "rogier@example.com", planType: "pro" },
  requiresOpenaiAuth: false,
};
const API_KEY = { account: { type: "apiKey" }, requiresOpenaiAuth: false };

/** `samples/probe-model-list.json`: one model per option shape. */
const MODELS = {
  data: [
    {
      id: "gpt-6-astra",
      model: "gpt-6-astra",
      displayName: "GPT-6-Astra",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "..." },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
      ],
      defaultReasoningEffort: "low",
      inputModalities: ["text", "image"],
      supportsPersonality: false,
      serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed" }],
      defaultServiceTier: null,
      isDefault: true,
    },
    {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      defaultReasoningEffort: "low",
      serviceTiers: [
        { id: "priority", name: "Fast" },
        { id: "ultrafast", name: "Ultrafast" },
      ],
      isDefault: false,
    },
    {
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      supportsPersonality: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
        { reasoningEffort: "xhigh" },
      ],
      isDefault: false,
    },
  ],
  nextCursor: null,
};

/** A stream of lines a test pushes into, read once by the code under test. */
const lines = (): {
  readonly push: (line: string) => void;
  readonly end: () => void;
  readonly iterable: AsyncIterable<string>;
} => {
  const queued: Array<string> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const woken = (): void => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  return {
    push: (line) => {
      queued.push(line);
      woken();
    },
    end: () => {
      ended = true;
      woken();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queued.length > 0) yield queued.shift()!;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
};

/** One app-server the adapter asked for, and what it was asked with. */
interface Spawn {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly kills: () => number;
  /** A frame the server sends unasked: a notification, or a request of its own. */
  readonly push: (frame: unknown) => void;
  /** The app-server stopping by itself, which is not the adapter ending it. */
  readonly crash: () => void;
}

/** One request the adapter wrote, in the order it wrote them. */
interface Sent {
  readonly method: string;
  readonly params: unknown;
}

/**
 * An answer per method: a value to reply with, or `SILENT` for a method the
 * server never answers, which is what codex 0.154.0 does with one it does not
 * know.
 */
const SILENT = Symbol("no reply");

type Answers = Readonly<Record<string, ((params: unknown) => unknown) | typeof SILENT>>;

/**
 * An answer that refuses the request, the way codex answers a bad one:
 * `-32600` is the code observed at 0.154.0 (`samples/errors.json`).
 */
const refusal = (
  message: string,
  code = -32600,
): { readonly error: { code: number; message: string } } => ({ error: { code, message } });

const RESUMED = THREAD;
const FORKED = "0199e0e7-0000-7000-8000-0000000000fc";
const TURN = "0199e0e7-0000-7000-8000-0000000000fb";

const DEFAULT_ANSWERS: Answers = {
  initialize: () => INITIALIZE,
  "account/read": () => LOGGED_OUT,
  "model/list": () => MODELS,
  "thread/start": () => ({ thread: { id: THREAD } }),
  "thread/resume": () => ({ thread: { id: RESUMED } }),
  "thread/fork": () => ({ thread: { id: FORKED } }),
  "turn/start": () => ({ turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" } }),
  "turn/steer": () => ({ turnId: TURN }),
  "turn/interrupt": () => ({}),
  "thread/close": () => ({}),
};

/**
 * A seam whose app-server replies line by line, recording the argv and the env
 * it was spawned with and every request it was sent. `dies` is a server that
 * exits instead of answering.
 */
const scripted = (
  answers: Answers = {},
  options: { readonly dies?: boolean } = {},
): {
  readonly seam: CodexSeam;
  readonly spawns: Array<Spawn>;
  readonly requests: Array<Sent>;
} => {
  const spawns: Array<Spawn> = [];
  const requests: Array<Sent> = [];
  const replies: Answers = { ...DEFAULT_ANSWERS, ...answers };
  const seam: CodexSeam = {
    appServer: (command, env) => {
      const out = lines();
      const err = lines();
      let kills = 0;
      let exited: (code: number) => void = () => undefined;
      const done = new Promise<number>((resolve) => {
        exited = resolve;
      });
      if (options.dies === true) {
        err.push("codex: app-server failed to start");
        out.end();
        err.end();
        exited(1);
      }
      const handle = (line: string): void => {
        const frame = JSON.parse(line) as Record<string, unknown>;
        const method = frame["method"];
        if (typeof method !== "string" || frame["id"] === undefined) return;
        requests.push({ method, params: frame["params"] });
        const reply = replies[method];
        if (reply === undefined || reply === SILENT) return;
        const answered = reply(frame["params"]) as { readonly error?: unknown };
        out.push(
          JSON.stringify(
            answered !== null && typeof answered === "object" && "error" in answered
              ? { id: frame["id"], error: answered.error }
              : { id: frame["id"], result: answered },
          ),
        );
        if (method === "initialize") out.push(JSON.stringify(UNSOLICITED));
      };
      spawns.push({
        command,
        env,
        kills: () => kills,
        push: (frame) => out.push(JSON.stringify(frame)),
        crash: () => {
          out.end();
          err.end();
          exited(1);
        },
      });
      return {
        write: (text: string) => {
          for (const line of text.split("\n")) if (line.trim() !== "") handle(line);
        },
        stdout: out.iterable,
        stderr: err.iterable,
        kill: () => {
          kills += 1;
          out.end();
          err.end();
          exited(143);
        },
        exited: done,
      };
    },
    run: () => Effect.die("probing must not run a command"),
  };
  return { seam, spawns, requests };
};

const probing = (
  answers: Answers = {},
  options: { readonly dies?: boolean } = {},
): {
  readonly result: Promise<ProbeResult>;
  readonly spawns: Array<Spawn>;
  readonly home: string;
} => {
  const home = homing();
  const { seam, spawns } = scripted(answers, options);
  return { result: Effect.runPromise(codexAdapter(seam).probe(contextIn(home), {})), spawns, home };
};

const optionOf = (
  models: ProbeResult["models"],
  slug: string,
  id: string,
): Record<string, unknown> | undefined =>
  models.find((model) => model.slug === slug)?.options.find((option) => option.id === id);

const valuesOf = (option: Record<string, unknown> | undefined): ReadonlyArray<string> =>
  ((option?.["choices"] ?? []) as ReadonlyArray<{ readonly value: string }>).map(
    (choice) => choice.value,
  );

const WAIT_MS = 2_000;

/** Waits for something the adapter has done, or gives up and says what it was. */
const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + WAIT_MS;
  while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(ready(), `the adapter never ${what}`).toBe(true);
};

describe("what the Codex adapter reports about a machine", () => {
  it("takes the harness version out of the user agent, because initialize carries none", async () => {
    const { result } = probing();

    const probed = await result;
    expect(probed.harnessVersion).toBe("0.154.0");
  });

  it("says nothing about a user agent it cannot read a version out of", async () => {
    const { result } = probing({ initialize: () => ({ ...INITIALIZE, userAgent: "codex" }) });

    const probed = await result;
    // Null rather than a guess: `versionVerdict` reads that as "unknown".
    expect(probed.harnessVersion).toBeNull();
    expect(probed.auth.status).toBe("unauthenticated");
  });

  it("reports a logged-out machine as unauthenticated, naming nobody", async () => {
    const { result } = probing();

    const probed = await result;
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.auth.message).toBeUndefined();
    // The catalogue is still a fact about the machine: `model/list` answers
    // while logged out.
    expect(probed.models).not.toEqual([]);
  });

  it("names the ChatGPT account, its plan and its backend", async () => {
    const { result } = probing({ "account/read": () => CHATGPT });

    const probed = await result;
    expect(probed.auth).toMatchObject({
      status: "ok",
      identity: "rogier@example.com",
      planLabel: "pro",
      backend: "chatgpt",
    });
  });

  it("reports an API key as logged in with no identity to name", async () => {
    const { result } = probing({ "account/read": () => API_KEY });

    const probed = await result;
    expect(probed.auth.status).toBe("ok");
    expect(probed.auth.backend).toBe("apiKey");
    expect(probed.auth.identity).toBeUndefined();
  });

  it("maps each model to its slug, its name, and only the options it supports", async () => {
    const { result } = probing();

    const probed = await result;
    expect(probed.models.map((model) => model.slug)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
    expect(probed.models[0]).toMatchObject({ slug: "gpt-6-astra", name: "GPT-6-Astra" });
    expect(probed.models[0]?.isDefault).toBe(true);
    expect(probed.models[1]?.isDefault ?? false).toBe(false);

    const effort = optionOf(probed.models, "gpt-6-astra", "reasoningEffort");
    expect(effort).toMatchObject({ kind: "select", default: "low" });
    expect(valuesOf(effort)).toEqual(["low", "medium", "high"]);
    expect(valuesOf(optionOf(probed.models, "gpt-5.5", "reasoningEffort"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // A model the server lists no efforts for offers no effort choice.
    expect(optionOf(probed.models, "gpt-5.6-sol", "reasoningEffort")).toBeUndefined();

    expect(optionOf(probed.models, "gpt-6-astra", "serviceTier")).toMatchObject({ kind: "select" });
    expect(valuesOf(optionOf(probed.models, "gpt-5.6-sol", "serviceTier"))).toEqual([
      "priority",
      "ultrafast",
    ]);
    // Offered only where the server named tiers: an empty select is a dead control.
    expect(optionOf(probed.models, "gpt-5.5", "serviceTier")).toBeUndefined();
  });

  it("reports an app-server that never answers initialize as an error, not as a blank row", async () => {
    const { result } = probing({ initialize: SILENT }, { dies: true });

    const probed = await result;
    expect(probed.harnessVersion).toBeNull();
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").not.toBe("");
    expect(probed.models).toEqual([]);
  });

  it("gives up on an app-server that answers nothing, and names the deadline", async () => {
    const home = homing();
    // A live child that simply never answers, which is what the deadline is
    // there for: a dead one is already reported by its stream ending.
    const { seam, spawns } = scripted({ initialize: SILENT });

    const probed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(codexAdapter(seam).probe(contextIn(home), {}));
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(PROBE_DEADLINE);
          return yield* Fiber.join(running);
        }),
        TestClock.layer(),
      ),
    );

    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").toContain(Duration.format(PROBE_DEADLINE));
    expect(probed.models).toEqual([]);
    // The child is the probe's own, so giving up on it means ending it.
    expect(spawns[0]?.kills()).toBe(1);
  });
});

describe("the process a probe runs on", () => {
  it("kills its own app-server, so a probe leaves nothing hosting", async () => {
    const { result, spawns } = probing();
    await result;

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.kills()).toBe(1);
  });

  it("spawns a fresh app-server for a second probe and for a session after one", async () => {
    const home = homing();
    const { seam, spawns } = scripted();
    const adapter = codexAdapter(seam);
    const ctx = contextIn(home);

    await Effect.runPromise(adapter.probe(ctx, {}));
    await Effect.runPromise(adapter.probe(ctx, {}));
    expect(spawns).toHaveLength(2);

    const started = Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx)).then(
      () => undefined,
      () => undefined,
    );
    await until("spawned a third app-server", () => spawns.length === 3);
    // A session's host is never the process a probe ran on: that one is dead.
    expect(spawns[2]?.kills()).toBe(0);
    await started;
  });

  it("keeps no host an app-server refused to initialize, and ends its child", async () => {
    const home = homing();
    let attempts = 0;
    const { seam, spawns } = scripted({
      initialize: () => {
        attempts += 1;
        return attempts === 1 ? refusal("the app-server could not start a session") : INITIALIZE;
      },
    });
    const adapter = codexAdapter(seam);
    const ctx = contextIn(home);

    const refused = await Effect.runPromise(Effect.flip(adapter.startSession(SESSION, SPEC, ctx)));

    expect(refused).toContain("could not start a session");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.kills()).toBe(1);

    // A host kept under the instance id would be one every later session talks
    // to and none of them can.
    const binding = await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));
    expect(binding.nativeSessionId).toBe(THREAD);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.kills()).toBe(0);
  });
});

describe("the home a session's app-server is given", () => {
  it("spawns the app-server with the updater off and its own Codex and HOME directories", async () => {
    const home = homing();
    const { seam, spawns } = scripted();
    const ctx = contextIn(home);

    const started = Effect.runPromise(codexAdapter(seam).startSession(SESSION, SPEC, ctx)).then(
      () => undefined,
      () => undefined,
    );
    await until("spawned an app-server", () => spawns.length === 1);

    const spawn = spawns[0]!;
    expect(spawn.command).toEqual([
      ctx.binary,
      "app-server",
      "--strict-config",
      "-c",
      "check_for_update_on_startup=false",
    ]);

    const codexHome = join(home, "codex");
    const neutral = join(home, "home");
    expect(spawn.env["CODEX_HOME"]).toBe(codexHome);
    // Relocated, because CODEX_HOME alone does not isolate skills: Codex reads
    // them from the user's own `~/.agents/skills`.
    expect(spawn.env["HOME"]).toBe(neutral);
    expect(existsSync(codexHome)).toBe(true);
    expect(existsSync(neutral)).toBe(true);
    expect(statSync(codexHome).mode & 0o777).toBe(0o700);
    expect(statSync(neutral).mode & 0o777).toBe(0o700);
    expect(readdirSync(neutral)).toEqual([]);
    for (const [key, value] of Object.entries(ctx.env)) {
      if (key === "HOME") continue;
      expect(spawn.env[key]).toBe(value);
    }
    await started;
  });
});

const PRIOR = "0199e0e7-0000-7000-8000-0000000000fa";

const CWD = "/tmp/work";

/** An adapter with its events collected, and the app-server it will reach for. */
const driving = (
  answers: Answers = {},
  cwd: string | null = CWD,
): {
  readonly adapter: ReturnType<typeof codexAdapter>;
  readonly ctx: ProviderRunnerContext;
  readonly spawns: Array<Spawn>;
  readonly requests: Array<Sent>;
  readonly seen: Array<ProviderEvent>;
} => {
  const { seam, spawns, requests } = scripted(answers);
  const adapter = codexAdapter(seam);
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
  );
  return { adapter, ctx: contextIn(homing(), cwd), spawns, requests, seen };
};

const sentOf = (requests: ReadonlyArray<Sent>, method: string): ReadonlyArray<unknown> =>
  requests.filter((request) => request.method === method).map((request) => request.params);

const taggedIn = <Tag extends ProviderEvent["_tag"]>(
  seen: ReadonlyArray<ProviderEvent>,
  tag: Tag,
): ReadonlyArray<Extract<ProviderEvent, { _tag: Tag }>> =>
  seen.filter((event): event is Extract<ProviderEvent, { _tag: Tag }> => event._tag === tag);

/** Long enough for anything already in flight to have arrived, so "nothing" means it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("the thread a session is given", () => {
  it("opens one in the session's directory, on its model and in its access mode", async () => {
    const { adapter, ctx, requests, seen } = driving();

    const binding = await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    expect(binding).toEqual({
      sessionId: SESSION,
      nativeSessionId: THREAD,
      instanceId: SPEC.instanceId,
    });
    expect(sentOf(requests, "thread/start")).toHaveLength(1);
    expect(sentOf(requests, "thread/start")[0]).toMatchObject({
      cwd: CWD,
      model: "gpt-5.5",
      ephemeral: false,
      // `approval-required`, the row AD-17 gives it.
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    await until("said the session started", () => taggedIn(seen, "session.started").length === 1);
    await settle();
    expect(taggedIn(seen, "session.started")).toHaveLength(1);
  });

  it("carries on a native thread by resuming it, naming the thread it was given", async () => {
    const { adapter, ctx, requests } = driving();
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } };

    const binding = await Effect.runPromise(adapter.startSession(SESSION, spec, ctx));

    expect(sentOf(requests, "thread/resume")).toEqual([
      expect.objectContaining({ threadId: PRIOR }),
    ]);
    expect(sentOf(requests, "thread/start")).toEqual([]);
    expect(binding.nativeSessionId).toBe(RESUMED);
  });

  it("branches off a native thread by forking it, and takes the new thread's id", async () => {
    const { adapter, ctx, requests } = driving();
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "fork" } };

    const binding = await Effect.runPromise(adapter.startSession(SESSION, spec, ctx));

    expect(sentOf(requests, "thread/fork")).toEqual([expect.objectContaining({ threadId: PRIOR })]);
    expect(sentOf(requests, "thread/start")).toEqual([]);
    // The fork is a thread of its own: taking the id it was asked to fork from
    // would point the session at the thread it just left alone.
    expect(binding.nativeSessionId).toBe(FORKED);
  });

  it("fails with what the server said when a thread cannot be opened, and says nothing else", async () => {
    const { adapter, ctx, seen } = driving({
      "thread/start": () => refusal("no rollout found for thread id 00000000-0000"),
    });

    const refused = await Effect.runPromise(Effect.flip(adapter.startSession(SESSION, SPEC, ctx)));

    expect(refused).toContain("no rollout found");
    await settle();
    // A session that never started has not started: the supervisor reads
    // `session.started` as the session being live.
    expect(seen).toEqual([]);
    expect(await Effect.runPromise(adapter.listSessions)).toEqual([]);
  });
});

/** A started session, and the app-server hosting it. */
const started = async (
  answers: Answers = {},
): Promise<ReturnType<typeof driving> & { readonly server: Spawn }> => {
  const run = driving(answers);
  await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, run.ctx));
  return { ...run, server: run.spawns[0]! };
};

/** A session whose turn is running, which is what makes an input a steer. */
const busy = async (
  answers: Answers = {},
): Promise<ReturnType<typeof driving> & { readonly server: Spawn }> => {
  const run = await started(answers);
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));
  run.server.push({
    method: "turn/started",
    params: {
      threadId: THREAD,
      turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" },
    },
  });
  await until("reported the turn open", () => taggedIn(run.seen, "turn.started").length === 1);
  return run;
};

describe("what an input does to a Codex session", () => {
  it("opens a turn with the text when nothing is running", async () => {
    const run = await started();

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    expect(sent).toEqual({ turnId: TURN, delivery: "opened" });
    const opened = sentOf(run.requests, "turn/start");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ threadId: THREAD });
    expect(JSON.stringify(opened[0])).toContain("hello");
    expect(sentOf(run.requests, "turn/steer")).toEqual([]);
  });

  it("steers the running turn, naming the turn it expects to be steering", async () => {
    const run = await busy();

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "and the tests" }));

    expect(sent).toEqual({ turnId: TURN, delivery: "steered" });
    const steered = sentOf(run.requests, "turn/steer");
    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatchObject({ threadId: THREAD, expectedTurnId: TURN });
    expect(JSON.stringify(steered[0])).toContain("and the tests");
    // The first turn is the one the session opened; steering opened no second.
    expect(sentOf(run.requests, "turn/start")).toHaveLength(1);
  });

  it("opens a turn instead when the turn it meant to steer has moved on", async () => {
    const NEXT = "0199e0e7-0000-7000-8000-0000000000f9";
    let turns = 0;
    const run = await busy({
      "turn/steer": () => refusal(`expected turn ${TURN} is not the active turn`),
      "turn/start": () => {
        turns += 1;
        const id = turns === 1 ? TURN : NEXT;
        return { turn: { id, items: [], itemsView: "full", status: "inProgress" } };
      },
    });

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));

    // Never bounced: the input reaches the harness one way or the other, and
    // the adapter is the only authority on which way it went.
    expect(sent).toEqual({ turnId: NEXT, delivery: "opened" });
    expect(sentOf(run.requests, "turn/start")).toHaveLength(2);
  });

  it("opens a turn instead when the running turn cannot be steered at all", async () => {
    const NEXT = "0199e0e7-0000-7000-8000-0000000000f8";
    let turns = 0;
    const run = await busy({
      "turn/steer": () => refusal("activeTurnNotSteerable: the active turn is a review"),
      "turn/start": () => {
        turns += 1;
        const id = turns === 1 ? TURN : NEXT;
        return { turn: { id, items: [], itemsView: "full", status: "inProgress" } };
      },
    });

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));

    expect(sent).toEqual({ turnId: NEXT, delivery: "opened" });
    expect(sentOf(run.requests, "turn/steer")).toHaveLength(1);
    expect(sentOf(run.requests, "turn/start")).toHaveLength(2);
  });
});

describe("a thread the server unloads by itself", () => {
  it("ends the session as an idle unload and holds it no longer", async () => {
    const run = await started();
    expect(await Effect.runPromise(run.adapter.listSessions)).toHaveLength(1);

    run.server.push({ method: "thread/closed", params: { threadId: THREAD } });

    await until(
      "reported the session gone",
      () => taggedIn(run.seen, "session.exited").length === 1,
    );
    // `idle_unload` is the one exit that leaves the native thread on disk, so
    // it is the one a later session can carry on from.
    expect(taggedIn(run.seen, "session.exited")[0]?.reason).toBe("idle_unload");
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });

  it("says nothing more when the supervisor stops a session that is already gone", async () => {
    const run = await started();
    run.server.push({ method: "thread/closed", params: { threadId: THREAD } });
    await until(
      "reported the session gone",
      () => taggedIn(run.seen, "session.exited").length === 1,
    );
    const reported = run.seen.length;

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    await settle();
    // A second exit would be a second row for one session's end.
    expect(run.seen).toHaveLength(reported);
    expect(taggedIn(run.seen, "session.exited")).toHaveLength(1);
  });
});

const OTHER_SESSION = "0199e0e7-0000-7000-8000-0000000000f7";

const OTHER_THREAD = "0199e0e7-0000-7000-8000-0000000000f6";

/** Two sessions of one instance, which is one app-server hosting both. */
const pair = async (): Promise<ReturnType<typeof driving>> => {
  let opened = 0;
  const run = driving({
    "thread/start": () => {
      opened += 1;
      return { thread: { id: opened === 1 ? THREAD : OTHER_THREAD } };
    },
  });
  await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, run.ctx));
  await Effect.runPromise(run.adapter.startSession(OTHER_SESSION, SPEC, run.ctx));
  return run;
};

const exitsIn = (seen: ReadonlyArray<ProviderEvent>, sessionId: string): ReadonlyArray<string> =>
  taggedIn(seen, "session.exited")
    .filter((event) => event.sessionId === sessionId)
    .map((event) => event.reason);

describe("the app-server an instance's sessions share", () => {
  it("hosts both on one process and ends it only when the last one leaves", async () => {
    const run = await pair();

    expect(run.spawns).toHaveLength(1);
    expect(await Effect.runPromise(run.adapter.listSessions)).toHaveLength(2);

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    // Still hosting the other session: an app-server killed here would take a
    // session nobody stopped with it.
    expect(run.spawns[0]?.kills()).toBe(0);

    await Effect.runPromise(run.adapter.stopSession(OTHER_SESSION, "stopped"));
    expect(run.spawns[0]?.kills()).toBe(1);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });

  it("ends the turn a stopped session was running and leaves the other alone", async () => {
    const run = await pair();
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    // A turn left running would go on working in the workspace, with every
    // notification about it arriving for a session that is gone.
    expect(sentOf(run.requests, "turn/interrupt")).toEqual([{ threadId: THREAD, turnId: TURN }]);
    expect(exitsIn(run.seen, SESSION)).toEqual(["stopped"]);
    expect(exitsIn(run.seen, OTHER_SESSION)).toEqual([]);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([
      { sessionId: OTHER_SESSION, nativeSessionId: OTHER_THREAD, instanceId: SPEC.instanceId },
    ]);
  });

  it("reports every session on an app-server that stopped by itself", async () => {
    const run = await pair();

    run.spawns[0]!.crash();

    await until(
      "reported both sessions gone",
      () => taggedIn(run.seen, "session.exited").length === 2,
    );
    expect(exitsIn(run.seen, SESSION)).toEqual(["process_exit"]);
    expect(exitsIn(run.seen, OTHER_SESSION)).toEqual(["process_exit"]);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });

  it("says nothing about a thread no session on it holds", async () => {
    const run = await started();
    const reported = run.seen.length;

    run.server.push({ method: "thread/closed", params: { threadId: OTHER_THREAD } });

    await settle();
    // A thread this runner never opened is not this runner's to report on.
    expect(run.seen).toHaveLength(reported);
    expect(await Effect.runPromise(run.adapter.listSessions)).toHaveLength(1);
  });
});

const SELECTED = {
  model: "gpt-6-astra",
  options: { reasoningEffort: "high", serviceTier: "priority" },
} as const;

describe("the model a turn runs under", () => {
  it("carries the session's whole selection on the turn it opens", async () => {
    const run = await started();

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "hello", modelSelection: SELECTED }),
    );

    // Sent every time rather than only where it changed: Codex takes all three
    // per turn, and a selection changed and changed back is still a change.
    expect(sentOf(run.requests, "turn/start")[0]).toMatchObject({
      model: "gpt-6-astra",
      effort: "high",
      serviceTier: "priority",
    });
  });

  it("names no model on a turn the caller chose none for", async () => {
    const run = await started();

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    const opened = sentOf(run.requests, "turn/start")[0] as Record<string, unknown>;
    // The thread's own model stands: naming one here would be Hydra choosing.
    expect(opened["model"]).toBeUndefined();
    expect(opened["effort"]).toBeUndefined();
    expect(opened["serviceTier"]).toBeUndefined();
  });

  it("opens the thread on the model and the tier the session was given", async () => {
    const run = driving();

    await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, modelSelection: SELECTED }, run.ctx),
    );

    expect(sentOf(run.requests, "thread/start")[0]).toMatchObject({
      model: "gpt-6-astra",
      serviceTier: "priority",
    });
  });
});

/** The code spec 06 section 10.2 names for an overloaded server. */
const OVERLOADED = -32001;

const TURN_ANSWER = { turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" } };

/**
 * Walks the three backoff steps on a test clock, one attempt at a time, and
 * checks nothing retried before the clock said it could. 750, 1500 and 3000 ms
 * are the spec's 500, 1000 and 2000 with the whole 250 ms of jitter allowed.
 */
const backingOff = (attempts: () => number) =>
  Effect.gen(function* () {
    for (const step of [0, 1, 2]) {
      yield* Effect.promise(() => until(`sent attempt ${step + 1}`, () => attempts() > step));
      yield* Effect.promise(settle);
      expect(attempts(), `attempt ${step + 2} came before the backoff`).toBe(step + 1);
      yield* TestClock.adjust(Duration.millis(750 * 2 ** step));
    }
  });

describe("a turn the server is too busy to open", () => {
  it("retries it on the spec's backoff and keeps the input", async () => {
    let attempts = 0;
    const { adapter, ctx, requests } = driving({
      "turn/start": () => {
        attempts += 1;
        return attempts < 4 ? refusal("the server is overloaded", OVERLOADED) : TURN_ANSWER;
      },
    });

    const sent = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* adapter.startSession(SESSION, SPEC, ctx);
          const sending = yield* Effect.forkChild(adapter.sendInput(SESSION, { text: "hi" }));
          yield* backingOff(() => attempts);
          return yield* Fiber.join(sending);
        }),
        TestClock.layer(),
      ),
    );

    expect(sent).toEqual({ turnId: TURN, delivery: "opened" });
    expect(sentOf(requests, "turn/start")).toHaveLength(4);
  });

  it("gives up after the third retry, and fails with what the server said", async () => {
    let attempts = 0;
    const { adapter, ctx, requests } = driving({
      "turn/start": () => {
        attempts += 1;
        return refusal("the server is overloaded", OVERLOADED);
      },
    });

    const refused = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* adapter.startSession(SESSION, SPEC, ctx);
          const sending = yield* Effect.forkChild(
            Effect.flip(adapter.sendInput(SESSION, { text: "hi" })),
          );
          yield* backingOff(() => attempts);
          return yield* Fiber.join(sending);
        }),
        TestClock.layer(),
      ),
    );

    expect(refused).toContain("overloaded");
    // Three retries, not four: the send is bounded.
    expect(sentOf(requests, "turn/start")).toHaveLength(4);
  });

  it("does not retry an error that is not an overload", async () => {
    const { adapter, ctx, requests } = driving({
      "turn/start": () => refusal("thread not found: 00000000-0000-0000-0000-000000000000"),
    });
    await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    const refused = await Effect.runPromise(
      Effect.flip(adapter.sendInput(SESSION, { text: "hi" })),
    );

    expect(refused).toContain("thread not found");
    // Retrying a request the server refused on its merits would just refuse
    // three more times, four seconds later.
    expect(sentOf(requests, "turn/start")).toHaveLength(1);
  });
});

const ENV: Readonly<Record<string, string | undefined>> = { PATH: "/usr/local/bin:/usr/bin" };

const installing = (
  answer: { readonly code: number; readonly stdout?: string; readonly stderr?: string },
  options: { readonly hangs?: boolean } = {},
): {
  readonly install: Effect.Effect<{ readonly ok: boolean; readonly message?: string }>;
  readonly commands: Array<ReadonlyArray<string>>;
  readonly envs: Array<Readonly<Record<string, string | undefined>>>;
} => {
  const commands: Array<ReadonlyArray<string>> = [];
  const envs: Array<Readonly<Record<string, string | undefined>>> = [];
  const seam: CodexSeam = {
    appServer: () => {
      throw new Error("installing must not start an app-server");
    },
    run: (command, env) => {
      commands.push(command);
      envs.push(env);
      return options.hangs === true
        ? Effect.never
        : Effect.succeed({
            code: answer.code,
            stdout: answer.stdout ?? "",
            stderr: answer.stderr ?? "",
          });
    },
  };
  return { install: codexAdapter(seam).install!(ENV), commands, envs };
};

describe("installing the Codex harness", () => {
  it("runs the vendor's install script pinned to the release this build talks to", async () => {
    const { install, commands, envs } = installing({ code: 0, stdout: "Installed codex" });

    const outcome = await Effect.runPromise(install);

    expect(outcome.ok).toBe(true);
    expect(commands).toEqual([
      [
        "bash",
        "-c",
        `curl -fsSL https://raw.githubusercontent.com/openai/codex/rust-v${CODEX_VERSION}/scripts/install/install.sh | CODEX_RELEASE=${CODEX_VERSION} CODEX_NON_INTERACTIVE=1 sh`,
      ],
    ]);
    expect(envs).toEqual([ENV]);
  });

  it("says what the installer said when it failed, rather than that it failed", async () => {
    const stderr = [
      "resolving the release",
      "  % Total    % Received",
      "curl: (22) The requested URL returned error: 404",
      "install.sh: could not download the archive",
      "install.sh: giving up",
      "install.sh: nothing was installed",
    ].join("\n");
    const { install } = installing({ code: 1, stderr });

    const outcome = await Effect.runPromise(install);

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? "").toContain("install.sh: nothing was installed");
    // The last five lines, so the banner above them is not what the user reads.
    expect(outcome.message ?? "").toContain("  % Total    % Received");
    expect(outcome.message ?? "").not.toContain("resolving the release");
  });

  it("gives up on an installer that outlives the deadline, and names it", async () => {
    const { install } = installing({ code: 0 }, { hangs: true });

    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(install);
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(INSTALL_DEADLINE);
          return yield* Fiber.join(running);
        }),
        TestClock.layer(),
      ),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? "").toContain(Duration.format(INSTALL_DEADLINE));
  });
});

/** Built rather than written, so the literals are not in this file for it to find. */
const grepping = (pattern: string): string =>
  Bun.spawnSync({
    cmd: ["bash", "-c", `grep -rn '${pattern}' apps/runner/src --include=*.ts || true`],
    cwd: root,
  })
    .stdout.toString()
    .split("\n")
    .filter((line) => line !== "" && !line.includes("/generated/"))
    .join("\n");

describe("the two Codex surfaces this adapter must never reach for", () => {
  it("calls neither the shell-command method nor the process one", () => {
    // A runner that let a harness spawn its own processes would host work
    // outside every session boundary Hydra places.
    expect(grepping(["thread/shell", "Command", "\\|process/", "spawn"].join(""))).toBe("");
  });

  it("never names the user's own Codex home", () => {
    // The only Codex home a runner may touch is the one built from `ctx.home`.
    expect(grepping(["~/\\", ".codex\\|$HOME/\\", ".codex"].join(""))).toBe("");
  });
});

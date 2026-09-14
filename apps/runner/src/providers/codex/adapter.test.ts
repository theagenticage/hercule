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
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { CODEX_VERSION } from "@hydra/home/version";
import type { ProbeResult, SessionSpec } from "@hydra/protocol";
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

const contextIn = (home: string): ProviderRunnerContext => ({
  cwd: null,
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
}

/**
 * An answer per method: a value to reply with, or `SILENT` for a method the
 * server never answers, which is what codex 0.154.0 does with one it does not
 * know.
 */
const SILENT = Symbol("no reply");

type Answers = Readonly<Record<string, ((params: unknown) => unknown) | typeof SILENT>>;

/** An answer that refuses the request, the way codex answers a bad one. */
const refusal = (message: string): { readonly error: { code: number; message: string } } => ({
  error: { code: -32600, message },
});

const DEFAULT_ANSWERS: Answers = {
  initialize: () => INITIALIZE,
  "account/read": () => LOGGED_OUT,
  "model/list": () => MODELS,
  "thread/start": () => ({ thread: { id: THREAD } }),
};

/**
 * A seam whose app-server replies line by line, recording the argv and the env
 * it was spawned with. `dies` is a server that exits instead of answering.
 */
const scripted = (
  answers: Answers = {},
  options: { readonly dies?: boolean } = {},
): { readonly seam: CodexSeam; readonly spawns: Array<Spawn> } => {
  const spawns: Array<Spawn> = [];
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
      spawns.push({ command, env, kills: () => kills });
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
  return { seam, spawns };
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

const WAIT_MS = 5_000;

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

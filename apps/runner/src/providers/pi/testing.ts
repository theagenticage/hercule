/**
 * The fake pi every adapter test in this folder drives: a seam whose child
 * answers one line at a time, records the argv, the environment and every
 * command it was written, and lets a test push an event of its own. Nothing
 * vendor-supplied runs, and the frames it answers with are the shapes
 * pi 0.85.1 declares - `dist/modes/rpc/rpc-types.d.ts` for the commands and
 * their responses, the bundled `models.json` for the two GLM models - not
 * shapes invented here.
 *
 * It lives beside the tests rather than inside one of them because the probe's
 * tests and the adapter's drive the same child. What is not pi's - scratch
 * homes, a pushable line stream, waiting on an adapter - is `../testing`.
 *
 * The seam it stands in for is `PiSeam`: a `spawn` for the line-framed RPC
 * child and a `run` for a one-shot command. The child answers `write`,
 * `stdout`, `stderr`, `exited`, `kill` and `end` - `end` closes stdin, which
 * pi reads as its cue to leave.
 */
import { join } from "node:path";
import { Effect, Stream } from "effect";
import type { ProviderEvent, SessionSpec } from "@hercule/protocol";
import type { ProviderRunnerContext } from "../index";
import type { Ran } from "../process";
import { CWD, lines, scratchHome, taggedIn, until } from "../testing";
import { piAdapter, type PiSeam } from "./adapter";

export { cleanupHomes, CWD, lines, PRIOR, settle, taggedIn, until, WAIT_MS } from "../testing";

export const homing = (): string => scratchHome("pi");

/** Not a key: a placeholder no upstream would accept, which is the point. */
export const TEST_ZAI_KEY = "zai-key-for-a-test-only";

export const contextIn = (
  home: string,
  cwd: string | null = null,
  secrets: Readonly<Record<string, string>> = { zaiApiKey: TEST_ZAI_KEY },
): ProviderRunnerContext => ({
  cwd,
  home,
  binary: "/usr/local/bin/pi",
  env: { PATH: "/usr/local/bin:/usr/bin", HYDRA_RUNNER: "runner-1" },
  secrets,
  hydraTool: { skill: "", claudePluginDir: join(home, "claude-plugin") },
});

export const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";

export const SPEC: SessionSpec = {
  instanceId: "0199e0e7-0000-7000-8000-00000000000a",
  workspaceId: null,
  modelSelection: { model: "glm-5.3", options: { thinking: "high" } },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

/**
 * Z.ai's models as pi 0.85.1's own catalog answers with them, all seven,
 * plus one from another provider so a filter has something to leave out. The
 * thinking maps are theirs too: a level mapped to null is one the model cannot
 * be asked for, and the 5.2 line takes `off` where the 5.3 line cannot.
 */
const zaiModel = (
  id: string,
  name: string,
  thinkingLevelMap: Readonly<Record<string, string | null>> | undefined,
  cost: Readonly<Record<string, number>>,
  contextWindow: number,
  input: ReadonlyArray<string> = ["text"],
): Record<string, unknown> => ({
  id,
  name,
  api: "openai-completions",
  provider: "zai",
  baseUrl: "https://api.z.ai/api/coding/paas/v4",
  reasoning: true,
  ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
  input,
  cost,
  contextWindow,
  maxTokens: 131_072,
});

/** What the 5.2 line takes, which is not what the 5.3 line takes. */
const THINKING_52 = {
  off: "none",
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

const THINKING_53 = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

const FULL_COST = { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 };

const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const GLM_53 = zaiModel("glm-5.3", "GLM-5.3", THINKING_53, FULL_COST, 1_000_000);

const GLM_53_FLASH = zaiModel(
  "glm-5.3-flash",
  "GLM-5.3-Flash",
  THINKING_53,
  { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
  1_000_000,
  ["text", "image"],
);

/** The catalog in the order pi lists it. */
export const ZAI_MODELS: ReadonlyArray<Record<string, unknown>> = [
  zaiModel(
    "glm-4.7",
    "GLM-4.7",
    undefined,
    { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
    204_800,
  ),
  zaiModel(
    "glm-5-turbo",
    "GLM-5-Turbo",
    undefined,
    { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 },
    200_000,
  ),
  zaiModel("glm-5.2", "GLM-5.2", THINKING_52, FULL_COST, 1_000_000),
  zaiModel("glm-5.2-highspeed", "GLM-5.2 Highspeed", THINKING_52, FREE, 1_000_000),
  GLM_53,
  GLM_53_FLASH,
  zaiModel("glm-5.3-highspeed", "GLM-5.3 Highspeed", THINKING_53, FREE, 1_000_000),
];

const ANOTHER_PROVIDERS_MODEL = {
  id: "claude-sonnet-4-20250514",
  name: "Claude Sonnet 4",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 16_384,
  cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
};

/** One pi the adapter asked for, and what it was asked with. */
export interface Spawn {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The directory pi was started in, which is where its session's files go. */
  readonly cwd: string | null;
  /** An event pi sends unasked, which is everything on its stdout but a response. */
  readonly push: (event: unknown) => void;
  readonly stdinClosed: () => boolean;
  readonly kills: () => number;
  /**
   * pi stopping by itself, which is not the adapter ending it, saying on its
   * stderr what it stopped over.
   */
  readonly crash: (...complaints: ReadonlyArray<string>) => void;
}

/** One command the adapter wrote, in the order it wrote them. */
export interface Sent {
  readonly type: string;
  readonly command: Record<string, unknown>;
}

/**
 * What pi answers one command with: the body of its `response` frame, minus the
 * envelope the fixture puts back on. `undefined` is a command pi never answers.
 */
export type Answers = Readonly<
  Record<string, (command: Record<string, unknown>) => Record<string, unknown> | undefined>
>;

const DEFAULT_ANSWERS: Answers = {
  prompt: () => ({ success: true }),
  steer: () => ({ success: true }),
  abort: () => ({ success: true }),
  set_model: () => ({ success: true, data: GLM_53 }),
  set_thinking_level: () => ({ success: true }),
  get_available_models: () => ({
    success: true,
    data: { models: [ANOTHER_PROVIDERS_MODEL, ...ZAI_MODELS] },
  }),
};

/** What pi answers a command it will not do with, naming the field it refused. */
export const refusal = (error: string): Record<string, unknown> => ({ success: false, error });

export const FAKE_PI_VERSION = "0.85.1";

/** `pi auth check --provider zai --json` as pi 0.85.1 answers both branches. */
const authCheck = (env: Readonly<Record<string, string | undefined>>): Ran =>
  (env["ZAI_API_KEY"] ?? "") === ""
    ? {
        code: 1,
        stdout: `${JSON.stringify({
          status: "not_ready",
          provider: "zai",
          reason: "credentials_not_configured",
        })}\n`,
        stderr: "",
      }
    : {
        code: 0,
        stdout: `${JSON.stringify({ status: "ready", provider: "zai", authType: "api_key" })}\n`,
        stderr: "",
      };

/** One command the adapter ran to completion, and what it was run with. */
interface RunCall {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface FakePiBehaviour {
  /** What each RPC command is answered with, over the defaults above. */
  readonly answers?: Answers;
  /** What a one-shot command says, over `pi --version` and `pi auth check`. */
  readonly ran?: (
    command: ReadonlyArray<string>,
    env: Readonly<Record<string, string | undefined>>,
  ) => Ran | undefined;
  /** A pi that exits instead of speaking, the way a broken install does. */
  readonly dies?: boolean;
  /** A pi that reads the end of its stdin and stays anyway, as a parked one does. */
  readonly lingers?: boolean;
}

/**
 * A seam whose pi answers line by line, recording the argv and the environment
 * it was spawned with, every command it was sent, and every one-shot run.
 */
export const buildFakePiSeam = (
  behaviour: FakePiBehaviour = {},
): {
  readonly seam: PiSeam;
  readonly spawns: Array<Spawn>;
  readonly sent: Array<Sent>;
  readonly runs: Array<RunCall>;
} => {
  const spawns: Array<Spawn> = [];
  const sent: Array<Sent> = [];
  const runs: Array<RunCall> = [];
  const replies: Answers = { ...DEFAULT_ANSWERS, ...behaviour.answers };
  const spawn = (
    command: ReadonlyArray<string>,
    env: Readonly<Record<string, string | undefined>>,
    cwd: string | null,
  ) => {
    const out = lines();
    const err = lines();
    let kills = 0;
    let closed = false;
    let exited: (code: number) => void = () => undefined;
    const done = new Promise<number>((resolve) => {
      exited = resolve;
    });
    if (behaviour.dies === true) {
      err.push("pi: could not start");
      out.end();
      err.end();
      exited(1);
    }
    const handle = (line: string): void => {
      const frame = JSON.parse(line) as Record<string, unknown>;
      const type = frame["type"];
      if (typeof type !== "string") return;
      sent.push({ type, command: frame });
      // An extension UI answer is not a command and is never responded to.
      if (type === "extension_ui_response") return;
      const reply = replies[type]?.(frame);
      if (reply === undefined) return;
      out.push(
        JSON.stringify({
          type: "response",
          command: type,
          ...(typeof frame["id"] === "string" ? { id: frame["id"] } : {}),
          ...reply,
        }),
      );
    };
    const leaving = (): void => {
      out.end();
      err.end();
      exited(0);
    };
    const child = {
      write: (text: string) => {
        for (const line of text.split("\n")) if (line.trim() !== "") handle(line);
      },
      stdout: out.iterable,
      stderr: err.iterable,
      /** Closing stdin is what pi reads as the end of the conversation. */
      end: () => {
        closed = true;
        if (behaviour.lingers !== true) leaving();
      },
      kill: () => {
        kills += 1;
        out.end();
        err.end();
        exited(143);
      },
      exited: done,
    };
    spawns.push({
      command,
      env,
      cwd,
      push: (event) => out.push(JSON.stringify(event)),
      stdinClosed: () => closed,
      kills: () => kills,
      crash: (...complaints) => {
        for (const line of complaints) err.push(line);
        out.end();
        err.end();
        exited(1);
      },
    });
    return child;
  };
  const seam: PiSeam = {
    spawn,
    run: (command, env) => {
      runs.push({ command, env });
      const answered = behaviour.ran?.(command, env);
      if (answered !== undefined) return Effect.succeed(answered);
      const args = command.slice(1).join(" ");
      if (args === "--version")
        return Effect.succeed({ code: 0, stdout: `${FAKE_PI_VERSION}\n`, stderr: "" });
      if (args === "auth check --provider zai --json") return Effect.succeed(authCheck(env));
      return Effect.succeed({ code: 1, stdout: "", stderr: `unknown command: ${args}` });
    },
  };
  return { seam, spawns, sent, runs };
};

/** An adapter with its events collected, and the fake pi it will reach for. */
export const driving = (
  behaviour: FakePiBehaviour = {},
  cwd: string | null = CWD,
): {
  readonly adapter: ReturnType<typeof piAdapter>;
  readonly ctx: ProviderRunnerContext;
  readonly spawns: Array<Spawn>;
  readonly sent: Array<Sent>;
  readonly runs: Array<RunCall>;
  readonly seen: Array<ProviderEvent>;
} => {
  const { seam, spawns, sent, runs } = buildFakePiSeam(behaviour);
  const adapter = piAdapter(seam);
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
  );
  return { adapter, ctx: contextIn(homing(), cwd), spawns, sent, runs, seen };
};

export const sentOf = (
  sent: ReadonlyArray<Sent>,
  type: string,
): ReadonlyArray<Record<string, unknown>> =>
  sent.filter((one) => one.type === type).map((one) => one.command);

/** A started session, and the pi hosting it. */
export const started = async (
  behaviour: FakePiBehaviour = {},
  spec: SessionSpec = SPEC,
): Promise<ReturnType<typeof driving> & { readonly child: Spawn }> => {
  const run = driving(behaviour);
  await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));
  await until("spawned a pi", () => run.spawns.length === 1);
  return { ...run, child: run.spawns[0]! };
};

/** A session whose turn is running, which is what makes an input a steer. */
export const busy = async (
  behaviour: FakePiBehaviour = {},
): Promise<ReturnType<typeof driving> & { readonly child: Spawn }> => {
  const run = await started(behaviour);
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));
  run.child.push({ type: "agent_start" });
  await until("reported the turn open", () => taggedIn(run.seen, "turn.started").length === 1);
  return run;
};

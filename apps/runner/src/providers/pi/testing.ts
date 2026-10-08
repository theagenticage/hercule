/**
 * The fake pi that every adapter test in this folder uses. Its child process
 * responds to one line at a time, records the arguments, the environment and
 * every command written to it, and lets a test push events of its own. No
 * vendor code runs. The frames it responds with follow the shapes pi 0.85.1
 * declares - `dist/modes/rpc/rpc-types.d.ts` for the commands and responses,
 * and the bundled `models.json` for the GLM models - and are not invented
 * here.
 *
 * It lives in its own file because the probe tests and the adapter tests use
 * the same fake child. Helpers that are not specific to pi - scratch homes, a
 * line stream a test can push to, waiting on an adapter - are in `../testing`.
 *
 * It fakes `PiSeam`: a `spawn` for the line-based RPC child and a `run` for a
 * one-shot command. The child supports `write`, `stdout`, `stderr`, `exited`,
 * `kill` and `end`. `end` closes stdin, which tells pi to exit.
 */
import { join } from "node:path";
import { Effect, Stream } from "effect";
import type { ProviderEvent, SessionSpec } from "@hercule/protocol";
import type { ProviderRunnerContext } from "../index";
import type { Ran } from "../process";
import { CWD, createLines, createScratchHome, filterByTag, waitUntil } from "../testing";
import { makePiAdapter, type PiSeam } from "./adapter";

export {
  cleanupHomes,
  CWD,
  createLines,
  PRIOR,
  settle,
  filterByTag,
  waitUntil,
  WAIT_MS,
} from "../testing";

export const createPiHome = (): string => createScratchHome("pi");

/** A placeholder, not a real key: no provider would accept it, on purpose. */
export const TEST_ZAI_KEY = "zai-key-for-a-test-only";

export const buildContext = (
  home: string,
  cwd: string | null = null,
  secrets: Readonly<Record<string, string>> = { zaiApiKey: TEST_ZAI_KEY },
): ProviderRunnerContext => ({
  cwd,
  attachmentsDir: null,
  home,
  binary: "/usr/local/bin/pi",
  env: { PATH: "/usr/local/bin:/usr/bin", HERCULE_RUNNER: "runner-1" },
  secrets,
  herculeTool: { skill: "", claudePluginDir: join(home, "claude-plugin") },
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
 * Builds one Z.ai model as pi 0.85.1's catalog lists it. The catalog below has
 * all seven, and the default `get_available_models` response adds one model
 * from another provider, so the probe's filter has something to leave out.
 * The thinking maps are pi's too: a level mapped to null is one the model
 * does not support, and the 5.2 models support `off` while the 5.3 models do
 * not.
 */
const buildZaiModel = (
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

/** The thinking levels of the 5.2 models, which differ from the 5.3 models'. */
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

export const GLM_53 = buildZaiModel("glm-5.3", "GLM-5.3", THINKING_53, FULL_COST, 1_000_000);

const GLM_53_FLASH = buildZaiModel(
  "glm-5.3-flash",
  "GLM-5.3-Flash",
  THINKING_53,
  { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
  1_000_000,
  ["text", "image"],
);

/** The catalog in the order pi lists it. */
export const ZAI_MODELS: ReadonlyArray<Record<string, unknown>> = [
  buildZaiModel(
    "glm-4.7",
    "GLM-4.7",
    undefined,
    { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
    204_800,
  ),
  buildZaiModel(
    "glm-5-turbo",
    "GLM-5-Turbo",
    undefined,
    { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 },
    200_000,
  ),
  buildZaiModel("glm-5.2", "GLM-5.2", THINKING_52, FULL_COST, 1_000_000),
  buildZaiModel("glm-5.2-highspeed", "GLM-5.2 Highspeed", THINKING_52, FREE, 1_000_000),
  GLM_53,
  GLM_53_FLASH,
  buildZaiModel("glm-5.3-highspeed", "GLM-5.3 Highspeed", THINKING_53, FREE, 1_000_000),
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

/** A pi process the adapter spawned, with what it was spawned with and controls for the test. */
export interface Spawn {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The directory pi was started in, where its session's files go. */
  readonly cwd: string | null;
  /** Pushes an event to pi's stdout, as pi does with everything but responses. */
  readonly push: (event: unknown) => void;
  /** The commands the adapter wrote to this pi alone, in the order written. */
  readonly sent: ReadonlyArray<Sent>;
  readonly stdinClosed: () => boolean;
  readonly kills: () => number;
  /**
   * Makes pi exit by itself, not because the adapter stopped it, after writing
   * the given lines to stderr.
   */
  readonly crash: (...complaints: ReadonlyArray<string>) => void;
}

/** A command the adapter wrote to pi. The list keeps them in the order written. */
export interface Sent {
  readonly type: string;
  readonly command: Record<string, unknown>;
}

/**
 * The fake's response to each command type: the body of the `response` frame,
 * without the `type`, `command` and `id` fields the fake adds. Returning
 * `undefined` means pi never responds to the command.
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

/** Builds pi's response to a command it rejects, with the given error message. */
export const buildRefusal = (error: string): Record<string, unknown> => ({ success: false, error });

export const FAKE_PI_VERSION = "0.85.1";

/** Returns what `pi auth check --provider zai --json` prints in pi 0.85.1, with and without a key. */
const answerAuthCheck = (env: Readonly<Record<string, string | undefined>>): Ran =>
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

/** A one-shot command the adapter ran, and the environment it ran with. */
interface RunCall {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface FakePiBehaviour {
  /** Responses to RPC commands, replacing the defaults above. */
  readonly answers?: Answers;
  /** Results for one-shot commands, checked before the `pi --version` and `pi auth check` defaults. */
  readonly ran?: (
    command: ReadonlyArray<string>,
    env: Readonly<Record<string, string | undefined>>,
  ) => Ran | undefined;
  /** A pi that exits at once without responding, like a broken install. */
  readonly dies?: boolean;
  /** A pi that keeps running after its stdin closes, like one waiting on an approval. */
  readonly lingers?: boolean;
}

/**
 * Builds a fake `PiSeam` whose pi responds line by line. Returns the seam and
 * the lists it records into: every spawn with its arguments and environment,
 * every command sent, and every one-shot run.
 */
export const buildFakePiSeam = (
  behaviour: FakePiBehaviour = {},
): {
  readonly seam: PiSeam;
  readonly spawns: Array<Spawn>;
  readonly sent: Array<Sent>;
  readonly runs: Array<RunCall>;
  readonly cleanedFiles: Array<string>;
} => {
  const spawns: Array<Spawn> = [];
  const sent: Array<Sent> = [];
  const runs: Array<RunCall> = [];
  const cleanedFiles: Array<string> = [];
  const replies: Answers = { ...DEFAULT_ANSWERS, ...behaviour.answers };
  const spawn = (
    command: ReadonlyArray<string>,
    env: Readonly<Record<string, string | undefined>>,
    cwd: string | null,
  ) => {
    const out = createLines();
    const err = createLines();
    const sentToThisPi: Array<Sent> = [];
    let kills = 0;
    let closed = false;
    let resolveExited: (code: number) => void = () => undefined;
    const done = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });
    if (behaviour.dies === true) {
      err.push("pi: could not start");
      out.end();
      err.end();
      resolveExited(1);
    }
    const handleLine = (line: string): void => {
      const frame = JSON.parse(line) as Record<string, unknown>;
      const type = frame["type"];
      if (typeof type !== "string") return;
      sent.push({ type, command: frame });
      sentToThisPi.push({ type, command: frame });
      // An extension UI response is not a command, so pi never responds to it.
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
    const exitCleanly = (): void => {
      out.end();
      err.end();
      resolveExited(0);
    };
    const child = {
      write: (text: string) => {
        for (const line of text.split("\n")) if (line.trim() !== "") handleLine(line);
      },
      stdout: out.iterable,
      stderr: err.iterable,
      /** Closes stdin, which tells pi the conversation is over. */
      end: () => {
        closed = true;
        if (behaviour.lingers !== true) exitCleanly();
      },
      kill: () => {
        kills += 1;
        out.end();
        err.end();
        resolveExited(143);
      },
      exited: done,
    };
    spawns.push({
      command,
      env,
      cwd,
      push: (event) => out.push(JSON.stringify(event)),
      sent: sentToThisPi,
      stdinClosed: () => closed,
      kills: () => kills,
      crash: (...complaints) => {
        for (const line of complaints) err.push(line);
        out.end();
        err.end();
        resolveExited(1);
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
      if (args === "auth check --provider zai --json") return Effect.succeed(answerAuthCheck(env));
      return Effect.succeed({ code: 1, stdout: "", stderr: `unknown command: ${args}` });
    },
    // A fake pi starts no bash call, so no process holds its file. The file is
    // recorded, so a test can check that an agent's leftovers were killed.
    killProcessesHolding: (file) => Effect.sync(() => void cleanedFiles.push(file)),
  };
  return { seam, spawns, sent, runs, cleanedFiles };
};

/** Creates an adapter on a fake pi, and collects every event it emits. */
export const createDriving = (
  behaviour: FakePiBehaviour = {},
  cwd: string | null = CWD,
): {
  readonly adapter: ReturnType<typeof makePiAdapter>;
  readonly ctx: ProviderRunnerContext;
  readonly spawns: Array<Spawn>;
  readonly sent: Array<Sent>;
  readonly runs: Array<RunCall>;
  readonly cleanedFiles: Array<string>;
  readonly seen: Array<ProviderEvent>;
} => {
  const { seam, spawns, sent, runs, cleanedFiles } = buildFakePiSeam(behaviour);
  const adapter = makePiAdapter(seam);
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
  );
  return {
    adapter,
    ctx: buildContext(createPiHome(), cwd),
    spawns,
    sent,
    runs,
    cleanedFiles,
    seen,
  };
};

export const listSentCommands = (
  sent: ReadonlyArray<Sent>,
  type: string,
): ReadonlyArray<Record<string, unknown>> =>
  sent.filter((one) => one.type === type).map((one) => one.command);

/**
 * Starts a session on a fake pi. `runnerEnv` holds variables added to the
 * runner's own environment, which the adapter passes on to pi. Returns the
 * adapter setup and the pi hosting the session.
 */
export const startTestSession = async (
  behaviour: FakePiBehaviour = {},
  spec: SessionSpec = SPEC,
  runnerEnv: Readonly<Record<string, string>> = {},
): Promise<ReturnType<typeof createDriving> & { readonly child: Spawn }> => {
  const driving = createDriving(behaviour);
  const run = { ...driving, ctx: { ...driving.ctx, env: { ...driving.ctx.env, ...runnerEnv } } };
  await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));
  await waitUntil("spawned a pi", () => run.spawns.length === 1);
  return { ...run, child: run.spawns[0]! };
};

/** Starts a session with a turn running, so the next input steers that turn. */
export const startBusySession = async (
  behaviour: FakePiBehaviour = {},
  spec: SessionSpec = SPEC,
  runnerEnv: Readonly<Record<string, string>> = {},
): Promise<ReturnType<typeof createDriving> & { readonly child: Spawn }> => {
  const run = await startTestSession(behaviour, spec, runnerEnv);
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));
  run.child.push({ type: "agent_start" });
  await waitUntil(
    "reported the turn open",
    () => filterByTag(run.seen, "turn.started").length === 1,
  );
  return run;
};

/**
 * The scripted app-server that every Codex adapter test uses: a seam whose
 * child replies line by line, records the requests it receives, and lets a
 * test push a notification or a server request. No Codex code runs, and the
 * scripted replies use the shapes captured from codex 0.154.0, not invented
 * ones.
 *
 * It is in its own file because two test files use it: the adapter tests and
 * the approvals tests.
 */
import { join } from "node:path";
import { Effect, Stream } from "effect";
import type { ProviderEvent, SessionSpec } from "@hercule/protocol";
import type { ProviderRunnerContext } from "../index";
import { CWD, createLines, createScratchHome, filterByTag, waitUntil } from "../testing";
import { makeCodexAdapter, type CodexSeam } from "./adapter";

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

export const createCodexHome = (): string => createScratchHome("codex");

export const buildContext = (home: string, cwd: string | null = null): ProviderRunnerContext => ({
  cwd,
  home,
  binary: "/usr/local/bin/codex",
  env: { PATH: "/usr/local/bin:/usr/bin", HERCULE_RUNNER: "runner-1" },
  secrets: {},
  // The runner resolves this once, at start. A test that depends on it sets
  // its own value.
  herculeTool: { skill: "", claudePluginDir: join(home, "claude-plugin") },
});

export const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
export const THREAD = "0199e0e7-0000-7000-8000-0000000000fe";

export const SPEC: SessionSpec = {
  instanceId: "0199e0e7-0000-7000-8000-00000000000a",
  workspaceId: null,
  modelSelection: { model: "gpt-5.5", options: {} },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

/** `samples/probe-initialize.json`. The version lives inside the user agent. */
export const INITIALIZE = {
  userAgent: "hercule/0.154.0 (Mac OS 15.7.8; arm64) unknown (hercule; 0.0.0)",
  codexHome: "/private/tmp/ch.XXXX",
  platformFamily: "unix",
  platformOs: "macos",
};

/** A notification Codex sends right after `initialize`, without being asked. */
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

/**
 * From `samples/probe-account-read.json`: the observed reply first, then two
 * replies built from the generated types.
 */
export const LOGGED_OUT = { account: null, requiresOpenaiAuth: true };
export const CHATGPT = {
  account: { type: "chatgpt", email: "rogier@example.com", planType: "pro" },
  requiresOpenaiAuth: false,
};
export const API_KEY = { account: { type: "apiKey" }, requiresOpenaiAuth: false };

/** `samples/probe-model-list.json`: one model per option shape. */
export const MODELS = {
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

/** One app-server the adapter started, and the command and env it was started with. */
export interface Spawn {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly kills: () => number;
  /** Sends a frame from the server without a request: a notification or a server request. */
  readonly push: (frame: unknown) => void;
  /** Makes the app-server exit on its own, without the adapter killing it. */
  readonly crash: () => void;
}

/** One request the adapter sent. The list is in the order they were sent. */
export interface Sent {
  readonly method: string;
  readonly params: unknown;
}

/**
 * One reply the adapter sent to a server request, with that request's id.
 * Exactly one of `result` and `error` is present: `result` for a normal reply,
 * `error` for a rejection.
 */
export interface Answered {
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * A reply per method: a function that builds the reply, or `SILENT` for a
 * method the server never replies to. codex 0.154.0 never replies to a method
 * it does not know.
 */
export const SILENT = Symbol("no reply");

export type Answers = Readonly<Record<string, ((params: unknown) => unknown) | typeof SILENT>>;

/**
 * Builds an error reply, the way codex replies to an invalid request. The
 * default code `-32600` is the one observed at 0.154.0 (`samples/errors.json`).
 */
export const buildRefusal = (
  message: string,
  code = -32600,
): { readonly error: { code: number; message: string } } => ({ error: { code, message } });

export const RESUMED = THREAD;
export const FORKED = "0199e0e7-0000-7000-8000-0000000000fc";
export const TURN = "0199e0e7-0000-7000-8000-0000000000fb";

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
};

/**
 * Builds a seam whose app-server replies line by line. It records the command
 * and env each app-server was started with, every request sent to it, and
 * every reply the adapter sent back. With `dies`, the app-server exits at once
 * instead of replying.
 */
export const buildScriptedSeam = (
  answers: Answers = {},
  options: { readonly dies?: boolean } = {},
): {
  readonly seam: CodexSeam;
  readonly spawns: Array<Spawn>;
  readonly requests: Array<Sent>;
  readonly answered: Array<Answered>;
} => {
  const spawns: Array<Spawn> = [];
  const requests: Array<Sent> = [];
  const answered: Array<Answered> = [];
  const replies: Answers = { ...DEFAULT_ANSWERS, ...answers };
  const seam: CodexSeam = {
    appServer: (command, env) => {
      const out = createLines();
      const err = createLines();
      let kills = 0;
      let resolveExited: (code: number) => void = () => undefined;
      const done = new Promise<number>((resolve) => {
        resolveExited = resolve;
      });
      if (options.dies === true) {
        err.push("codex: app-server failed to start");
        out.end();
        err.end();
        resolveExited(1);
      }
      const handleLine = (line: string): void => {
        const frame = JSON.parse(line) as Record<string, unknown>;
        const method = frame["method"];
        if (frame["id"] !== undefined && typeof method !== "string") {
          // A frame with an id and no method is the adapter's reply to a server
          // request, which is what the approvals tests check.
          answered.push(frame as unknown as Answered);
          return;
        }
        if (typeof method !== "string" || frame["id"] === undefined) return;
        requests.push({ method, params: frame["params"] });
        const reply = replies[method];
        if (reply === undefined || reply === SILENT) return;
        const returned = reply(frame["params"]);
        if (returned === SILENT) return;
        const replied = returned as { readonly error?: unknown };
        out.push(
          JSON.stringify(
            replied !== null && typeof replied === "object" && "error" in replied
              ? { id: frame["id"], error: replied.error }
              : { id: frame["id"], result: replied },
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
          resolveExited(1);
        },
      });
      return {
        write: (text: string) => {
          for (const line of text.split("\n")) if (line.trim() !== "") handleLine(line);
        },
        stdout: out.iterable,
        stderr: err.iterable,
        kill: () => {
          kills += 1;
          out.end();
          err.end();
          resolveExited(143);
        },
        exited: done,
      };
    },
    run: () => Effect.die("probing must not run a command"),
  };
  return { seam, spawns, requests, answered };
};

/** Creates an adapter on a scripted seam, collecting every event it emits into `seen`. */
export const createDriving = (
  answers: Answers = {},
  cwd: string | null = CWD,
): {
  readonly adapter: ReturnType<typeof makeCodexAdapter>;
  readonly ctx: ProviderRunnerContext;
  readonly spawns: Array<Spawn>;
  readonly requests: Array<Sent>;
  readonly answered: Array<Answered>;
  readonly seen: Array<ProviderEvent>;
} => {
  const { seam, spawns, requests, answered } = buildScriptedSeam(answers);
  const adapter = makeCodexAdapter(seam);
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
  );
  return { adapter, ctx: buildContext(createCodexHome(), cwd), spawns, requests, answered, seen };
};

export const listSentParams = (
  requests: ReadonlyArray<Sent>,
  method: string,
): ReadonlyArray<unknown> =>
  requests.filter((request) => request.method === method).map((request) => request.params);

/** Starts a session and returns it with the app-server hosting it. */
export const startTestSession = async (
  answers: Answers = {},
): Promise<ReturnType<typeof createDriving> & { readonly server: Spawn }> => {
  const run = createDriving(answers);
  await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, run.ctx));
  return { ...run, server: run.spawns[0]! };
};

/** Starts a session with a running turn, so that the next input steers it. */
export const startBusySession = async (
  answers: Answers = {},
): Promise<ReturnType<typeof createDriving> & { readonly server: Spawn }> => {
  const run = await startTestSession(answers);
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));
  run.server.push({
    method: "turn/started",
    params: {
      threadId: THREAD,
      turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" },
    },
  });
  await waitUntil(
    "reported the turn open",
    () => filterByTag(run.seen, "turn.started").length === 1,
  );
  return run;
};

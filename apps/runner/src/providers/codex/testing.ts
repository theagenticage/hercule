/**
 * The scripted app-server every Codex adapter test drives: a seam whose child
 * answers line by line, records what it was asked, and lets a test push a
 * notification or a request of its own. Nothing vendor-supplied runs, and the
 * frames the script answers with are the shapes captured from codex 0.154.0,
 * not shapes invented here.
 *
 * It lives beside the tests rather than inside one of them because two test
 * files drive the same app-server: the adapter's own and the approvals'.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { Effect, Stream } from "effect";
import type { ProviderEvent, SessionSpec } from "@hydra/protocol";
import type { ProviderRunnerContext } from "../index";
import { codexAdapter, type CodexSeam } from "./adapter";

const homes: Array<string> = [];

/** Every scratch home a test made, thrown away. Each test file runs it once. */
export const cleanupHomes = (): void => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
};

export const homing = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hydra-codex-"));
  homes.push(home);
  return home;
};

export const contextIn = (home: string, cwd: string | null = null): ProviderRunnerContext => ({
  cwd,
  home,
  binary: "/usr/local/bin/codex",
  env: { PATH: "/usr/local/bin:/usr/bin", HYDRA_RUNNER: "runner-1" },
  // The runner resolves this once, at start; a test that cares about it says
  // what it is (AD-8).
  hydraTool: { skill: "", claudePluginDir: join(home, "claude-plugin") },
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

/** A stream of lines a test pushes into, read once by the code under test. */
export const lines = (): {
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
export interface Spawn {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly kills: () => number;
  /** A frame the server sends unasked: a notification, or a request of its own. */
  readonly push: (frame: unknown) => void;
  /** The app-server stopping by itself, which is not the adapter ending it. */
  readonly crash: () => void;
}

/** One request the adapter wrote, in the order it wrote them. */
export interface Sent {
  readonly method: string;
  readonly params: unknown;
}

/**
 * One reply the adapter wrote back to a request the server made, by that
 * request's id. Exactly one of `result` and `error` is present, which is what
 * tells an answer from a refusal.
 */
export interface Answered {
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * An answer per method: a value to reply with, or `SILENT` for a method the
 * server never answers, which is what codex 0.154.0 does with one it does not
 * know.
 */
export const SILENT = Symbol("no reply");

export type Answers = Readonly<Record<string, ((params: unknown) => unknown) | typeof SILENT>>;

/**
 * An answer that refuses the request, the way codex answers a bad one:
 * `-32600` is the code observed at 0.154.0 (`samples/errors.json`).
 */
export const refusal = (
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
 * A seam whose app-server replies line by line, recording the argv and the env
 * it was spawned with and every request it was sent. `dies` is a server that
 * exits instead of answering.
 */
export const scripted = (
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
        if (frame["id"] !== undefined && typeof method !== "string") {
          // A frame with an id and no method is the adapter answering something
          // the server asked, which is the whole subject of the approvals tests.
          answered.push(frame as unknown as Answered);
          return;
        }
        if (typeof method !== "string" || frame["id"] === undefined) return;
        requests.push({ method, params: frame["params"] });
        const reply = replies[method];
        if (reply === undefined || reply === SILENT) return;
        const replied = reply(frame["params"]) as { readonly error?: unknown };
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
  return { seam, spawns, requests, answered };
};

export const WAIT_MS = 2_000;

/** Waits for something the adapter has done, or gives up and says what it was. */
export const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + WAIT_MS;
  while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(ready(), `the adapter never ${what}`).toBe(true);
};

export const PRIOR = "0199e0e7-0000-7000-8000-0000000000fa";

export const CWD = "/tmp/work";

/** An adapter with its events collected, and the app-server it will reach for. */
export const driving = (
  answers: Answers = {},
  cwd: string | null = CWD,
): {
  readonly adapter: ReturnType<typeof codexAdapter>;
  readonly ctx: ProviderRunnerContext;
  readonly spawns: Array<Spawn>;
  readonly requests: Array<Sent>;
  readonly answered: Array<Answered>;
  readonly seen: Array<ProviderEvent>;
} => {
  const { seam, spawns, requests, answered } = scripted(answers);
  const adapter = codexAdapter(seam);
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
  );
  return { adapter, ctx: contextIn(homing(), cwd), spawns, requests, answered, seen };
};

export const sentOf = (requests: ReadonlyArray<Sent>, method: string): ReadonlyArray<unknown> =>
  requests.filter((request) => request.method === method).map((request) => request.params);

export const taggedIn = <Tag extends ProviderEvent["_tag"]>(
  seen: ReadonlyArray<ProviderEvent>,
  tag: Tag,
): ReadonlyArray<Extract<ProviderEvent, { _tag: Tag }>> =>
  seen.filter((event): event is Extract<ProviderEvent, { _tag: Tag }> => event._tag === tag);

/** Long enough for anything already in flight to have arrived, so "nothing" means it. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/** A started session, and the app-server hosting it. */
export const started = async (
  answers: Answers = {},
): Promise<ReturnType<typeof driving> & { readonly server: Spawn }> => {
  const run = driving(answers);
  await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, run.ctx));
  return { ...run, server: run.spawns[0]! };
};

/** A session whose turn is running, which is what makes an input a steer. */
export const busy = async (
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

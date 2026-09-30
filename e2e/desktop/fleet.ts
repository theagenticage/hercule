/**
 * A fleet of scripted runners on a real controller, and the records threads
 * are filed under: projects and repository resources. The desktop end-to-end
 * suite and the desktop perf script use it to fill a controller with threads
 * in known states.
 *
 * It needs only the controller's URL, and signs in with the account
 * `completeSetup` in `scripts/controller-process.ts` creates. It uses only
 * Node's APIs and TypeScript that Node can strip, because the perf script
 * runs it on plain Node; that is also why its imports name the `.ts` file.
 *
 * Every thread is pinned to a scripted runner and to the Claude Code
 * instance. The controller also starts a runner of its own, on this machine,
 * which may be logged in to a real provider: a thread that lands there would
 * run a real agent.
 *
 * A thread can also play a script: the turn its prompt opens reports the work
 * the script describes, through the real runner protocol, and `waitForTurn`
 * waits for the controller to have recorded where a turn has got to.
 */
import type {
  Project,
  ProviderInstance,
  Resource,
  Session,
  SpawnWorkspace,
  TranscriptRow,
} from "../../packages/contract/src/index";
import type { TurnState } from "../../packages/protocol/src/index";
import { setTimeout as sleep } from "node:timers/promises";
import { PASSWORD, USERNAME } from "../../scripts/controller-process.ts";
import {
  enlistScriptedRunner,
  type ScriptedRunner,
  type ScriptStep,
} from "../../scripts/scripted-runner.ts";

/** How many spawns are in flight at once; SQLite writes one at a time anyway. */
const SPAWN_CONCURRENCY = 8;

/** How long `waitForTurn` waits before it fails. */
const TURN_WAIT_MS = 10_000;

/** How often `waitForTurn` reads the transcript again. */
const TURN_POLL_MS = 25;

/**
 * Where a turn has got to, as its session's transcript records it:
 *
 * - `running`: the turn has started, and no Request is open;
 * - `waiting`: a Request opened during the turn is still open;
 * - `completed`, `failed`, `interrupted`: the turn ended that way.
 */
export type TurnProgress = "running" | "waiting" | TurnState;

/** Where a batch of threads goes. */
export interface ThreadPlacement {
  /** The runner every thread is pinned to. */
  readonly runner: ScriptedRunner;
  readonly projectId?: string;
  /** The workspace each thread opens in; without one, a thread has no checkout. */
  readonly workspace?: SpawnWorkspace;
}

/** A controller signed in to, and the scripted runners enlisted on it. */
export interface Fleet {
  /** The user's API token, for calls the fleet does not wrap. */
  readonly token: string;
  /**
   * Enlists a scripted runner under `name` and returns it once the controller
   * can place threads on it: it is online, and its probe of the Claude Code
   * instance reported a login. `maxConcurrentSessions` overrides the cap the
   * controller derives from the runner's memory, which is 32.
   */
  readonly enlistRunner: (
    name: string,
    options?: { readonly maxConcurrentSessions?: number },
  ) => Promise<ScriptedRunner>;
  readonly createProject: (name: string) => Promise<Project>;
  /** Creates a repository resource for `remote`, filed under the given projects. */
  readonly createRepository: (
    remote: string,
    projectIds?: ReadonlyArray<string>,
  ) => Promise<Resource>;
  /**
   * Spawns `count` threads, titled "Thread 1", "Thread 2" and on across every
   * call, and returns them as the spawn returned them. A thread that has a
   * free slot on its runner starts at once and settles busy, running the
   * turn its prompt opened.
   */
  readonly spawnThreads: (
    count: number,
    placement: ThreadPlacement,
  ) => Promise<ReadonlyArray<Session>>;
  /**
   * Spawns one thread whose first turn plays `script`, as `playScript` on its
   * runner does. The prompt is the user's first message, and the next
   * "Thread N" title when it is left out. Returns the thread as the spawn
   * returned it, and `played`, which settles as `playScript` does: await it,
   * so a script that fails fails the caller.
   */
  readonly spawnScriptedThread: (
    placement: ThreadPlacement & { readonly prompt?: string },
    script: ReadonlyArray<ScriptStep>,
  ) => Promise<{ readonly thread: Session; readonly played: Promise<void> }>;
  /**
   * Waits until the session's turn number `turn`, counting from 1, has
   * reached `progress` in the transcript the controller wrote. Only the
   * transcript is read, every 25 ms, so a turn that passes through a state
   * faster than that may never be seen in it. Fails after 10 s, saying where
   * the turn got to.
   */
  readonly waitForTurn: (sessionId: string, turn: number, progress: TurnProgress) => Promise<void>;
  /** Takes every enlisted runner that is still connected offline, so nothing holds the process open. */
  readonly disconnectRunners: () => Promise<void>;
}

/**
 * Signs in to the controller at `url` and returns a fleet with no runners
 * yet. Fails if the sign-in is refused, for example because setup has not
 * been completed.
 */
export async function connectFleet(url: string): Promise<Fleet> {
  const { token } = await callApi<{ readonly token: string }>(url, null, "POST", "/auth/login", {
    username: USERNAME,
    password: PASSWORD,
  });
  const call = <T>(method: string, path: string, body?: unknown): Promise<T> =>
    callApi<T>(url, token, method, path, body);

  const runners: Array<ScriptedRunner> = [];
  let instanceId: string | undefined;
  let spawned = 0;

  /** Spawns one thread with `prompt`, pinned to the placement's runner and the Claude Code instance. */
  const spawnThread = (
    prompt: string,
    { runner, projectId, workspace }: ThreadPlacement,
  ): Promise<Session> =>
    call<Session>("POST", "/sessions", {
      prompt,
      runnerId: runner.runnerId,
      instanceId,
      ...(projectId === undefined ? {} : { projectId }),
      ...(workspace === undefined ? {} : { workspace }),
    });

  /** Returns the next "Thread N" title; the numbers run on across every spawn. */
  const buildNextTitle = (): string => {
    spawned += 1;
    return `Thread ${spawned}`;
  };

  return {
    token,
    enlistRunner: async (name, options = {}) => {
      const joinToken = await call<{ readonly token: string }>("POST", "/runners/join-tokens");
      const runner = await enlistScriptedRunner(url, joinToken.token);
      runners.push(runner);
      await call("PATCH", `/runners/${runner.runnerId}`, { name, ...options });
      instanceId = await waitForLoggedInProbe(call, runner.runnerId);
      return runner;
    },
    createProject: (name) => call<Project>("POST", "/projects", { name }),
    createRepository: (remote, projectIds = []) =>
      call<Resource>("POST", "/resources", { kind: "repo", remote, projectIds }),
    spawnThreads: async (count, placement) => {
      const threads: Array<Session> = [];
      for (let first = 0; first < count; first += SPAWN_CONCURRENCY) {
        const batch = Array.from({ length: Math.min(SPAWN_CONCURRENCY, count - first) }, () =>
          spawnThread(buildNextTitle(), placement),
        );
        threads.push(...(await Promise.all(batch)));
      }
      return threads;
    },
    spawnScriptedThread: async (placement, script) => {
      const thread = await spawnThread(placement.prompt ?? buildNextTitle(), placement);
      return { thread, played: placement.runner.playScript(thread.id, script) };
    },
    waitForTurn: async (sessionId, turn, progress) => {
      const deadline = Date.now() + TURN_WAIT_MS;
      for (;;) {
        const rows = await readTranscript(call, sessionId);
        const reached = computeTurnProgress(rows, turn);
        if (reached === progress) return;
        if (Date.now() > deadline) {
          throw new Error(
            `turn ${turn} of session ${sessionId} never became ${progress}; ` +
              (reached === undefined ? "it never started" : `it is ${reached}`),
          );
        }
        await sleep(TURN_POLL_MS);
      }
    },
    disconnectRunners: async () => {
      await Promise.all(runners.map((runner) => runner.goOffline()));
    },
  };
}

/**
 * Waits until the Claude Code instance has a logged-in snapshot from the given
 * runner, and returns the instance's id. The controller probes every instance
 * on a runner when it connects, and places a thread only on a runner whose
 * snapshot shows a login. Fails after 10 s.
 */
async function waitForLoggedInProbe(
  call: <T>(method: string, path: string) => Promise<T>,
  runnerId: string,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const instances = await call<ReadonlyArray<ProviderInstance>>("GET", "/providers");
    const claudeCode = instances.find((instance) => instance.providerId === "claude-code");
    if (claudeCode === undefined) throw new Error("the controller has no Claude Code instance");
    const probed = claudeCode.snapshots.some(
      (snapshot) => snapshot.runnerId === runnerId && snapshot.auth.status === "ok",
    );
    if (probed) return claudeCode.id;
    await sleep(20);
  }
  throw new Error(`the controller never probed runner ${runnerId}`);
}

/** Reads a session's whole transcript, oldest row first, a page of 500 rows at a time. */
async function readTranscript(
  call: <T>(method: string, path: string) => Promise<T>,
  sessionId: string,
): Promise<ReadonlyArray<TranscriptRow>> {
  const rows: Array<TranscriptRow> = [];
  let cursor: string | undefined;
  do {
    const query = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const page = await call<{
      readonly items: ReadonlyArray<TranscriptRow>;
      readonly nextCursor?: string;
    }>("GET", `/sessions/${sessionId}/transcript?limit=500${query}`);
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return rows;
}

/**
 * Returns where the session's turn number `turn`, counting from 1, has got
 * to in the transcript `rows`, or `undefined` if that turn has not started.
 * A Request event carries no turn id, so a Request belongs to the turn it
 * opened during: the rows are in order, and a harness asks only while a turn
 * runs.
 */
function computeTurnProgress(
  rows: ReadonlyArray<TranscriptRow>,
  turn: number,
): TurnProgress | undefined {
  let started = 0;
  let turnId: string | undefined;
  let openRequestId: string | undefined;
  for (const { event } of rows) {
    if (turnId === undefined) {
      if (event._tag === "turn.started") {
        started += 1;
        if (started === turn) turnId = event.turnId;
      }
      continue;
    }
    if (event._tag === "turn.completed" && event.turnId === turnId) return event.state;
    if (event._tag === "request.opened") openRequestId = event.request.requestId;
    if (event._tag === "request.resolved" && event.requestId === openRequestId) {
      openRequestId = undefined;
    }
  }
  if (turnId === undefined) return undefined;
  return openRequestId === undefined ? "running" : "waiting";
}

/**
 * Calls one operation of the public API and returns its parsed response.
 * Fails with the status and the response body when the call fails.
 */
async function callApi<T>(
  url: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${url}/api/v1${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as T;
}

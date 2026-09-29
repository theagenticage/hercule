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
 */
import type {
  Project,
  ProviderInstance,
  Resource,
  Session,
  SpawnWorkspace,
} from "../../packages/contract/src/index";
import { setTimeout as sleep } from "node:timers/promises";
import { PASSWORD, USERNAME } from "../../scripts/controller-process.ts";
import { enlistScriptedRunner, type ScriptedRunner } from "../../scripts/scripted-runner.ts";

/** How many spawns are in flight at once; SQLite writes one at a time anyway. */
const SPAWN_CONCURRENCY = 8;

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
    spawnThreads: async (count, { runner, projectId, workspace }) => {
      const threads: Array<Session> = [];
      for (let first = 0; first < count; first += SPAWN_CONCURRENCY) {
        const batch = Array.from({ length: Math.min(SPAWN_CONCURRENCY, count - first) }, () => {
          spawned += 1;
          return call<Session>("POST", "/sessions", {
            prompt: `Thread ${spawned}`,
            runnerId: runner.runnerId,
            instanceId,
            ...(projectId === undefined ? {} : { projectId }),
            ...(workspace === undefined ? {} : { workspace }),
          });
        });
        threads.push(...(await Promise.all(batch)));
      }
      return threads;
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

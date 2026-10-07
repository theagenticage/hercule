/**
 * A fleet with workspaces on it, for the tests that drive them over the real
 * API and the real runner socket. It is shared by this domain's own suites
 * (provisioning, the expiry sweep and git credentials), by the sweep's tests
 * on the workspaces of runs, and by the resources suite, because all of them
 * set up the same runner and read the same records back. A second copy of
 * what a workspace looks like on the wire would be a second place for the
 * tests and the controller to drift apart.
 *
 * What differs between callers is passed in: extra plugins besides the
 * provider fixture, and the sweep interval for a test that watches the sweep.
 */
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import type * as Duration from "effect/Duration";
import type { ModelDescriptor, RunnerFacts, SessionStart } from "@hercule/protocol";
import type { Session, Workspace } from "@hercule/contract";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  type Plugin,
} from "@hercule/plugin-host";
import { get, post } from "../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import {
  reportEvent,
  spawnSessionOrFail,
  waitForFrames,
  waitUntil,
  withFleet as withRunnerFleet,
  type Arranged,
  type Wire,
} from "../sessions/testing";

/** The runner facts the single runner in these fleets reports. */
export const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [{ name: "git", version: "2.50.1", path: "/usr/bin/git" }],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["test-provider"],
  identityPort: 4939,
};

/** The models the runner's probe returns, so a session has a model to be placed against. */
export const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", isDefault: true, options: [] },
];

export interface WorkspaceFleetOptions {
  /** Plugins to load in addition to the provider fixture that every one of these fleets needs. */
  readonly plugins?: ReadonlyArray<Plugin>;
  /**
   * Overrides the shipped ten minutes, which is longer than a test that
   * watches the sweep can wait.
   */
  readonly workspaceSweepInterval?: Duration.Duration;
}

/**
 * Runs `body` against a controller with one enrolled, connected, logged-in
 * runner and a provider on it.
 */
export const withFleet = (
  body: (arranged: Arranged) => Promise<void>,
  options: WorkspaceFleetOptions = {},
): Promise<void> =>
  withRunnerFleet(body, {
    plugins: [
      createPluginFixture({
        id: "providers",
        definitions: [buildProviderDefinition("test-provider")],
      }).plugin,
      ...(options.plugins ?? []),
    ],
    facts: FACTS,
    models: MODELS,
    ...(options.workspaceSweepInterval === undefined
      ? {}
      : { workspaceSweepInterval: options.workspaceSweepInterval }),
  });

/** The GitHub login that `githubPlugin` gives a Connection created with `GITHUB_PAT`. */
export const GITHUB_LOGIN = "octocat";
export const GITHUB_PAT = "ghp_a-token";

/**
 * The GitHub Connection type, validating tokens locally rather than against
 * api.github.com. A token must start with `ghp_`; `GITHUB_PAT` belongs to
 * `GITHUB_LOGIN`, and any other accepted token to `hubot`.
 */
export const githubPlugin: Plugin = {
  manifest: {
    id: "github",
    displayName: "GitHub",
    hostApi: HOST_API,
    capabilities: ["connections"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerConnectionType(host, {
      type: "github",
      displayName: "GitHub",
      setup: [{ kind: "credentials", fields: [{ name: "pat", label: "Personal access token" }] }],
      validate: (credentials: Record<string, string>) => {
        const pat = credentials["pat"] ?? "";
        return pat.startsWith("ghp_")
          ? Effect.succeed(
              pat === GITHUB_PAT
                ? { displayName: GITHUB_LOGIN, accountId: "583231" }
                : { displayName: "hubot", accountId: "480938" },
            )
          : Effect.fail(new ConnectionValidationFailed({ message: "GitHub rejected the token." }));
      },
    }),
  activate: () => Effect.succeed(Effect.void),
};

/**
 * Creates a GitHub Connection with these credentials through the API, and
 * returns its id. The fleet must run `githubPlugin`.
 */
export const createGithubConnection = async (
  arranged: Arranged,
  credentials: Record<string, string>,
): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/connections",
    { type: "github/github", label: "work", labels: ["Code"], credentials },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

/** A frame on the wire, read as the object it is rather than as a member of a union. */
export type Frame = { readonly _tag: string } & Record<string, unknown>;

export const listFramesTagged = (wire: Wire, tag: string): ReadonlyArray<Frame> =>
  (wire.frames as ReadonlyArray<Frame>).filter((frame) => frame._tag === tag);

/** One checkout of a workspace, as the API hands it back. */
export interface CheckoutRecord {
  readonly checkoutId?: string;
  readonly id?: string;
  readonly resourceId: string;
  readonly form: string;
  readonly subdirectory: string | null;
  readonly branch: string | null;
  readonly branches?: ReadonlyArray<string>;
  readonly defaultBranch?: string | null;
}

/** Reads the error code from an error response. */
export const readErrorCode = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

/**
 * Creates a repo resource, optionally with the Connection its token comes
 * from, and returns its id.
 */
export const createRepo = async (
  arranged: Arranged,
  remote: string,
  connectionId?: string,
): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/resources",
    { kind: "repo", remote, ...(connectionId === undefined ? {} : { connectionId }) },
    arranged.token,
  );
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { id: string }).id;
};

/**
 * Calls `workspace.provision` and returns the new workspace, which the runner
 * has not provisioned yet.
 */
export const provisionWorkspaceOrFail = async (
  arranged: Arranged,
  body: unknown,
): Promise<Workspace> => {
  const response = await post(arranged.harness.base, "/api/v1/workspaces", body, arranged.token);
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return (await response.json()) as Workspace;
};

export const readWorkspace = async (arranged: Arranged, id: string): Promise<Workspace> => {
  const response = await get(arranged.harness.base, `/api/v1/workspaces/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Workspace;
};

/**
 * Reports a workspace ready over the runner socket, with every checkout on
 * `main`, as a runner does once it has provisioned it. Returns the workspace
 * once the controller has recorded it as ready.
 */
export const reportWorkspaceReady = async (arranged: Arranged, id: string): Promise<Workspace> => {
  const workspace = await readWorkspace(arranged, id);
  arranged.wire.send({
    _tag: "workspaceReport",
    workspaceId: id,
    status: "ready",
    checkouts: workspace.checkouts.map((checkout) => ({
      checkoutId: String(checkout.checkoutId),
      branch: "main",
      branches: ["main"],
      defaultBranch: "main",
    })),
  });
  return await waitUntil("made the workspace ready", async () => {
    const one = await readWorkspace(arranged, id);
    return one.status === "ready" ? one : undefined;
  });
};

/** The time the runner stamps on the events these helpers report. */
const REPORTED_AT = "2026-09-16T10:00:00.000Z";

/** Reads a session through the API. */
const readThread = async (arranged: Arranged, id: string): Promise<Session> =>
  (await (
    await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token)
  ).json()) as Session;

/**
 * Spawns a thread in the workspace `workspace` asks for, and waits until it
 * is started on the runner and busy with the turn its prompt opened. A new
 * workspace is reported ready first. `count` is how many `sessionStart`
 * frames the runner has been sent once this one is, counting the earlier
 * sessions of the test.
 */
export const spawnThread = async (
  arranged: Arranged,
  workspace: unknown,
  count: number,
): Promise<Session> => {
  const session = await spawnSessionOrFail(arranged, { prompt: "hello", workspace });
  const workspaceId = String(session.workspaceId);
  if ((await readWorkspace(arranged, workspaceId)).status === "provisioning") {
    await reportWorkspaceReady(arranged, workspaceId);
  }
  await waitForFrames<SessionStart>(arranged.wire, "sessionStart", count);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at: REPORTED_AT,
    _tag: "session.started",
  });
  await waitUntil("started the session", async () => {
    const one = await readThread(arranged, session.id);
    return one.status === "busy" ? one : undefined;
  });
  return session;
};

/**
 * Has the runner report that the thread's provider transcript is known, which
 * a session needs before it can be resumed.
 */
export const bindTranscript = async (arranged: Arranged, session: Session): Promise<void> => {
  arranged.wire.send({
    _tag: "sessionsReport",
    sessions: [
      {
        sessionId: session.id,
        nativeSessionId: "native-1",
        instanceId: arranged.instances[0]!.id,
      },
    ],
  });
  await waitUntil("bound the native session", async () => {
    const one = await readThread(arranged, session.id);
    return one.nativeSessionId !== null ? one : undefined;
  });
};

/**
 * Has the runner report that the thread exited, and waits until the
 * controller has recorded the exit. Returns the session as it is then.
 */
export const reportThreadExit = async (
  arranged: Arranged,
  session: Session,
  reason: "crash" | "stopped",
): Promise<Session> => {
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at: REPORTED_AT,
    _tag: "session.exited",
    reason,
  });
  return await waitUntil("ended the session", async () => {
    const one = await readThread(arranged, session.id);
    return one.status === "exited" ? one : undefined;
  });
};

/** Ends the thread with nothing to resume from, so it releases its lease as `orphan`. */
export const endUnresumable = async (arranged: Arranged, session: Session): Promise<void> => {
  const ended = await reportThreadExit(arranged, session, "crash");
  expect(ended.resumable).toBe(false);
};

/** Ends the thread so that the next input resumes it in place, so it releases its lease as `idle`. */
export const endResumable = async (arranged: Arranged, session: Session): Promise<void> => {
  await bindTranscript(arranged, session);
  const ended = await reportThreadExit(arranged, session, "stopped");
  expect(ended.resumable).toBe(true);
};

/**
 * Moves the release time and the kept-until time of every released lease on
 * a workspace back by `hours`. That is how a test crosses a window without
 * waiting for it: the shortest window any setting allows is an hour.
 */
export const ageLeases = (
  arranged: Arranged,
  workspaceId: string,
  hours: number,
): Promise<unknown> => {
  const shift = `-${String(hours)} hours`;
  return Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql`
        UPDATE workspace_leases
        SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ', released_at, ${shift}),
            kept_until = strftime('%Y-%m-%dT%H:%M:%fZ', kept_until, ${shift})
        WHERE workspace_id = unhex(replace(${workspaceId}, '-', ''))
          AND released_at IS NOT NULL`,
    ),
  );
};

/**
 * Returns how many lease rows a workspace has, active or released. No API
 * shows a released lease, so a test that checks the table does not grow reads
 * it directly.
 */
export const countLeases = async (arranged: Arranged, workspaceId: string): Promise<number> => {
  const rows = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM workspace_leases
        WHERE workspace_id = unhex(replace(${workspaceId}, '-', ''))`,
    ),
  );
  return rows[0]?.count ?? 0;
};

/** Returns the `workspace.deleted` audit entries, with their actors and payloads. */
export const listWorkspaceDeletions = async (
  arranged: Arranged,
): Promise<
  ReadonlyArray<{ readonly actor: string | null; readonly payload: Record<string, unknown> }>
> => {
  const response = await get(arranged.harness.base, "/api/v1/events", arranged.token);
  const log = (await response.json()) as {
    readonly items: ReadonlyArray<{
      readonly kind: string;
      readonly actor: string | null;
      readonly payload: Record<string, unknown>;
    }>;
  };
  return log.items.filter((entry) => entry.kind === "workspace.deleted");
};

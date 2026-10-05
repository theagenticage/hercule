/**
 * Resolves what one session needs on this machine from its start frame. The
 * frame holds ids, and this file turns them into paths and an environment.
 * Only this file knows where an instance's home or a workspace lives on the
 * runner. The controller never sees a path (spec 06 section 4).
 */
import { mkdirSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import type { SessionStart } from "@hercule/protocol";
import { buildGitCredentialEnv } from "../credentials";
import { buildSubstrateEnv, switchBranch, type Workspaces } from "../workspaces";
import type { ProviderRunnerContext } from "../providers";
import { provisionUserMaterial } from "../user-material";

/** The facts about this machine that a session's context is built from. */
export interface Machine {
  /** `<runner storage>/providers`: one isolated provider home per instance. */
  readonly providersDir: string;
  /** Where a workspace-less session's empty cwd is made, one directory per session. */
  readonly scratchDir: string;
  /** `<home>/runner/bin`, holding the `hercule` symlink, prepended to a session's `PATH`. */
  readonly binDir: string;
  /** The skill and the Claude plugin directory, prepared once at runner start (spec 06 section 9.3). */
  readonly herculeTool: ProviderRunnerContext["herculeTool"];
  /** What a session reads as `HERCULE_API_URL`. */
  readonly controllerUrl: string;
  /** The runner's own environment. A session's environment is built on top of it. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** Returns the harness path the last probe found for a binary name, or undefined if it found none. */
  readonly findBinary: (binaryName: string) => string | undefined;
  /** The workspaces on this machine. A session with a workspace runs in it. */
  readonly workspaces: Workspaces;
  /** The socket the git credential helper connects to when it asks this runner for credentials. */
  readonly socketPath: string;
}

export interface Resolved {
  readonly ctx: ProviderRunnerContext;
  /** The scratch directory, removed when the session exits. Undefined for a session that has a workspace. */
  readonly scratch: string | undefined;
}

/**
 * Returns the string-valued variables in the `env` object of an instance's
 * config: the "extra environment for the spawned process" (spec 06 section
 * 2.1). No shipped provider declares a `configSchema` field for it yet, so the
 * config is read leniently: anything else is ignored rather than failing the
 * session start.
 *
 * `HOME` is dropped. Moving it makes the Claude CLI report another account's
 * login, or none, because the macOS Keychain item is keyed by the real home
 * (spec 06 section 9.1). `CLAUDE_CONFIG_DIR` isolates the instance instead.
 */
const readInstanceEnv = (config: unknown): Record<string, string> => {
  const env = (config as { readonly env?: unknown } | null)?.env;
  if (typeof env !== "object" || env === null) return {};
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "HOME",
    ),
  );
};

/**
 * Builds a session's environment in three layers, each overriding the one
 * before it (spec 06 section 4):
 *
 * - the runner's own environment, with git's and Hercule's own variables
 *   removed;
 * - the instance's extra environment;
 * - Hercule's variables: the git credential helper, `GH_TOKEN`, the API URL,
 *   the session token, and `PATH`.
 *
 * Hercule's layer comes last, so instance config can never replace the
 * session's token, its controller, or the `hercule` the session calls.
 *
 * The token, `GH_TOKEN` and the git identity come only from the frame; the
 * runner never makes them up. They are passed through the environment and
 * nowhere else, because anything written to disk would outlive the session
 * (spec 06 section 9.3). When the frame has no `GH_TOKEN`, the variable is left
 * out: `gh` would read an empty one as a credential that failed, not as no
 * credential at all.
 *
 * Git's variables are removed from the inherited environment the same way the
 * substrate environment removes them. Otherwise a `GIT_ASKPASS` or a
 * `GIT_CONFIG_*` that the person who started the daemon exported for
 * themselves would answer credential prompts for the agent, or replace the
 * credential helper set below. The runner's own `HERCULE_*` variables are
 * removed the same way, so the session never inherits the runner's Home or
 * settings. Every `HERCULE_*` variable the session does get is added after
 * that removal: by the instance's extra environment, by the credential
 * helper's variables, or by the lines below.
 */
const buildEnv = (machine: Machine, frame: SessionStart): Record<string, string | undefined> => ({
  ...buildSubstrateEnv(machine.baseEnv),
  ...readInstanceEnv(frame.config),
  ...buildGitCredentialEnv({ socketPath: machine.socketPath, identity: frame.gitIdentity }),
  ...(frame.ghToken === undefined ? {} : { GH_TOKEN: frame.ghToken }),
  HERCULE_API_URL: machine.controllerUrl,
  HERCULE_TOKEN: frame.token,
  HERCULE_SESSION: "1",
  // The bin directory goes first, so `which hercule` finds this build, and the
  // machine's own tools still work after it (spec 15 section 2). The rest is
  // the machine's own `PATH`. A `PATH` in instance config is ignored, because
  // it could put another directory first and shadow `hercule` with a
  // different binary. An empty entry in `PATH` means the current directory,
  // so when the machine has no `PATH`, the result is the bin directory alone,
  // with no trailing colon.
  PATH:
    machine.baseEnv["PATH"] === undefined || machine.baseEnv["PATH"] === ""
      ? machine.binDir
      : `${machine.binDir}:${machine.baseEnv["PATH"]}`,
});

/**
 * Runs a filesystem operation. Fails with the error's message, which is the
 * text the user reads in the session's stream.
 */
const tryFilesystem = <A>(work: () => A): Effect.Effect<A, string> =>
  Effect.try({
    try: work,
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });

/**
 * Returns the directory a session runs in, and its scratch directory if it has
 * one. Fails with a message when the workspace is not on this runner, when git
 * cannot switch to the requested branch, or when the filesystem fails.
 *
 * A session without a workspace gets an empty scratch directory, not the
 * runner's own cwd, because every harness reads instruction files out of its
 * cwd. The adapter does the rest of keeping stray context out of the session:
 * no context-file discovery, auto memory off, and a strict MCP config
 * (spec 06 section 9.1).
 */
const placeSession = (
  frame: SessionStart,
  machine: Machine,
): Effect.Effect<{ readonly cwd: string; readonly scratch: string | undefined }, string> =>
  Effect.gen(function* () {
    const { workspaceId } = frame.spec;
    if (workspaceId === null) {
      return yield* tryFilesystem(() => {
        const scratch = joinPath(machine.scratchDir, frame.sessionId);
        // Remove and recreate rather than only create: the directory must be
        // empty, and one left behind by an earlier session with the same id
        // may not be.
        rmSync(scratch, { recursive: true, force: true });
        mkdirSync(scratch, { recursive: true, mode: 0o700 });
        return { cwd: scratch, scratch };
      });
    }
    const workspace = machine.workspaces.resolve(workspaceId);
    if (workspace === undefined) {
      // Never a silent fallback to a scratch directory: the session would run
      // somewhere the user did not choose.
      return yield* Effect.fail(`this runner does not hold workspace ${workspaceId}`);
    }
    const branch = frame.checkoutBranch;
    if (branch !== undefined) {
      // Never force the switch: a forced switch can throw away the user's
      // uncommitted work, and losing that is worse than not starting the
      // session.
      //
      // The switch does not wait for the lock that the workspace's action
      // steps take. The runner handles a connection's frames one at a time,
      // so a wait here would hold up every other frame. If a step's git runs
      // in the checkout at the same moment, git's own index lock makes one of
      // the two fail with an error (spec 07 section 4.4).
      const switched = yield* Effect.promise(() =>
        switchBranch(workspace.cwd, branch, buildSubstrateEnv(machine.baseEnv)),
      );
      if (!switched.ok) return yield* Effect.fail(switched.stderr);
    }
    return { cwd: workspace.cwd, scratch: undefined };
  });

/**
 * Resolves the context an adapter needs to start a session: its cwd, the
 * instance's provider home, the harness binary, the environment and the
 * secrets. When the frame's `userMaterial` flag is set, the context also
 * carries the user's own material (spec 06 section 9.1). Fails with a message the user can read
 * when the session cannot be placed on this machine.
 */
export const resolveSessionContext = (
  frame: SessionStart,
  machine: Machine,
  binaryName: string,
): Effect.Effect<Resolved, string> =>
  Effect.gen(function* () {
    const placed = yield* placeSession(frame, machine);
    const home = yield* tryFilesystem(() => {
      const dir = joinPath(machine.providersDir, frame.spec.instanceId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    });
    // Only a Thread on the controller's local runner sees the user's own
    // material. The key is left out for every other session, so its adapter
    // keeps the harness isolated from the user's installation.
    const userMaterial =
      frame.userMaterial === true
        ? yield* provisionUserMaterial(frame.providerId, home, machine.baseEnv)
        : undefined;
    return {
      scratch: placed.scratch,
      ctx: {
        cwd: placed.cwd,
        home,
        binary: machine.findBinary(binaryName),
        env: buildEnv(machine, frame),
        // Passed to the adapter as they are, not added to the environment:
        // only the adapter knows which variable its harness reads a credential
        // from.
        secrets: frame.secrets,
        herculeTool: machine.herculeTool,
        ...(userMaterial === undefined ? {} : { userMaterial }),
      },
    };
  });

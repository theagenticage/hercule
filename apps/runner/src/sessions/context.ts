/**
 * What one session needs on this machine, resolved from the frame that asked
 * for it: ids in, paths out (spec 06 section 4). Only this file knows where an
 * instance or a workspace lives on the runner.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import type { SessionStart } from "@hydra/protocol";
import { gitCredentialEnv } from "../credentials";
import { substrateEnv, switchBranch, type Workspaces } from "../workspaces";
import type { ProviderRunnerContext } from "../providers";

/** The facts about this machine a session is resolved against. */
export interface Machine {
  /** `<runner storage>/providers`: one isolated provider home per instance. */
  readonly providersDir: string;
  /** Where a workspace-less session's empty cwd is made, one directory per session. */
  readonly scratchDir: string;
  /** What a session reads as `HYDRA_API_URL`. */
  readonly controllerUrl: string;
  /** The runner's own environment, the bottom layer of a session's. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** The harness path this machine last probed, by binary name. */
  readonly binaryOf: (binaryName: string) => string | undefined;
  /** The workspaces this machine holds: where a session with one runs. */
  readonly workspaces: Workspaces;
  /** The credential socket this machine's git helper asks down. */
  readonly socketPath: string;
}

export interface Resolved {
  readonly ctx: ProviderRunnerContext;
  /** Removed when the session exits; absent for a session that has a workspace. */
  readonly scratch: string | undefined;
}

/**
 * Instance config carries "extra environment for the spawned process" (spec 06
 * section 2.1). No shipped provider declares a `configSchema` field for it yet,
 * so the shape is read leniently rather than refusing to start the session.
 *
 * `HOME` is dropped: relocating it makes the Claude CLI report another
 * account's login, or none, because the macOS Keychain item is keyed by the
 * real home (spec 06 section 9.1); isolation is `CLAUDE_CONFIG_DIR`'s job.
 */
const instanceEnv = (config: unknown): Record<string, string> => {
  const env = (config as { readonly env?: unknown } | null)?.env;
  if (typeof env !== "object" || env === null) return {};
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "HOME",
    ),
  );
};

/**
 * Base env, then the instance's, then Hydra's own: the layering of spec 06
 * section 4, in that order, so instance config can never take `HYDRA_SESSION`
 * or the API URL away from the `hydra` CLI a session calls.
 *
 * The token and `GH_TOKEN` are the frame's alone: an empty one would read to
 * the CLI, and to `gh`, as a credential that failed rather than as one nobody
 * issued. Neither is ever written anywhere but here.
 *
 * What the machine inherited is scrubbed of git's own variables first, the same
 * way the substrate's is: a `GIT_ASKPASS` or a `GIT_CONFIG_*` the person who
 * started the daemon exported for themselves would otherwise answer for the
 * agent, or take the helper below away from it.
 */
const envFor = (machine: Machine, frame: SessionStart): Record<string, string | undefined> => ({
  ...substrateEnv(machine.baseEnv),
  ...instanceEnv(frame.config),
  ...gitCredentialEnv({ socketPath: machine.socketPath, identity: frame.gitIdentity }),
  ...(frame.sessionToken === undefined ? {} : { HYDRA_TOKEN: frame.sessionToken }),
  ...(frame.ghToken === undefined ? {} : { GH_TOKEN: frame.ghToken }),
  HYDRA_API_URL: machine.controllerUrl,
  HYDRA_SESSION: "1",
});

/** Whatever the filesystem refused, said in the words a session's reader sees. */
const tried = <A>(work: () => A): Effect.Effect<A, string> =>
  Effect.try({
    try: work,
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });

/**
 * A workspace-less session gets an empty scratch directory rather than the
 * runner's own cwd, which every harness would read instruction files out of
 * (spec 06 section 9.1). The rest of spec 06 section 4.2 - empty setting
 * sources, auto memory off, strict MCP - is the adapter's to apply.
 */
const place = (
  frame: SessionStart,
  machine: Machine,
): Effect.Effect<{ readonly cwd: string; readonly scratch: string | undefined }, string> =>
  Effect.gen(function* () {
    const { workspaceId } = frame.spec;
    if (workspaceId === null) {
      return yield* tried(() => {
        const scratch = joinPath(machine.scratchDir, frame.sessionId);
        // Emptied rather than merely made: "empty" is the whole property, and a
        // directory left behind by a session of the same id is not that.
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
      // Never forced: a switch git refuses is uncommitted work of the user's,
      // and losing it is worse than not starting the session.
      const switched = yield* Effect.promise(() =>
        switchBranch(workspace.cwd, branch, substrateEnv(machine.baseEnv)),
      );
      if (!switched.ok) return yield* Effect.fail(switched.stderr);
    }
    return { cwd: workspace.cwd, scratch: undefined };
  });

export const resolve = (
  frame: SessionStart,
  machine: Machine,
  binaryName: string,
): Effect.Effect<Resolved, string> =>
  Effect.gen(function* () {
    const placed = yield* place(frame, machine);
    const home = yield* tried(() => {
      const dir = joinPath(machine.providersDir, frame.spec.instanceId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    });
    return {
      scratch: placed.scratch,
      ctx: {
        cwd: placed.cwd,
        home,
        binary: machine.binaryOf(binaryName),
        env: envFor(machine, frame),
      },
    };
  });

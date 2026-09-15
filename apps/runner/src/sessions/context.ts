/**
 * What one session needs on this machine, resolved from the frame that asked
 * for it: ids in, paths out (spec 06 section 4). Only this file knows where an
 * instance or a workspace lives on the runner.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import type { SessionStart } from "@hydra/protocol";
import type { ProviderRunnerContext } from "../providers";

/** The facts about this machine a session is resolved against. */
export interface Machine {
  /** `<runner storage>/providers`: one isolated provider home per instance. */
  readonly providersDir: string;
  /** Where a workspace-less session's empty cwd is made, one directory per session. */
  readonly scratchDir: string;
  /** `<home>/runner/bin`, holding the `hydra` symlink, prepended to a session's `PATH`. */
  readonly binDir: string;
  /** hydra-as-a-tool, as the runner resolved it once at start (spec 06 section 9.3). */
  readonly hydraTool: ProviderRunnerContext["hydraTool"];
  /** What a session reads as `HYDRA_API_URL`. */
  readonly controllerUrl: string;
  /** The runner's own environment, the bottom layer of a session's. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** The harness path this machine last probed, by binary name. */
  readonly binaryOf: (binaryName: string) => string | undefined;
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
 * section 4, in that order, so instance config can never take the session's
 * token, its controller or its `hydra` away from the CLI a session calls.
 *
 * The token is the frame's, never one the runner invented, and it is passed
 * through the environment alone: written down anywhere it would outlive the
 * session it dies with (spec 06 section 9.3).
 *
 * The git credential material of spec 06 section 9.3 is still absent: it
 * arrives with workspaces.
 */
const envFor = (
  machine: Machine,
  config: unknown,
  token: string,
): Record<string, string | undefined> => {
  const base = { ...machine.baseEnv, ...instanceEnv(config) };
  return {
    ...base,
    HYDRA_API_URL: machine.controllerUrl,
    HYDRA_TOKEN: token,
    HYDRA_SESSION: "1",
    // Prepended, so `which hydra` finds this build and the machine's own tools
    // keep working after it (spec 15 section 2). What it is prepended to is the
    // machine's own `PATH`: a `PATH` in instance config is dropped, because a
    // session whose config put another directory first could shadow `hydra`
    // with a binary of its own choosing. An empty entry on `PATH` is the
    // current directory, so a machine that gave the runner none gets the bin
    // directory alone rather than a trailing colon.
    PATH:
      machine.baseEnv["PATH"] === undefined || machine.baseEnv["PATH"] === ""
        ? machine.binDir
        : `${machine.binDir}:${machine.baseEnv["PATH"]}`,
  };
};

/**
 * A workspace-less session gets an empty scratch directory rather than the
 * runner's own cwd, which every harness would read instruction files out of
 * (spec 06 section 9.1). The rest of spec 06 section 4.2 - empty setting
 * sources, auto memory off, strict MCP - is the adapter's to apply.
 */
export const resolve = (
  frame: SessionStart,
  machine: Machine,
  binaryName: string,
): Effect.Effect<Resolved, string> =>
  Effect.try({
    try: () => {
      if (frame.spec.workspaceId !== null) {
        // Workspace provisioning is not built on the runner yet, and guessing a
        // path would run the user's session somewhere nobody chose.
        throw new Error(`this runner cannot provision workspace ${frame.spec.workspaceId} yet`);
      }
      const home = joinPath(machine.providersDir, frame.spec.instanceId);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const scratch = joinPath(machine.scratchDir, frame.sessionId);
      // Emptied rather than merely made: "empty" is the whole property, and a
      // directory left behind by a session of the same id is not that.
      rmSync(scratch, { recursive: true, force: true });
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      return {
        scratch,
        ctx: {
          cwd: scratch,
          home,
          binary: machine.binaryOf(binaryName),
          env: envFor(machine, frame.config, frame.token),
          hydraTool: machine.hydraTool,
        },
      };
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });

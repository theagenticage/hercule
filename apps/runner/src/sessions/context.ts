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
 * section 4, in that order, so instance config can never take `HYDRA_SESSION`
 * or the API URL away from the `hydra` CLI a session calls.
 *
 * `HYDRA_TOKEN`, the `PATH` prepend and the git credential material of spec 06
 * section 9.3 are absent: each arrives with the feature that needs it - session
 * tokens, and workspaces.
 */
const envFor = (machine: Machine, config: unknown): Record<string, string | undefined> => ({
  ...machine.baseEnv,
  ...instanceEnv(config),
  HYDRA_API_URL: machine.controllerUrl,
  HYDRA_SESSION: "1",
});

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
          env: envFor(machine, frame.config),
        },
      };
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });

/** Reads checkout identity without mutating Git or the working files. */
import { realpathSync, statSync } from "node:fs";
import * as Schema from "effect/Schema";
import { canonicalizeRemote, GitRemoteName } from "@hercule/protocol";
import { runGit, type GitEnv } from "./git";
import type { RegisteredWorkspace } from "./registry";

/** Returns the normalized checkout root and common Git directory, or fails with a recovery action. */
export const inspectCheckoutIdentity = async (
  path: string,
  remoteName: string,
  remote: string,
  env: GitEnv,
): Promise<{ root: string; commonDirectory: string; commonDirectoryIdentity: string }> => {
  if (!Schema.is(GitRemoteName)(remoteName))
    throw new Error("The selected remote name is invalid. Choose an existing Git remote.");
  let chosen: string;
  try {
    chosen = realpathSync(path);
  } catch {
    throw new Error(
      "The selected checkout path is unavailable. Restore it and attach the same path again.",
    );
  }
  const root = await runGit(["-C", chosen, "rev-parse", "--show-toplevel"], { env });
  const common = await runGit(
    ["-C", chosen, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { env },
  );
  const configured = await runGit(["-C", chosen, "config", "--get", `remote.${remoteName}.url`], {
    env,
  });
  if (!root.ok || !common.ok)
    throw new Error(
      "The selected path is not an available Git checkout. Restore the repository before attaching it.",
    );
  if (
    !configured.ok ||
    canonicalizeRemote(configured.stdout) !== canonicalizeRemote(remote) ||
    canonicalizeRemote(remote) === undefined
  )
    throw new Error(
      "The selected checkout remote does not match the resource repository. Choose the correct path and remote.",
    );
  const commonDirectory = realpathSync(common.stdout);
  const physical = statSync(commonDirectory);
  return {
    root: realpathSync(root.stdout),
    commonDirectory,
    commonDirectoryIdentity: `${String(physical.dev)}:${String(physical.ino)}`,
  };
};

/** Checks every recorded checkout's current Git binding before admitting work to its files. */
export const hasExpectedCheckoutIdentity = (entry: RegisteredWorkspace, env: GitEnv): boolean => {
  try {
    return entry.checkouts.every((checkout) => {
      const expectedRoot = checkout.canonicalRoot ?? realpathSync(checkout.path);
      if (realpathSync(checkout.path) !== expectedRoot) return false;
      const inspect = (args: ReadonlyArray<string>): string | undefined => {
        const result = Bun.spawnSync(["git", "-C", checkout.path, ...args], {
          env: { ...env },
          stdout: "pipe",
          stderr: "pipe",
        });
        return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
      };
      const root = inspect(["rev-parse", "--show-toplevel"]);
      const common = inspect(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const remote = inspect(["config", "--get", `remote.${checkout.remoteName ?? "origin"}.url`]);
      if (
        root === undefined ||
        common === undefined ||
        remote === undefined ||
        realpathSync(root) !== expectedRoot ||
        canonicalizeRemote(remote) !== canonicalizeRemote(checkout.remote)
      )
        return false;
      const directory = realpathSync(common);
      const physical = statSync(directory);
      return (
        (checkout.commonDirectory === undefined || directory === checkout.commonDirectory) &&
        (checkout.commonDirectoryIdentity === undefined ||
          `${String(physical.dev)}:${String(physical.ino)}` === checkout.commonDirectoryIdentity)
      );
    });
  } catch {
    return false;
  }
};

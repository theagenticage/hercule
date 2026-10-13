/** Reads checkout identity without mutating Git or the working files. */
import { realpathSync, statSync } from "node:fs";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { GitRemoteName } from "@hercule/protocol";
import { runGit, type GitEnv } from "./git";
import { describeRemoteMismatch, isSameRepository } from "./remote-match";
import type { RegisteredCheckout, RegisteredWorkspace } from "./registry";

/** Returns the normalized checkout root and common Git directory, or fails with a recovery action. */
export const inspectCheckoutIdentity = (
  path: string,
  remoteName: string,
  remote: string,
  env: GitEnv,
): Effect.Effect<
  { root: string; commonDirectory: string; commonDirectoryIdentity: string },
  Error
> =>
  Effect.gen(function* () {
    if (!Schema.is(GitRemoteName)(remoteName))
      return yield* Effect.fail(
        new Error("The selected remote name is invalid. Choose an existing Git remote."),
      );
    const chosen = yield* Effect.try({
      try: () => realpathSync(path),
      catch: () =>
        new Error(
          "The selected checkout path is unavailable. Restore it and attach the same path again.",
        ),
    });
    const root = yield* runGit(["-C", chosen, "rev-parse", "--show-toplevel"], { env });
    const common = yield* runGit(
      ["-C", chosen, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { env },
    );
    const configured = yield* runGit(
      ["-C", chosen, "config", "--get", `remote.${remoteName}.url`],
      {
        env,
      },
    );
    if (!root.ok || !common.ok)
      return yield* Effect.fail(
        new Error(
          "The selected path is not an available Git checkout. Restore the repository before attaching it.",
        ),
      );
    if (!configured.ok)
      return yield* Effect.fail(
        new Error(
          `The selected checkout has no remote named "${remoteName}". Choose an existing Git remote.`,
        ),
      );
    if (!(yield* isSameRepository(configured.stdout, remote, env, root.stdout)))
      return yield* Effect.fail(
        new Error(describeRemoteMismatch(remoteName, configured.stdout, remote)),
      );
    return yield* Effect.try({
      try: () => {
        const commonDirectory = realpathSync(common.stdout);
        const physical = statSync(commonDirectory);
        return {
          root: realpathSync(root.stdout),
          commonDirectory,
          commonDirectoryIdentity: `${String(physical.dev)}:${String(physical.ino)}`,
        };
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
  });

/**
 * Reads a checkout's current Git remote URL, provided the checkout is still
 * the one recorded: same root, same Git directory. Returns `undefined` when
 * the checkout is unreadable or was replaced. Does not compare the remote with
 * the resource's repository; the caller does that.
 */
const readRecordedCheckoutRemote = (
  checkout: RegisteredCheckout,
  env: GitEnv,
): string | undefined => {
  try {
    const expectedRoot = checkout.canonicalRoot ?? realpathSync(checkout.path);
    if (realpathSync(checkout.path) !== expectedRoot) return undefined;
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
      realpathSync(root) !== expectedRoot
    )
      return undefined;
    const directory = realpathSync(common);
    const physical = statSync(directory);
    const unchanged =
      (checkout.commonDirectory === undefined || directory === checkout.commonDirectory) &&
      (checkout.commonDirectoryIdentity === undefined ||
        `${String(physical.dev)}:${String(physical.ino)}` === checkout.commonDirectoryIdentity);
    return unchanged ? remote : undefined;
  } catch {
    return undefined;
  }
};

/** Checks every recorded checkout's current Git binding before admitting work to its files. */
export const hasExpectedCheckoutIdentity = (
  entry: RegisteredWorkspace,
  env: GitEnv,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (const checkout of entry.checkouts) {
      const remote = readRecordedCheckoutRemote(checkout, env);
      if (
        remote === undefined ||
        !(yield* isSameRepository(remote, checkout.remote, env, checkout.path))
      )
        return false;
    }
    return true;
  });

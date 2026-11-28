/**
 * Removes the checkouts of a workspace. This is the only part of removal that
 * knows Git: a checkout is a worktree of a repository, and removing it
 * unregisters the worktree there, so the repository keeps no record of a
 * folder that is gone. The workspace's own removal (`dispose.ts`) deletes
 * what is left of its folder afterwards.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { buildCacheDir, removeWorktree, runGit } from "./git";
import { hasExpectedCheckoutIdentity } from "./identity";
import { observeWorkspace } from "./inspection";
import { isInsideDirectory, normalizeError, validateManagedPath } from "./managed-paths";
import { isStillOnDisk, type RegisteredCheckout, type RegisteredWorkspace } from "./registry";
import type { Substrate } from "./substrate";

/** The steps that remove every checkout of one workspace. */
export interface CheckoutRemovals {
  /**
   * One warning for each checkout whose Git repository cannot be found. This
   * is not empty only when changes are discarded: such a checkout is skipped
   * by the steps below, and its folder is deleted with the workspace. A
   * repository that exists and refuses is never skipped.
   */
  readonly warnings: ReadonlyArray<string>;
  /** Runs `work` while holding the coordination of every repository the checkouts belong to. */
  readonly coordinate: <A>(work: Effect.Effect<A, Error>) => Effect.Effect<A, Error>;
  /**
   * Checks that every checkout is still the one the workspace recorded. Unless
   * changes are discarded, it also refuses a checkout that holds tracked,
   * untracked or ignored files. Changes nothing. Run inside `coordinate`.
   */
  readonly preflight: Effect.Effect<void, Error>;
  /**
   * Removes each checkout and unregisters its worktree, calling `onRemoved`
   * with the path of every checkout once it is gone. Fails at the first
   * checkout it cannot remove; the ones already removed stay removed. Run
   * inside `coordinate`.
   */
  readonly removeAll: (onRemoved: (path: string) => void) => Effect.Effect<void, Error>;
}

const checkWorkingFiles = (
  substrate: Substrate,
  checkout: RegisteredCheckout,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (!existsSync(checkout.path)) return;
    const status = yield* runGit(
      [
        "-C",
        checkout.path,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ],
      { env: { ...substrate.gitEnv, GIT_OPTIONAL_LOCKS: "0" } },
    );
    if (!status.ok)
      return yield* Effect.fail(
        new Error(
          `Cannot inspect remaining checkout files. Restore its Git repository before disposal: ${status.stderr}`,
        ),
      );
    if (status.stdout.length > 0)
      return yield* Effect.fail(
        new Error(
          "Tracked changes, untracked files or ignored files remain. Preserve those files or explicitly choose discard changes.",
        ),
      );
  });

/** The recorded repository of a checkout no longer exists on disk. */
class RepositoryMissing extends Error {}

/**
 * Finds the repository a checkout belongs to, with its symbolic links
 * resolved. Fails with `RepositoryMissing` when the repository's path is known
 * and nothing is there any more. Any other failure, such as Git not being able
 * to say where the repository is, means the repository is unknown, not gone.
 */
const findCheckoutRepository = (
  substrate: Substrate,
  checkout: RegisteredCheckout,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    let common = checkout.commonDirectory;
    if (common === undefined && existsSync(checkout.path)) {
      const found = yield* runGit(
        ["-C", checkout.path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { env: substrate.gitEnv },
      );
      if (!found.ok)
        return yield* Effect.fail(
          new Error(
            "The recorded checkout Git repository is unavailable. Restore it before disposal.",
          ),
        );
      common = found.stdout;
    }
    common ??= buildCacheDir(substrate.storageDir, checkout.resourceId);
    const source = common;
    return yield* Effect.try({
      try: () => realpathSync(source),
      catch: (error) =>
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new RepositoryMissing(normalizeError(error).message)
          : normalizeError(error),
    });
  });

/**
 * Finds the Git repository of every checkout and returns the steps that remove
 * the checkouts. Fails when a repository cannot be found, or when it lies
 * inside the workspace being removed, since removing the workspace would
 * destroy it. `canonicalRoot` is the workspace root with its symbolic links
 * resolved.
 */
export const planCheckoutRemovals = (
  substrate: Substrate,
  entry: RegisteredWorkspace,
  canonicalRoot: string,
  discardChanges: boolean,
): Effect.Effect<CheckoutRemovals, Error> =>
  Effect.gen(function* () {
    const sources = new Map<string, string>();
    const warnings: Array<string> = [];
    for (const checkout of entry.checkouts) {
      // When changes are discarded, a repository known to be gone must not keep
      // the workspace from being removed: the checkout is skipped and reported.
      // A repository that cannot be determined still refuses, because it may
      // exist and hold work that exists nowhere else.
      const canonical = yield* findCheckoutRepository(substrate, checkout).pipe(
        Effect.catch((error) =>
          discardChanges && error instanceof RepositoryMissing
            ? Effect.succeed(error)
            : Effect.fail(error),
        ),
      );
      if (canonical instanceof RepositoryMissing) {
        warnings.push(
          `The Git repository of the checkout at ${checkout.path} could not be found, so its worktree was not unregistered there. Its folder was deleted anyway.`,
        );
        continue;
      }
      if (
        canonical ===
          (yield* Effect.try({
            try: () => realpathSync(substrate.storageDir),
            catch: normalizeError,
          })) ||
        canonical === canonicalRoot ||
        isInsideDirectory(canonicalRoot, canonical)
      )
        return yield* Effect.fail(
          new Error(
            "This workspace contains its source Git repository. Preserve the standalone main repository; it cannot be discarded.",
          ),
        );
      sources.set(checkout.checkoutId, canonical);
    }
    const reachable = entry.checkouts.filter((checkout) => sources.has(checkout.checkoutId));
    const keys = [...new Set(sources.values())].sort();
    const coordinate = <A>(work: Effect.Effect<A, Error>): Effect.Effect<A, Error> => {
      const lock = (at: number): Effect.Effect<A, Error> =>
        at === keys.length
          ? work
          : substrate.coordinateRepository(`git:${keys[at]!}`, lock(at + 1));
      return lock(0);
    };
    const preflight = Effect.gen(function* () {
      for (const checkout of reachable) {
        const common = sources.get(checkout.checkoutId)!;
        const physical = yield* Effect.try({ try: () => statSync(common), catch: normalizeError });
        if (
          checkout.commonDirectoryIdentity !== undefined &&
          checkout.commonDirectoryIdentity !== `${String(physical.dev)}:${String(physical.ino)}`
        )
          return yield* Effect.fail(
            new Error(
              "The recorded source Git repository was replaced. Restore the original repository before disposal.",
            ),
          );
        if (
          existsSync(checkout.path) &&
          !(yield* hasExpectedCheckoutIdentity(
            { ...entry, root: checkout.path, checkouts: [checkout] },
            substrate.gitEnv,
          ))
        )
          return yield* Effect.fail(
            new Error(
              "The recorded checkout Git binding changed. Preserve its files and restore the original repository before disposal.",
            ),
          );
        if (!discardChanges) yield* checkWorkingFiles(substrate, checkout);
      }
    });
    const removeCheckout = (
      checkout: RegisteredCheckout,
      onRemoved: (path: string) => void,
    ): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const common = sources.get(checkout.checkoutId)!;
        const listed = yield* runGit(["-C", common, "worktree", "list", "--porcelain", "-z"], {
          env: substrate.gitEnv,
        });
        if (!listed.ok)
          return yield* Effect.fail(
            new Error(`Cannot inspect the recorded worktree registration: ${listed.stderr}`),
          );
        const canonicalCheckoutRoot =
          checkout.canonicalRoot ??
          (yield* Effect.try({
            try: () =>
              resolve(
                realpathSync(substrate.storageDir),
                relative(resolve(substrate.storageDir), resolve(checkout.path)),
              ),
            catch: normalizeError,
          }));
        const registered = listed.stdout.split("\0").includes(`worktree ${canonicalCheckoutRoot}`);
        if (existsSync(checkout.path) || registered) {
          yield* validateManagedPath(substrate, checkout.path);
          if (
            existsSync(checkout.path) &&
            !(yield* hasExpectedCheckoutIdentity(
              { ...entry, root: checkout.path, checkouts: [checkout] },
              substrate.gitEnv,
            ))
          )
            return yield* Effect.fail(
              new Error(
                "The checkout changed after preflight. Preserve the remaining files and restore its original Git binding.",
              ),
            );
          if (!discardChanges) yield* checkWorkingFiles(substrate, checkout);
          const result = yield* removeWorktree(
            common,
            checkout.path,
            substrate.gitEnv,
            discardChanges,
          );
          if (!result.ok)
            return yield* Effect.fail(
              new Error(
                `Git refused to remove the checkout: ${result.stderr}. Preserve its files before retrying disposal.`,
              ),
            );
          onRemoved(checkout.path);
        }
      });
    const removeAll = (onRemoved: (path: string) => void): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        for (const checkout of reachable) yield* removeCheckout(checkout, onRemoved);
      });
    return { warnings, coordinate, preflight, removeAll };
  });

/**
 * Reads the facts of a workspace whose removal failed, for the failure report:
 * its checkouts' branches and whether the recorded checkouts are all still
 * there with their Git binding. `available` is false for a workspace the
 * runner holds no record of.
 */
export const observeCheckoutsAfterFailedRemoval = (
  substrate: Substrate,
  entry: RegisteredWorkspace | undefined,
) =>
  Effect.gen(function* () {
    const observation = entry === undefined ? {} : yield* observeWorkspace(entry, substrate.gitEnv);
    return {
      ...observation,
      available:
        entry !== undefined &&
        isStillOnDisk(entry) &&
        (yield* hasExpectedCheckoutIdentity(entry, substrate.gitEnv)),
    };
  });

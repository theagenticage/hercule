/**
 * The boundary at the root of a workspace with no single checkout: an empty
 * regular file named `.git`. Claude Code looks for `.claude/` folders in its
 * working directory and in every folder above it, and stops only at a folder
 * with a `.git` entry. A root without one lets that search reach the user's
 * home, so the session would load the user's own skills, commands and agents
 * (#369).
 *
 * The entry is an empty file and not a repository on purpose. A file with no
 * bytes can hold no history, so removing it can never lose work, and making
 * it takes one atomic filesystem call, so two sessions starting in the same
 * root at the same time cannot undo each other. No git process runs.
 */
import { lstatSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";

const GIT_ENTRY = ".git";

/**
 * Makes sure `root` has a `.git` entry. Creates an empty `.git` file, unless
 * the root already has a `.git` of any kind, which is never touched. Returns
 * when the root has the boundary. Fails with an error when the file cannot be
 * created, for example when the root is not writable. The message names the
 * error code and never a path.
 *
 * Call it before every session start or resume whose working directory is the
 * workspace root. Running it again is harmless, which also covers roots made
 * before the runner did this. The checkouts under the root are repositories
 * of their own and are not affected.
 */
export const ensureRootBoundary = (root: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        // `wx` fails with EEXIST when anything is at the path, in one atomic step.
        await writeFile(joinPath(root, GIT_ENTRY), "", { flag: "wx" });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
    },
    // The reason names the error code and leaves out Node's message, which
    // quotes the absolute path. The runner shows this text to the user.
    catch: (cause) =>
      new Error(
        `the .git file that marks the workspace folder could not be created (${(cause as NodeJS.ErrnoException).code ?? "unknown error"})`,
      ),
  });

/**
 * Checks whether the `.git` in `root` is the boundary `ensureRootBoundary`
 * makes: a regular file with no bytes. A repository, a checkout and a file
 * with content are not.
 */
export const isRootBoundary = (root: string): boolean => {
  try {
    const entry = lstatSync(joinPath(root, GIT_ENTRY));
    return entry.isFile() && entry.size === 0;
  } catch {
    return false;
  }
};

/**
 * Removes the boundary `ensureRootBoundary` made in `root`, and does nothing
 * when `root` has none. Never removes a `.git` that is a directory or holds
 * any bytes, because that may hold work.
 */
export const removeRootBoundary = (root: string): void => {
  if (isRootBoundary(root)) rmSync(joinPath(root, GIT_ENTRY));
};

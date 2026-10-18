/**
 * The empty Git repository that marks the root of a workspace with no single
 * checkout. Claude Code looks for `.claude/` folders in its working directory
 * and in every folder above it, and stops only at a Git repository root. A
 * root that is not a repository lets that search reach the user's home, so
 * the session would load the user's own skills, commands and agents (#369).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import { runGit, type GitEnv } from "./git";

const GIT_ENTRY = ".git";

const readExcludePath = (root: string): string => joinPath(root, GIT_ENTRY, "info", "exclude");

/**
 * Makes `root` a Git repository that holds and tracks nothing, unless it
 * already has a `.git` entry. Returns when the root is a repository root.
 * Fails with an error that describes what went wrong when git cannot
 * initialize the repository or its exclude file cannot be written. A failed
 * attempt removes what it created, so the next start tries again.
 *
 * The repository has no commit. Its exclude file holds the single pattern
 * `*`, so `git status` at the root shows nothing, and `git add` refuses
 * anything inside it unless forced. The checkouts under the root are
 * repositories of their own and are not affected.
 *
 * Call it before every session start or resume whose working directory is the
 * workspace root. Running it again is harmless, which also covers roots made
 * before the runner did this.
 */
export const ensureRootRepository = (root: string, env: GitEnv): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const gitDir = joinPath(root, GIT_ENTRY);
    if (existsSync(gitDir)) return;
    const removeAttempt = Effect.sync(() => rmSync(gitDir, { recursive: true, force: true }));
    const created = yield* runGit(["-C", root, "init", "--quiet"], { env });
    if (!created.ok) {
      yield* removeAttempt;
      return yield* Effect.fail(new Error(`git init failed: ${created.stderr}`));
    }
    yield* Effect.try({
      try: () => {
        // A custom git template directory can leave out `info/`.
        mkdirSync(joinPath(gitDir, "info"), { recursive: true });
        writeFileSync(readExcludePath(root), "*\n");
      },
      catch: (cause) =>
        new Error(
          `could not write the exclude file of the repository in ${root}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    }).pipe(Effect.tapError(() => removeAttempt));
  });

/**
 * Checks whether the `.git` in `root` is the empty repository that
 * `ensureRootRepository` makes: its exclude file holds the single pattern
 * `*`. A checkout, or a repository a person made, never has that exclude file.
 */
export const hasRootRepository = (root: string): boolean => {
  try {
    return readFileSync(readExcludePath(root), "utf8").trim() === "*";
  } catch {
    return false;
  }
};

/**
 * Removes the empty repository `ensureRootRepository` made in `root`, and
 * does nothing when `root` has none. Never removes a `.git` that holds
 * anything else.
 */
export const removeRootRepository = (root: string): void => {
  if (hasRootRepository(root)) rmSync(joinPath(root, GIT_ENTRY), { recursive: true, force: true });
};

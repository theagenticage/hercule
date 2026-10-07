/**
 * Runs real git as a child process, not through a shell. Each argument is
 * passed separately, so a shell never interprets a remote or a branch name.
 */
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";

export interface GitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  /** Git's error output. A failed workspace reports it to the user as it is. */
  readonly stderr: string;
}

export type GitEnv = Readonly<Record<string, string | undefined>>;

export const runGit = (
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env: GitEnv },
): Effect.Effect<GitOutcome, Error> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn(["git", ...args], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: { ...options.env },
          detached: true,
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
    (child) =>
      Effect.gen(function* () {
        const [stdout, stderr] = yield* Effect.all(
          [
            Effect.tryPromise({
              try: () => new Response(child.stdout).text(),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }),
            Effect.tryPromise({
              try: () => new Response(child.stderr).text(),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }),
          ],
          { concurrency: "unbounded" },
        );
        const code = yield* Effect.promise(() => child.exited);
        return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
      }),
    (child) =>
      Effect.gen(function* () {
        yield* Effect.ignore(
          Effect.try(() => {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              if (child.exitCode === null) child.kill("SIGKILL");
            }
          }),
        );
        yield* Effect.promise(() => child.exited);
      }),
  );

/**
 * Switches a working copy to the branch a session was asked to start on,
 * before the session runs. `ok` is false if git cannot switch, for example
 * because the branch does not exist.
 *
 * The trailing `--` makes sure this only ever switches branches. Without it,
 * git reads a name that is not a branch but is a file as "restore that file
 * from HEAD", which throws away the user's uncommitted edits. With `--`, the
 * same name is an unknown branch, the switch fails, and the session does not
 * start.
 */
export const switchBranch = (
  dir: string,
  branch: string,
  env: GitEnv,
): Effect.Effect<GitOutcome, Error> => runGit(["-C", dir, "checkout", branch, "--"], { env });

/**
 * Returns the branch a working copy is on, or null if there is none: on a
 * detached HEAD, or when git fails. It returns null rather than text such as
 * `unknown`, `HEAD` or git's error, because the result is stored as the
 * checkout's branch, and text stored there would look like a branch name
 * nobody can use.
 */
export const readCurrentBranch = (dir: string, env: GitEnv): Effect.Effect<string | null, Error> =>
  Effect.gen(function* () {
    const shown = yield* runGit(["-C", dir, "branch", "--show-current"], { env });
    if (!shown.ok || shown.stdout.length === 0) return null;
    return shown.stdout;
  });

/** Returns the local branches of a working copy: the branches the user can switch to. */
export const listLocalBranches = (
  dir: string,
  env: GitEnv,
): Effect.Effect<ReadonlyArray<string>, Error> =>
  Effect.gen(function* () {
    const listed = yield* runGit(
      ["-C", dir, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
      { env },
    );
    return listed.stdout.split("\n").filter((line) => line.length > 0);
  });

/** Returns the branch `origin/HEAD` points at, or null if it is not set. */
export const readDefaultBranch = (
  dir: string,
  env: GitEnv,
  remoteName = "origin",
): Effect.Effect<string | null, Error> =>
  Effect.gen(function* () {
    const head = yield* runGit(
      ["-C", dir, "symbolic-ref", "--short", `refs/remotes/${remoteName}/HEAD`],
      {
        env,
      },
    );
    if (!head.ok) return null;
    const target = head.stdout.startsWith(`${remoteName}/`)
      ? head.stdout.slice(remoteName.length + 1)
      : head.stdout;
    return target.length === 0 ? null : target;
  });

export const buildCacheDir = (storageDir: string, resourceId: string): string =>
  joinPath(storageDir, "cache", `${resourceId}.git`);

export const buildCacheRoot = (storageDir: string): string => joinPath(storageDir, "cache");

/** Establishes bare storage once, without fetching when it already exists. */
export const ensureCache = (options: {
  readonly storageDir: string;
  readonly resourceId: string;
  readonly remote: string;
  readonly env: GitEnv;
}): Effect.Effect<{ readonly path: string; readonly failure?: string }, Error> =>
  Effect.gen(function* () {
    const path = buildCacheDir(options.storageDir, options.resourceId);
    const known = yield* runGit(["-C", path, "rev-parse", "--git-dir"], { env: options.env });
    if (!known.ok) {
      const cloned = yield* runGit(["clone", "--bare", "--", options.remote, path], {
        env: options.env,
      });
      if (!cloned.ok) return { path, failure: cloned.stderr };
    }
    return { path };
  });

/** Fetches remote refs and refreshes that remote's default without changing local branches. */
export const fetchRemote = (
  directory: string,
  remoteName: string,
  remote: string,
  env: GitEnv,
): Effect.Effect<string | null, Error> =>
  Effect.gen(function* () {
    const fetched = yield* runGit(
      [
        "-C",
        directory,
        "fetch",
        "--no-tags",
        "--prune",
        "--",
        remote,
        `+refs/heads/*:refs/remotes/${remoteName}/*`,
      ],
      { env },
    );
    if (!fetched.ok)
      return yield* Effect.fail(
        new Error(
          `The remote fetch failed. Check the repository Connection and try a fresh workspace: ${fetched.stderr}`,
        ),
      );
    const head = yield* runGit(["-C", directory, "ls-remote", "--symref", "--", remote, "HEAD"], {
      env,
    });
    if (!head.ok)
      return yield* Effect.fail(new Error(`The remote default could not be read: ${head.stderr}`));
    const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(head.stdout)?.[1];
    if (branch === undefined) return null;
    const updated = yield* runGit(
      [
        "-C",
        directory,
        "symbolic-ref",
        `refs/remotes/${remoteName}/HEAD`,
        `refs/remotes/${remoteName}/${branch}`,
      ],
      { env },
    );
    if (!updated.ok)
      return yield* Effect.fail(
        new Error(`The remote default could not be recorded: ${updated.stderr}`),
      );
    return branch;
  });

/** Resolves one fully qualified ref to its committed revision, without falling back to another ref. */
export const resolveCommit = (
  directory: string,
  ref: string,
  env: GitEnv,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const resolved = yield* runGit(
      ["-C", directory, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { env },
    );
    if (!resolved.ok)
      return yield* Effect.fail(
        new Error(
          `The requested revision ${ref} is unavailable in the selected repository. Choose an existing local or fetched remote branch.`,
        ),
      );
    return resolved.stdout;
  });
/** Removes a worktree through Git, forcing removal only after explicit discard authorization. */
export const removeWorktree = (
  cache: string,
  dir: string,
  env: GitEnv,
  discardChanges = false,
): Effect.Effect<GitOutcome, Error> =>
  runGit(["-C", cache, "worktree", "remove", ...(discardChanges ? ["--force"] : []), "--", dir], {
    env,
  });

/**
 * Makes the cache forget worktrees whose directories are gone. Call it after
 * the directories are deleted, never before: a prune only forgets directories
 * that are already gone.
 */
export const pruneWorktrees = (cache: string, env: GitEnv): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* runGit(["-C", cache, "worktree", "prune"], { env });
  });

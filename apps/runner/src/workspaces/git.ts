/**
 * Runs real git as a child process, not through a shell. Each argument is
 * passed separately, so a shell never interprets a remote or a branch name.
 */
import { join as joinPath } from "node:path";

export interface GitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  /** Git's error output. A failed workspace reports it to the user as it is. */
  readonly stderr: string;
}

export type GitEnv = Readonly<Record<string, string | undefined>>;

export const runGit = async (
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env: GitEnv },
): Promise<GitOutcome> => {
  const child = Bun.spawn(["git", ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
};

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
export const switchBranch = (dir: string, branch: string, env: GitEnv): Promise<GitOutcome> =>
  runGit(["-C", dir, "checkout", branch, "--"], { env });

/**
 * Returns the branch a working copy is on, or null if there is none: on a
 * detached HEAD, or when git fails. It returns null rather than text such as
 * `unknown`, `HEAD` or git's error, because the result is stored as the
 * checkout's branch, and text stored there would look like a branch name
 * nobody can use.
 */
export const readCurrentBranch = async (dir: string, env: GitEnv): Promise<string | null> => {
  const shown = await runGit(["-C", dir, "branch", "--show-current"], { env });
  if (!shown.ok || shown.stdout.length === 0) return null;
  return shown.stdout;
};

/** Returns the local branches of a working copy: the branches the user can switch to. */
export const listLocalBranches = async (
  dir: string,
  env: GitEnv,
): Promise<ReadonlyArray<string>> => {
  const listed = await runGit(
    ["-C", dir, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { env },
  );
  return listed.stdout.split("\n").filter((line) => line.length > 0);
};

/** Returns the branch `origin/HEAD` points at, or null if it is not set. */
export const readDefaultBranch = async (
  dir: string,
  env: GitEnv,
  remoteName = "origin",
): Promise<string | null> => {
  const head = await runGit(
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
};

export const buildCacheDir = (storageDir: string, resourceId: string): string =>
  joinPath(storageDir, "cache", `${resourceId}.git`);

export const buildCacheRoot = (storageDir: string): string => joinPath(storageDir, "cache");

/** Establishes bare storage once, without fetching when it already exists. */
export const ensureCache = async (options: {
  readonly storageDir: string;
  readonly resourceId: string;
  readonly remote: string;
  readonly env: GitEnv;
}): Promise<{ readonly path: string; readonly failure?: string }> => {
  const path = buildCacheDir(options.storageDir, options.resourceId);
  const known = await runGit(["-C", path, "rev-parse", "--git-dir"], { env: options.env });
  if (!known.ok) {
    const cloned = await runGit(["clone", "--bare", "--", options.remote, path], {
      env: options.env,
    });
    if (!cloned.ok) return { path, failure: cloned.stderr };
  }
  return { path };
};

/** Fetches remote refs and refreshes that remote's default without changing local branches. */
export const fetchRemote = async (
  directory: string,
  remoteName: string,
  remote: string,
  env: GitEnv,
): Promise<string | null> => {
  const fetched = await runGit(
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
    throw new Error(
      `The remote fetch failed. Check the repository Connection and try a fresh workspace: ${fetched.stderr}`,
    );
  const head = await runGit(["-C", directory, "ls-remote", "--symref", "--", remote, "HEAD"], {
    env,
  });
  if (!head.ok) throw new Error(`The remote default could not be read: ${head.stderr}`);
  const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(head.stdout)?.[1];
  if (branch === undefined) return null;
  const updated = await runGit(
    [
      "-C",
      directory,
      "symbolic-ref",
      `refs/remotes/${remoteName}/HEAD`,
      `refs/remotes/${remoteName}/${branch}`,
    ],
    { env },
  );
  if (!updated.ok) throw new Error(`The remote default could not be recorded: ${updated.stderr}`);
  return branch;
};

/** Resolves one fully qualified ref to its committed revision, without falling back to another ref. */
export const resolveCommit = async (
  directory: string,
  ref: string,
  env: GitEnv,
): Promise<string> => {
  const resolved = await runGit(
    ["-C", directory, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { env },
  );
  if (!resolved.ok)
    throw new Error(
      `The requested revision ${ref} is unavailable in the selected repository. Choose an existing local or fetched remote branch.`,
    );
  return resolved.stdout;
};
/** Removes a worktree through Git, forcing removal only after explicit discard authorization. */
export const removeWorktree = (
  cache: string,
  dir: string,
  env: GitEnv,
  discardChanges = false,
): Promise<GitOutcome> =>
  runGit(["-C", cache, "worktree", "remove", ...(discardChanges ? ["--force"] : []), "--", dir], {
    env,
  });

/**
 * Makes the cache forget worktrees whose directories are gone. Call it after
 * the directories are deleted, never before: a prune only forgets directories
 * that are already gone.
 */
export const pruneWorktrees = async (cache: string, env: GitEnv): Promise<void> => {
  await runGit(["-C", cache, "worktree", "prune"], { env });
};

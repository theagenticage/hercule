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
export const readDefaultBranch = async (dir: string, env: GitEnv): Promise<string | null> => {
  const head = await runGit(["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    env,
  });
  if (!head.ok) return null;
  const target = head.stdout.replace(/^origin\//, "");
  return target.length === 0 ? null : target;
};

export const buildCacheDir = (storageDir: string, resourceId: string): string =>
  joinPath(storageDir, "cache", `${resourceId}.git`);

export const buildCacheRoot = (storageDir: string): string => joinPath(storageDir, "cache");

/**
 * Makes sure the cache for a resource exists and is up to date, and returns its
 * path. The cache is a bare repository that every working copy of the resource
 * is created from. Returns `failure`, with git's error output, if the clone or
 * the fetch fails.
 *
 * The cache is cloned bare from the remote once and fetched on every later
 * call, so a worktree created from it pushes to the remote, not to this
 * runner. Fetches write to `refs/remotes/origin/*`, never to `refs/heads/*`.
 * The agents' branches live in `refs/heads`, checked out by worktrees, and git
 * refuses to fetch over a branch that is checked out. That would happen as
 * soon as an agent pushed its own branch upstream.
 */
export const ensureCache = async (options: {
  readonly storageDir: string;
  readonly resourceId: string;
  /** Where git clones from, fetches from, and points `origin` at. */
  readonly remote: string;
  readonly env: GitEnv;
}): Promise<{
  readonly path: string;
  readonly failure?: string;
  /** The repository's default branch, returned so callers do not ask git again. */
  readonly defaultBranch?: string;
}> => {
  const path = buildCacheDir(options.storageDir, options.resourceId);
  const { env, remote } = options;
  const known = await runGit(["-C", path, "rev-parse", "--git-dir"], { env });
  if (!known.ok) {
    const cloned = await runGit(["clone", "--bare", "--", remote, path], { env });
    if (!cloned.ok) return { path, failure: cloned.stderr };
  }
  const fetched = await runGit(
    ["-C", path, "fetch", "--no-tags", "--", remote, "+refs/heads/*:refs/remotes/origin/*"],
    { env },
  );
  if (!fetched.ok) return { path, failure: fetched.stderr };
  // Read the default branch from the cache's own HEAD instead of asking the
  // remote: the answer is the same and needs no network. Setting `origin/HEAD`
  // from it lets later code, such as a worktree with no base branch or a
  // report, find the repository's default branch.
  const own = await runGit(["-C", path, "symbolic-ref", "--short", "HEAD"], { env });
  const head = own.stdout;
  if (head.length === 0) return { path };
  await runGit(["-C", path, "remote", "set-head", "origin", head], { env });
  // Return the default branch instead of letting callers read it from the cache
  // again: this is the only place it is worked out, and a second git call could
  // give a different answer.
  return { path, defaultBranch: head };
};

/**
 * Returns the ref a new branch starts from, or undefined if the base branch
 * does not exist. It prefers the remote's copy of the base branch, which the
 * cache fetches. For a repository whose remote was never reachable, it falls
 * back to the base branch in the cache's own `refs/heads`.
 */
export const findStartPoint = async (
  cache: string,
  base: string,
  env: GitEnv,
): Promise<string | undefined> => {
  for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    if ((await runGit(["-C", cache, "rev-parse", "--verify", "--quiet", ref], { env })).ok) {
      return ref;
    }
  }
  return undefined;
};

/** Removes a worktree and its directory. Idempotent: a worktree that is already gone counts as removed. */
export const removeWorktree = async (cache: string, dir: string, env: GitEnv): Promise<void> => {
  await runGit(["-C", cache, "worktree", "remove", "--force", dir], { env });
};

/**
 * Makes the cache forget worktrees whose directories are gone. Call it after
 * the directories are deleted, never before: a prune only forgets directories
 * that are already gone.
 */
export const pruneWorktrees = async (cache: string, env: GitEnv): Promise<void> => {
  await runGit(["-C", cache, "worktree", "prune"], { env });
};

/**
 * Real git, run as a process rather than through a shell: every argument is its
 * own element, so a remote or a branch can never be read as an option or as
 * another command.
 */
import { join as joinPath } from "node:path";

export interface GitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  /** Git's own words, which is what a failed workspace reports to the user. */
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
 * The branch a session was asked to start on, switched to before it runs.
 *
 * The trailing `--` is what makes this a branch switch and nothing else: git
 * reads a word that names no branch but does name a file as "restore that file
 * from HEAD", which would throw away edits the user has not committed. With the
 * terminator the same word is an unknown reference, and the session is refused.
 */
export const switchBranch = (dir: string, branch: string, env: GitEnv): Promise<GitOutcome> =>
  runGit(["-C", dir, "checkout", branch, "--"], { env });

/**
 * The branch a working copy is on now, or null where there is none to read: a
 * detached HEAD prints nothing, and a git that would not answer has nothing to
 * say either. Null rather than prose - `unknown`, `HEAD`, or git's own error -
 * because whatever comes back is written down as the branch the machine found,
 * and a sentence in that column is a branch name nobody can act on.
 */
export const currentBranch = async (dir: string, env: GitEnv): Promise<string | null> => {
  const shown = await runGit(["-C", dir, "branch", "--show-current"], { env });
  if (!shown.ok || shown.stdout.length === 0) return null;
  return shown.stdout;
};

/** Every branch the user can switch to in that working copy. */
export const localBranches = async (dir: string, env: GitEnv): Promise<ReadonlyArray<string>> => {
  const listed = await runGit(
    ["-C", dir, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { env },
  );
  return listed.stdout.split("\n").filter((line) => line.length > 0);
};

/** What `origin/HEAD` points at, or null where nothing set it. */
export const defaultBranch = async (dir: string, env: GitEnv): Promise<string | null> => {
  const head = await runGit(["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    env,
  });
  if (!head.ok) return null;
  const target = head.stdout.replace(/^origin\//, "");
  return target.length === 0 ? null : target;
};

export const cacheDirOf = (storageDir: string, resourceId: string): string =>
  joinPath(storageDir, "cache", `${resourceId}.git`);

export const cacheRootIn = (storageDir: string): string => joinPath(storageDir, "cache");

/**
 * The bare repository every working copy of one resource is made from.
 *
 * Cloned bare from the remote once and refreshed from it afterwards, so a
 * worktree off it pushes to the remote rather than to this machine. Refreshed
 * into
 * `refs/remotes/origin/*` and never into `refs/heads/*`: the branches agents
 * work on live in `refs/heads`, checked out by worktrees, and git refuses to
 * fetch over a branch that is checked out - which is what would happen the
 * moment an agent pushed its own branch upstream.
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
  /** The branch the cache now heads on, for callers that would otherwise re-ask. */
  readonly defaultBranch?: string;
}> => {
  const path = cacheDirOf(options.storageDir, options.resourceId);
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
  // Taken from the cache's own HEAD rather than asked of the remote: the answer
  // is the same and this costs no network.
  // Without it nothing downstream - a worktree asked for no base, a report -
  // can say what the repository's default branch is.
  const own = await runGit(["-C", path, "symbolic-ref", "--short", "HEAD"], { env });
  const head = own.stdout;
  if (head.length === 0) return { path };
  await runGit(["-C", path, "remote", "set-head", "origin", head], { env });
  // Handed back rather than left to be read off the cache again: this is the
  // one derivation of what the repository's default branch is, and a caller
  // that asked git a second time could answer differently from this one.
  return { path, defaultBranch: head };
};

/**
 * What a new branch starts from: the remote's copy of the base branch, which is
 * what the cache refreshes, falling back to the base branch as the cache holds
 * it for a repository whose remote was never reachable.
 */
export const startPointFor = async (
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

/** Takes a worktree's directory away. Idempotent: one already gone is one removed. */
export const removeWorktree = async (cache: string, dir: string, env: GitEnv): Promise<void> => {
  await runGit(["-C", cache, "worktree", "remove", "--force", dir], { env });
};

/**
 * Forgets what the cache still believes about worktrees whose directories are
 * gone. Run after the directories are, never before: a prune that ran first
 * would leave registered whatever was removed after it.
 */
export const pruneWorktrees = async (cache: string, env: GitEnv): Promise<void> => {
  await runGit(["-C", cache, "worktree", "prune"], { env });
};

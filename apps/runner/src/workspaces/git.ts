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
 * The branch a working copy is on now. Empty output is a detached HEAD, which
 * git itself calls `HEAD`; a failure is said in git's own words rather than
 * passed on as an empty branch nobody can act on.
 */
export const currentBranch = async (dir: string, env: GitEnv): Promise<string> => {
  const shown = await runGit(["-C", dir, "branch", "--show-current"], { env });
  if (!shown.ok) return shown.stderr.length === 0 ? "unknown" : shown.stderr;
  return shown.stdout.length === 0 ? "HEAD" : shown.stdout;
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

/**
 * Two spellings of one repository, as far as a machine needs to tell: the
 * controller's canonical form is an identity (`host/owner/repo`) and refuses
 * everything a machine may legitimately hold, a bare path and a `file://` URL
 * among them. All this answers is whether the folder the user pointed at is a
 * checkout of the remote they named.
 */
const normalized = (remote: string): string =>
  remote
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .replace(/:/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

export const sameRemote = (one: string, other: string): boolean =>
  normalized(one) === normalized(other);

export const cacheDirOf = (storageDir: string, resourceId: string): string =>
  joinPath(storageDir, "cache", `${resourceId}.git`);

export const cacheRootIn = (storageDir: string): string => joinPath(storageDir, "cache");

/**
 * The bare repository every working copy of one resource is made from.
 *
 * Made once from wherever the first copy came from - the remote, or the folder
 * the user adopted - and pointed at the real remote afterwards, so a worktree
 * off it pushes to the remote rather than to this machine. Refreshed into
 * `refs/remotes/origin/*` and never into `refs/heads/*`: the branches agents
 * work on live in `refs/heads`, checked out by worktrees, and git refuses to
 * fetch over a branch that is checked out - which is what would happen the
 * moment an agent pushed its own branch upstream.
 */
export const ensureCache = async (options: {
  readonly storageDir: string;
  readonly resourceId: string;
  /** Where git fetches from: the remote, or an adopted folder. */
  readonly source: string;
  /** What `origin` points at afterwards, wherever the objects came from. */
  readonly remote: string;
  /** The repository's default branch where the caller already knows it. */
  readonly defaultBranch?: string | null;
  readonly env: GitEnv;
}): Promise<{ readonly path: string; readonly failure?: string }> => {
  const path = cacheDirOf(options.storageDir, options.resourceId);
  const { env, source, remote } = options;
  const known = await runGit(["-C", path, "rev-parse", "--git-dir"], { env });
  if (!known.ok) {
    const cloned = await runGit(["clone", "--bare", "--", source, path], { env });
    if (!cloned.ok) return { path, failure: cloned.stderr };
    const pointed = await runGit(["-C", path, "remote", "set-url", "origin", remote], { env });
    if (!pointed.ok) return { path, failure: pointed.stderr };
  }
  const fetched = await runGit(
    ["-C", path, "fetch", "--no-tags", "--", source, "+refs/heads/*:refs/remotes/origin/*"],
    { env },
  );
  if (!fetched.ok) return { path, failure: fetched.stderr };
  // Taken from what the caller knows, or from the cache's own HEAD, rather than
  // asked of the remote: the answer is the same and this costs no network.
  // Without it nothing downstream - a worktree asked for no base, a report -
  // can say what the repository's default branch is, and a cache seeded from an
  // adopted folder would answer with whatever branch that folder sat on.
  const own = await runGit(["-C", path, "symbolic-ref", "--short", "HEAD"], { env });
  const head = options.defaultBranch ?? own.stdout;
  if (head.length === 0) return { path };
  if (head !== own.stdout) {
    await runGit(["-C", path, "symbolic-ref", "HEAD", `refs/heads/${head}`], { env });
  }
  await runGit(["-C", path, "remote", "set-head", "origin", head], { env });
  return { path };
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
